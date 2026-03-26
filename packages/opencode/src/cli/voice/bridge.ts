/**
 * Voice Bridge — Kyutai MLX Streaming STT
 *
 * Uses coreaudio-node for native macOS audio capture, piping PCM to
 * the Kyutai streaming_stt_server.py process. Reads JSON-line
 * transcription tokens from the server's stdout.
 *
 * Architecture:
 *   MicrophoneRecorder (CoreAudio → PCM int16 24kHz mono → float32 conversion)
 *     ──► streaming_stt_server.py stdin (expects float32 LE)
 *     ──► MLX inference (token-by-token)
 *     ──► JSON lines on stdout → this bridge
 *         {"type":"token","text":" hello"}
 *         {"type":"vad","event":"end_of_turn"}
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { MicrophoneRecorder } from "./coreaudio"
import { vlog } from "./vlog"

export interface VoiceBridgeConfig {
  /** Path to streaming_stt_server.py */
  sttServerPath: string
  /** Python executable (default: python3) */
  python?: string
  /** HuggingFace model id */
  model?: string
  /** Enable neural VAD heads (default: true) */
  vad?: boolean
  /** Max generation steps */
  maxSteps?: number
  /** Force language for Qwen ASR (e.g. "en", "zh") */
  language?: string
}

/** Emitted by the bridge; maps to mic + STT lifecycle only. */
export type VoiceState = "idle" | "starting" | "listening"

/** Time from last streaming token to committed transcript (proxy for “how fast” STT commits after you stop talking). */
export type TranscriptFinalMeta = {
  finalizeMs: number
  reason: "vad" | "silence"
}

export interface VoiceBridgeEvents {
  connect: () => void
  disconnect: () => void
  error: (error: Error) => void
  stateChange: (state: VoiceState) => void
  audioLevel: (level: number, isSpeech: boolean) => void
  transcript: (text: string, isFinal: boolean) => void
  transcriptFinal: (text: string, sessionID: string | null, meta: TranscriptFinalMeta) => void
}

type SttJson =
  | { type: "token"; text: string }
  | { type: "vad"; event: string }
  | { status: "ready" | "streaming" }
  | { error: string }

function parseSttJson(line: string): SttJson | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (o.type === "token" && typeof o.text === "string") return { type: "token", text: o.text }
  if (o.type === "vad" && typeof o.event === "string") return { type: "vad", event: o.event }
  if (o.status === "ready" || o.status === "streaming") return { status: o.status }
  if (typeof o.error === "string") return { error: o.error }
  return null
}

export class VoiceBridge extends EventEmitter {
  private config: Required<VoiceBridgeConfig>
  private python: ChildProcess | null = null
  private recorder: MicrophoneRecorder | null = null
  private state: VoiceState = "idle"
  private sessionID: string | null = null
  private isEnabled = false
  private buffer = ""
  private transcript = ""
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private silenceMs = 1500
  /** Qwen chunk interval in seconds — must match --chunk-size sent to the server */
  private qwenChunkSec = 1.0
  private qwen = false
  private ready = false
  /** Wall time of last STT token for finalize latency measurement */
  private lastTokenAt = 0
  /** Unix socket path for out-of-band commands to the Python server */
  private cmdSocket = ""

  constructor(config: VoiceBridgeConfig) {
    super()
    const model = config.model ?? process.env.OPENCODE_STT_MODEL
    this.qwen =
      config.sttServerPath.toLowerCase().includes("qwen") || (model ? model.toLowerCase().includes("qwen") : false)
    const vad = config.vad ?? true
    // 1B candle model includes neural VAD heads for end_of_turn detection.
    const defaultModel = this.qwen
      ? "Qwen/Qwen3-ASR-0.6B"
      : vad
        ? "kyutai/stt-1b-en_fr-candle"
        : "kyutai/stt-1b-en_fr-mlx"
    this.config = {
      sttServerPath: config.sttServerPath,
      python: config.python ?? "python3",
      model: model ?? defaultModel,
      vad: this.qwen ? false : vad,
      maxSteps: config.maxSteps ?? 4096,
      language: config.language ?? process.env.OPENCODE_STT_LANGUAGE ?? "en",
    }
    if (this.qwen) {
      // Qwen emits tokens in bursts after each chunk is processed. The silence
      // timer must be longer than the chunk interval so it doesn't fire in the
      // gap between chunks and prematurely split utterances.
      this.silenceMs = this.qwenChunkSec * 1000 + 1500
    }
    vlog(
      "Bridge",
      `constructor, server=${this.config.sttServerPath}, model=${this.config.model}, vad=${this.config.vad}, language=${this.config.language}, silenceMs=${this.silenceMs}`,
    )
  }

  // ── lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    vlog("Bridge", "start() — spawning STT server + mic")
    this.setState("starting")
    if (this.config.vad && this.config.model.includes("en_fr-mlx") && !this.config.model.includes("candle")) {
      vlog(
        "Bridge",
        "VAD is enabled but the -mlx HF repo has no VAD weights; use kyutai/stt-1b-en_fr-candle or OPENCODE_STT_MODEL. Neural end_of_turn will not fire.",
      )
    }

    const args = [this.config.sttServerPath, "--model", this.config.model]
    if (this.config.vad) args.push("--vad")
    if (!this.qwen) {
      args.push("--max-steps", String(this.config.maxSteps))
      args.push("--silence-reset-ms", String(this.silenceMs + 200))
      this.cmdSocket = path.join(os.tmpdir(), `opencode-stt-${process.pid}.sock`)
      args.push("--cmd-socket", this.cmdSocket)
    }
    if (this.qwen) {
      if (this.config.language) args.push("--language", this.config.language)
      args.push("--chunk-size", String(this.qwenChunkSec))
    }

    // Spawn Python STT server (reads PCM from stdin, writes JSON lines to stdout)
    this.python = spawn(this.config.python, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.python.on("error", (err) => {
      vlog("Bridge", `Python process error: ${err.message}`)
      this.emit("error", err)
    })

    this.python.on("exit", (code) => {
      vlog("Bridge", `Python process exited with code ${code}`)
      this.python = null
      if (this.isEnabled) {
        this.emit("disconnect")
        this.setState("idle")
      }
    })

    this.python.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) vlog("Bridge", `[python stderr] ${msg}`)
    })

    // Read JSON lines from python stdout
    this.python.stdout?.on("data", (data: Buffer) => {
      this.handleData(data)
    })

    // Wait for the server to signal "ready" or "streaming"
    await this.waitForReady()

    // Start mic capture
    await this.startMic()

    this.emit("connect")
    this.isEnabled = true
    this.setState("listening")
    vlog("Bridge", "Started — listening")
  }

  stop(): void {
    vlog("Bridge", "stop() called")
    this.isEnabled = false
    this.clearSilenceTimer()
    if (this.recorder) {
      this.recorder.stop().catch(() => {})
      this.recorder = null
    }
    if (this.python) {
      this.python.kill()
      this.python = null
    }
    if (this.cmdSocket) {
      try {
        require("node:fs").unlinkSync(this.cmdSocket)
      } catch {}
      this.cmdSocket = ""
    }
    this.setState("idle")
    this.emit("disconnect")
  }

  toggle(enabled: boolean): void {
    vlog("Bridge", `toggle(${enabled})`)
    this.isEnabled = enabled
    if (!enabled) this.stop()
  }

  setSessionID(id: string | null): void {
    this.sessionID = id
  }

  getState(): VoiceState {
    return this.state
  }

  /** Send a reset command to the Python server via the Unix command socket. */
  private sendReset(): void {
    if (!this.cmdSocket) return
    const sock = net.createConnection({ path: this.cmdSocket })
    sock.once("connect", () => {
      sock.write("reset\n")
      sock.end()
    })
    sock.once("error", (err) => {
      vlog("Bridge", `cmd socket error: ${err.message}`)
    })
  }

  // ── mic ─────────────────────────────────────────────────

  private startMic(): Promise<void> {
    return new Promise((resolve, reject) => {
      vlog("Bridge", "Starting mic capture (24kHz mono float32)")

      this.recorder = new MicrophoneRecorder({
        sampleRate: this.qwen ? 16000 : 24000,
        chunkDurationMs: 80,
        stereo: false,
      })

      this.recorder.on("error", (err: Error) => {
        vlog("Bridge", `Mic error: ${err.message}`)
        this.emit("error", err)
      })

      this.recorder.on("data", (chunk: { data: Buffer }) => {
        if (this.python?.stdin?.writable) {
          // CoreAudio native addon produces int16 PCM; STT server expects float32
          const samples = chunk.data.length / 2
          const f32 = Buffer.alloc(samples * 4)
          for (let i = 0; i < samples; i++) {
            f32.writeFloatLE(chunk.data.readInt16LE(i * 2) / 32768, i * 4)
          }
          this.python.stdin.write(f32)
        }
      })

      this.recorder.on("start", () => {
        vlog("Bridge", "Mic started")
        resolve()
      })

      this.recorder.on("stop", () => {
        vlog("Bridge", "Mic stopped")
      })

      this.recorder.start().catch((err: Error) => {
        vlog("Bridge", `Mic start error: ${err.message}`)
        reject(err)
      })
    })
  }

  // ── server readiness ───────────────────────────────────────

  private waitForReady(): Promise<void> {
    const ms = (() => {
      const n = Number(process.env.OPENCODE_STT_READY_TIMEOUT_MS)
      return Number.isFinite(n) && n > 0 ? n : 120_000
    })()
    return new Promise((resolve, reject) => {
      if (this.ready) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        this.off("connect", onReady)
        reject(new Error(`Timeout waiting for STT server to be ready (${ms}ms)`))
      }, ms)

      const onReady = () => {
        clearTimeout(timeout)
        this.off("connect", onReady)
        resolve()
      }
      this.on("connect", onReady)
    })
  }

  // ── JSON line parsing ──────────────────────────────────────

  private handleData(data: Buffer): void {
    this.buffer += data.toString("utf-8")
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue
      const msg = parseSttJson(line)
      if (msg) this.handleMessage(msg)
    }
  }

  private handleMessage(msg: SttJson): void {
    if ("type" in msg) {
      if (msg.type === "token") {
        this.lastTokenAt = Date.now()
        this.transcript += msg.text
        this.emit("transcript", msg.text, false)
        this.resetSilenceTimer()
        return
      }
      if (msg.type === "vad") {
        if (msg.event === "end_of_turn") {
          vlog("Bridge", `VAD end_of_turn, transcript: "${this.transcript.trim()}"`)
          this.clearSilenceTimer()
          this.submitTranscript("vad")
        }
        return
      }
    }
    if ("status" in msg) {
      vlog("Bridge", `Server status: ${msg.status}`)
      if (msg.status === "ready" || msg.status === "streaming") {
        this.ready = true
        this.emit("connect")
      }
      return
    }
    if ("error" in msg) {
      vlog("Bridge", `Server error: ${msg.error}`)
      this.emit("error", new Error(msg.error))
    }
  }

  // ── silence timer ───────────────────────────────────────────

  private resetSilenceTimer(): void {
    this.clearSilenceTimer()
    this.silenceTimer = setTimeout(() => {
      if (this.transcript.trim()) {
        vlog("Bridge", `Silence timeout (${this.silenceMs}ms) — submitting`)
        this.submitTranscript("silence")
      } else {
        // No text but still reset the server to prevent KV cache overflow during long silence
        this.sendReset()
      }
    }, this.silenceMs)
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  // ── transcript handling ────────────────────────────────────

  private submitTranscript(reason: "vad" | "silence"): void {
    const text = this.transcript.trim()
    this.transcript = ""

    if (!text) {
      vlog("Bridge", "Empty transcript — ignoring")
      return
    }

    const finalizeMs = this.lastTokenAt > 0 ? Date.now() - this.lastTokenAt : 0
    const meta: TranscriptFinalMeta = { finalizeMs, reason }
    vlog(
      "Bridge",
      `transcriptFinal finalizeMs=${finalizeMs}ms reason=${reason} text="${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`,
    )
    if (process.env.OPENCODE_VOICE_METRICS === "1") {
      console.error(
        JSON.stringify({
          event: "opencode.voice.transcript_final",
          finalizeMs,
          reason,
          textLen: text.length,
        }),
      )
    }

    this.emit("transcript", text, true)
    this.emit("transcriptFinal", text, this.sessionID, meta)
    this.sendReset()
    this.setState("listening")
  }

  // ── state ──────────────────────────────────────────────────

  private setState(state: VoiceState): void {
    if (this.state !== state) {
      this.state = state
      this.emit("stateChange", state)
    }
  }
}
