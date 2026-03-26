import { EventEmitter } from "node:events"
import net from "node:net"
import { MicrophoneRecorder } from "./coreaudio"
import { vlog } from "./vlog"
import type { TranscriptFinalMeta, VoiceBridgeEvents, VoiceState } from "./bridge"

export interface VoiceWyomingConfig {
  uri: string
  language?: string
  silenceMs?: number
  timeoutMs?: number
}

class Segment {
  private speechLeft = 0
  private cmdLeft = 0
  private silenceLeft = 0
  private timeoutLeft = 0
  private resetLeft = 0
  active = false

  constructor(
    private cfg: {
      speech: number
      cmd: number
      silence: number
      timeout: number
      reset: number
      pre: number
      inCmd: number
    },
  ) {
    this.reset()
  }

  reset() {
    this.speechLeft = this.cfg.speech
    this.cmdLeft = this.cfg.cmd - this.cfg.speech
    this.silenceLeft = this.cfg.silence
    this.timeoutLeft = this.cfg.timeout
    this.resetLeft = this.cfg.reset
    this.active = false
  }

  process(sec: number, prob: number) {
    const out = { start: false, stop: false, timeout: false }
    this.timeoutLeft -= sec
    if (this.timeoutLeft <= 0) {
      out.stop = true
      out.timeout = true
      this.reset()
      return out
    }

    if (!this.active) {
      if (prob > this.cfg.pre) {
        this.resetLeft = this.cfg.reset
        this.speechLeft -= sec
        if (this.speechLeft <= 0) {
          this.active = true
          this.cmdLeft = this.cfg.cmd - this.cfg.speech
          this.silenceLeft = this.cfg.silence
          out.start = true
        }
        return out
      }

      this.resetLeft -= sec
      if (this.resetLeft <= 0) {
        this.speechLeft = this.cfg.speech
        this.resetLeft = this.cfg.reset
      }
      return out
    }

    if (prob > this.cfg.inCmd) {
      this.resetLeft -= sec
      this.cmdLeft -= sec
      if (this.resetLeft <= 0) {
        this.silenceLeft = this.cfg.silence
        this.resetLeft = this.cfg.reset
      }
      return out
    }

    this.resetLeft = this.cfg.reset
    this.silenceLeft -= sec
    this.cmdLeft -= sec
    if (this.silenceLeft <= 0 && this.cmdLeft <= 0) {
      out.stop = true
      this.reset()
    }
    return out
  }
}

