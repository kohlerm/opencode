/**
 * Voice Bridge — Kyutai MLX Streaming STT
 *
 * Uses the `mic` package for JavaScript audio capture, piping PCM to
 * the Kyutai streaming_stt_server.py process. Reads JSON-line
 * transcription tokens from the server's stdout.
 *
 * Architecture:
 *   mic (CoreAudio mic → PCM f32le 24kHz mono)
 *     ──► streaming_stt_server.py stdin
 *     ──► MLX inference (token-by-token)
 *     ──► JSON lines on stdout → this bridge
 *         {"type":"token","text":" hello"}
 *         {"type":"vad","event":"end_of_turn"}
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import mic from "mic"
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
}

export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "interrupted"

export interface VoiceBridgeEvents {
  connect: () => void
  disconnect: () => void
  error: (error: Error) => void
  stateChange: (state: VoiceState) => void
  audioLevel: (level: number, isSpeech: boolean) => void
  transcript: (text: string, isFinal: boolean) => void
  transcriptFinal: (text: string, sessionID: string | null) => void
  bargeIn: () => void
  abortSession: (sessionID: string | null) => void
}

export class VoiceBridge extends EventEmitter {
  private config: Required<VoiceBridgeConfig>
  private python: ChildProcess | null = null
  private micInstance: any = null
  private micStream: any = null
  private state: VoiceState = "idle"
  private sessionID: string | null = null
  private isEnabled = false
  private buffer = ""
  private transcript = ""
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private silenceMs = 1500

  constructor(config: VoiceBridgeConfig) {
    super()
    this.config = {
      sttServerPath: config.sttServerPath,
      python: config.python ?? "python3",
      model: config.model ?? "kyutai/stt-1b-en_fr-mlx",
      vad: config.vad ?? true,
      maxSteps: config.maxSteps ?? 4096,
    }
    vlog("Bridge", `constructor, server=${this.config.sttServerPath}`)
  }

  // ── lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    vlog("Bridge", "start() — spawning STT server + mic")

    const args = [this.config.sttServerPath, "--model", this.config.model]
    if (this.config.vad) args.push("--vad")
    args.push("--max-steps", String(this.config.maxSteps))

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
    if (this.micInstance) {
      this.micInstance.stop()
      this.micInstance = null
      this.micStream = null
    }
    if (this.python) {
      this.python.kill()
      this.python = null
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

  // ── mic ─────────────────────────────────────────────────

  private startMic(): Promise<void> {
    return new Promise((resolve, reject) => {
      vlog("Bridge", "Starting mic capture (24kHz mono float32)")

      this.micInstance = mic({
        rate: "24000",
        channels: "1",
        bitwidth: "32",
        exitOnSilence: 0,
        debug: false,
      })

      this.micStream = this.micInstance.getAudioStream()

      this.micStream.on("error", (err: Error) => {
        vlog("Bridge", `Mic error: ${err.message}`)
        this.emit("error", err)
      })

      // Pipe mic audio directly to Python stdin
      this.micStream.pipe(this.python!.stdin!)

      this.micInstance.on("start", () => {
        vlog("Bridge", "Mic started")
        resolve()
      })

      this.micInstance.on("stop", () => {
        vlog("Bridge", "Mic stopped")
      })

      this.micInstance.on("error", (err: Error) => {
        vlog("Bridge", `Mic instance error: ${err.message}`)
        reject(err)
      })

      this.micInstance.start()
    })
  }

  // ── server readiness ───────────────────────────────────────

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for STT server to be ready"))
      }, 30000)

      const handler = (data: Buffer) => {
        const text = data.toString()
        if (text.includes('"status"') && (text.includes('"ready"') || text.includes('"streaming"'))) {
          clearTimeout(timeout)
          this.python?.stdout?.removeListener("data", handler)
          resolve()
        }
      }

      this.python?.stdout?.on("data", handler)
    })
  }

  // ── JSON line parsing ──────────────────────────────────────

  private handleData(data: Buffer): void {
    this.buffer += data.toString("utf-8")
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        this.handleMessage(msg)
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === "token") {
      this.transcript += msg.text
      this.emit("transcript", msg.text, false)
      this.resetSilenceTimer()
    } else if (msg.type === "vad" && msg.event === "end_of_turn") {
      vlog("Bridge", `VAD end_of_turn, transcript: "${this.transcript.trim()}"`)
      this.clearSilenceTimer()
      this.submitTranscript()
    } else if (msg.status === "ready" || msg.status === "streaming") {
      vlog("Bridge", `Server status: ${msg.status}`)
    } else if (msg.error) {
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
        this.submitTranscript()
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

  private submitTranscript(): void {
    const text = this.transcript.trim()
    this.transcript = ""

    if (!text) {
      vlog("Bridge", "Empty transcript — ignoring")
      return
    }

    this.emit("transcript", text, true)
    this.emit("transcriptFinal", text, this.sessionID)
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
