/**
 * CoreAudio native addon loader
 *
 * Loads the coreaudio.node native addon directly, bypassing the
 * bundled coreaudio-node JS which fails inside compiled Bun binaries
 * because __dirname resolves to /$bunfs/root/.
 *
 * The .node file must be placed next to the compiled binary during build.
 *
 * NOTE: The native addon produces int16 PCM audio. Consumers that need
 * float32 (e.g. the Kyutai STT server) must convert manually.
 */

import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import path from "node:path"
import { mute } from "./stderr-native"

const req = createRequire(import.meta.url)

type NativeEvent =
  | { type: 0; data?: Buffer }
  | { type: 1 }
  | { type: 2 }
  | { type: 3; message?: string }

type AudioRecorderNative = {
  startMicrophone(opts: MicRecorderOpts): void
  stop(): void
  processEvents(): NativeEvent[]
}

type CoreaudioAddon = { AudioRecorderNative: new () => AudioRecorderNative }

export type MicRecorderOpts = {
  sampleRate?: number
  chunkDurationMs?: number
  stereo?: boolean
  deviceId?: number
  gain?: number
}

function quiet() {
  if (process.platform !== "darwin") return
  if (process.env.OPENCODE_VOICE_NATIVE_LOGS === "1") return
  process.env.OS_ACTIVITY_MODE ??= "disable"
  process.env.CFLOG_FORCE_STDERR ??= "0"
  process.env.CFLOG_FORCE_DISABLE_STDERR ??= "1"
}

quiet()

function load(): CoreaudioAddon {
  const paths = [
    // Next to the binary (compiled build)
    path.join(path.dirname(process.execPath), "coreaudio.node"),
    // node_modules (development)
    path.resolve(__dirname, "../../../../node_modules/coreaudio-node/build/Release/coreaudio.node"),
    // workspace root node_modules
    path.resolve(__dirname, "../../../../../../node_modules/coreaudio-node/build/Release/coreaudio.node"),
  ]
  for (const p of paths) {
    try {
      return req(p)
    } catch {}
  }
  throw new Error("Failed to load coreaudio.node native addon. Voice requires macOS with the native audio module.")
}

let cached: CoreaudioAddon | undefined

function addon(): CoreaudioAddon {
  if (!cached) cached = load()
  return cached
}

/**
 * Minimal MicrophoneRecorder that wraps the native AudioRecorderNative.
 * Mirrors the coreaudio-node MicrophoneRecorder API used by bridge.ts.
 */
export class MicrophoneRecorder extends EventEmitter {
  private native: AudioRecorderNative
  private running = false
  private poll: ReturnType<typeof setInterval> | null = null
  private opts: MicRecorderOpts
  private undo: (() => void) | null = null
  private gate: ReturnType<typeof setTimeout> | null = null

  constructor(opts: MicRecorderOpts = {}) {
    super()
    if (process.platform !== "darwin") throw new Error("coreaudio-node only supports macOS")
    quiet()
    this.native = new (addon().AudioRecorderNative)()
    this.opts = opts
  }

  async start() {
    if (this.running) throw new Error("Already running")
    this.undo = mute()
    try {
      this.native.startMicrophone({
        sampleRate: this.opts.sampleRate,
        chunkDurationMs: this.opts.chunkDurationMs,
        stereo: this.opts.stereo,
        deviceId: this.opts.deviceId,
        gain: this.opts.gain,
      })
    } catch (err) {
      this.unmute()
      throw err
    }
    this.running = true
    this.poll = setInterval(() => {
      if (!this.running) return
      for (const evt of this.native.processEvents()) {
        switch (evt.type) {
          case 0:
            if (evt.data) this.emit("data", { data: evt.data })
            break
          case 1:
            this.hold()
            this.emit("start")
            break
          case 2:
            this.unmute()
            this.emit("stop")
            break
          case 3:
            this.unmute()
            this.emit("error", new Error(evt.message || "Unknown error"))
            break
        }
      }
    }, 10)
  }

  async stop() {
    this.unmute()
    if (!this.running) return
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
    for (const evt of this.native.processEvents()) {
      if (evt.type === 0 && evt.data) this.emit("data", { data: evt.data })
    }
    this.native.stop()
    this.running = false
  }

  private unmute() {
    if (this.gate) {
      clearTimeout(this.gate)
      this.gate = null
    }
    if (!this.undo) return
    this.undo()
    this.undo = null
  }

  private hold() {
    if (this.gate) clearTimeout(this.gate)
    this.gate = setTimeout(() => {
      this.gate = null
      this.unmute()
    }, 1200)
  }
}