function uri(input: string) {
  const u = new URL(input)
  if (u.protocol !== "tcp:") throw new Error(`Unsupported Wyoming URI: ${input}`)
  const port = Number(u.port)
  if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid Wyoming port: ${input}`)
  return { host: u.hostname, port }
}

function rms(buf: Buffer) {
  const n = Math.floor(buf.length / 2)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / n)
}

export class VoiceWyomingBridge extends EventEmitter {
  private cfg: Required<VoiceWyomingConfig>
  private state: VoiceState = "idle"
  private recorder: MicrophoneRecorder | null = null
  private sock: net.Socket | null = null
  private conn: Promise<void> | null = null
  private sessionID: string | null = null
  private enabled = false
  private transcript = ""
  private lastTokenAt = 0
  private pending = Buffer.alloc(0)
  private payload = 0
  private dataLen = 0
  private current: { type: string; data: Record<string, unknown> } | null = null
  private turn = false
  private reason: "silence" | "vad" = "silence"
  private seg: Segment

  constructor(cfg: VoiceWyomingConfig) {
    super()
    this.cfg = {
      uri: cfg.uri,
      language: cfg.language ?? "en",
      silenceMs: cfg.silenceMs ?? 1250,
      timeoutMs: cfg.timeoutMs ?? 15000,
    }
    this.seg = new Segment({
      speech: 0.18,
      cmd: 0.9,
      silence: this.cfg.silenceMs / 1000,
      timeout: this.cfg.timeoutMs / 1000,
      reset: 1.0,
      pre: 0.1,
      inCmd: 0.3,
    })
    vlog("Wyoming", `constructor uri=${this.cfg.uri} lang=${this.cfg.language}`)
  }

  async start(): Promise<void> {
    this.enabled = true
    this.setState("starting")
    await this.ensure()
    await this.startMic()
    this.emit("connect")
    this.setState("listening")
  }

  stop(): void {
    this.enabled = false
    this.seg.reset()
    this.turn = false
    if (this.recorder) {
      this.recorder.stop().catch(() => {})
      this.recorder = null
    }
    if (this.sock) {
      this.sock.destroy()
      this.sock = null
    }
    this.setState("idle")
    this.emit("disconnect")
  }

  toggle(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.stop()
  }

  setSessionID(id: string | null): void {
    this.sessionID = id
  }

  getState(): VoiceState {
    return this.state
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return
    this.state = state
    this.emit("stateChange", state)
  }

  private async connect(): Promise<void> {
    const loc = uri(this.cfg.uri)
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: loc.host, port: loc.port })
      this.sock = sock
      this.pending = Buffer.alloc(0)
      this.payload = 0
      this.dataLen = 0
      this.current = null
      let done = false
      sock.once("connect", () => {
        done = true
        vlog("Wyoming", `connected ${loc.host}:${loc.port}`)
        this.turn = false
        resolve()
      })
      sock.on("data", (buf) => {
        if (this.sock !== sock) return
        this.parse(buf)
      })
      sock.once("error", (err) => {
        if (!done) reject(err)
        if (this.sock !== sock) return
        this.emit("error", err)
      })
      sock.once("close", () => {
        if (this.sock !== sock) return
        this.sock = null
        vlog("Wyoming", "socket closed")
        if (!done) {
          reject(new Error("Wyoming socket closed before connect"))
          return
        }
        if (!this.enabled) return
        this.turn = false
        this.emit("disconnect")
      })
    })
  }

  private ensure(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve()
    if (this.conn) return this.conn
    this.conn = this.connect().finally(() => {
      this.conn = null
    })
    return this.conn
  }

  private beginTurn(): void {
    this.turn = true
    this.reason = "silence"
    this.transcript = ""
    this.lastTokenAt = 0
    vlog("Wyoming", "voice command started")
    this.send({ type: "transcribe", data: { language: this.cfg.language } })
    this.send({ type: "audio-start", data: { rate: 16000, width: 2, channels: 1 } })
  }

  private send(evt: { type: string; data?: Record<string, unknown> }, payload?: Buffer): void {
    if (!this.sock || !this.sock.writable) return
    const raw: Record<string, unknown> = { type: evt.type, data: evt.data ?? {} }
    if (payload && payload.length) raw.payload_length = payload.length
    this.sock.write(`${JSON.stringify(raw)}\n`)
    if (payload && payload.length) this.sock.write(payload)
  }

  private parse(buf: Buffer): void {
    this.pending = Buffer.concat([this.pending, buf])
    for (;;) {
      if (this.dataLen > 0) {
        if (this.pending.length < this.dataLen || !this.current) return
        const raw = this.pending.subarray(0, this.dataLen).toString("utf8")
        this.pending = this.pending.subarray(this.dataLen)
        this.dataLen = 0
        try {
          const data = JSON.parse(raw)
          if (data && typeof data === "object") {
            this.current.data = { ...this.current.data, ...(data as Record<string, unknown>) }
          }
        } catch {}
        if (this.payload === 0) {
          const evt = this.current
          this.current = null
          this.handle(evt.type, evt.data)
        }
        continue
      }
      if (this.payload > 0) {
        if (this.pending.length < this.payload || !this.current) return
        this.pending = this.pending.subarray(this.payload)
        this.payload = 0
        const evt = this.current
        this.current = null
        this.handle(evt.type, evt.data)
        continue
      }
      const idx = this.pending.indexOf(0x0a)
      if (idx < 0) return
      const line = this.pending.subarray(0, idx).toString("utf8").trim()
      this.pending = this.pending.subarray(idx + 1)
      if (!line) continue
      let evt: unknown
      try {
        evt = JSON.parse(line)
      } catch {
        continue
      }
      if (!evt || typeof evt !== "object") continue
      const o = evt as Record<string, unknown>
      if (typeof o.type !== "string") continue
      const data = typeof o.data === "object" && o.data ? (o.data as Record<string, unknown>) : {}
      const dataLen = typeof o.data_length === "number" ? o.data_length : 0
      const payload = typeof o.payload_length === "number" ? o.payload_length : 0
      if (dataLen > 0 || payload > 0) {
        this.current = { type: o.type, data }
        this.dataLen = dataLen
        this.payload = payload
        continue
      }
      this.handle(o.type, data)
    }
  }

  private handle(type: string, data: Record<string, unknown>): void {
    vlog("Wyoming", `event: ${type}`)
    if (type === "transcript-chunk") {
      const text = typeof data.text === "string" ? data.text : ""
      if (!text) return
      this.lastTokenAt = Date.now()
      this.transcript += text
      this.emit("transcript", text, false)
      return
    }
    if (type === "transcript") {
      const text = (typeof data.text === "string" ? data.text : this.transcript).trim()
      vlog("Wyoming", `final transcript: "${text}"`)
      this.transcript = ""
      this.emit("transcript", text, true)
      const finalizeMs = this.lastTokenAt > 0 ? Date.now() - this.lastTokenAt : 0
      const meta: TranscriptFinalMeta = { finalizeMs, reason: this.reason }
      this.emit("transcriptFinal", text, this.sessionID, meta)
      this.turn = false
      this.seg.reset()
      // Server stops reading after transcript (handler returns False),
      // so we must close and reconnect for the next turn.
      if (this.sock) {
        this.sock.destroy()
        this.sock = null
      }
      if (!this.enabled) return
      this.ensure().catch((err) => this.emit("error", err))
    }
  }

  private startMic(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.recorder = new MicrophoneRecorder({
        sampleRate: 16000,
        chunkDurationMs: 80,
        stereo: false,
      })
      this.recorder.on("error", (err: Error) => this.emit("error", err))
      this.recorder.on("start", () => resolve())
      this.recorder.on("data", (chunk: { data: Buffer }) => {
        const level = rms(chunk.data)
        const speech = level > (this.turn ? 0.0045 : 0.0075)
        const prob = speech ? 1 : 0
        const sec = chunk.data.length / (16000 * 2)
        const step = this.seg.process(sec, prob)
        this.emit("audioLevel", Math.min(1, level * 6), speech)

        if (step.start && !this.turn) {
          if (!this.sock || this.sock.destroyed) {
            this.ensure()
              .then(() => this.beginTurn())
              .catch((err) => this.emit("error", err))
            return
          }
          this.beginTurn()
        }

        if (!this.turn) return

        this.send({ type: "audio-chunk", data: { rate: 16000, width: 2, channels: 1 } }, chunk.data)

        if (!step.stop) return
        this.reason = step.timeout ? "vad" : "silence"
        this.turn = false
        vlog("Wyoming", `audio-stop reason=${this.reason}`)
        this.send({ type: "audio-stop", data: {} })
      })
      this.recorder.start().catch((err: Error) => reject(err))
    })
  }
}

export type VoiceWyomingEvents = VoiceBridgeEvents
