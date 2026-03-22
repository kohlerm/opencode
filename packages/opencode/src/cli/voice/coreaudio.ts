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

const req = createRequire(import.meta.url)

function load(): any {
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

let cached: any

function addon() {
  if (!cached) cached = load()
  return cached
}

/**
 * Minimal MicrophoneRecorder that wraps the native AudioRecorderNative.
 * Mirrors the coreaudio-node MicrophoneRecorder API used by bridge.ts.
 */
export class MicrophoneRecorder extends EventEmitter {
  private native: any
  private running = false
  private poll: ReturnType<typeof setInterval> | null = null
  private opts: Record<string, any>

  constructor(opts: Record<string, any> = {}) {
    super()
    if (process.platform !== "darwin") throw new Error("coreaudio-node only supports macOS")
    this.native = new (addon().AudioRecorderNative)()
    this.opts = opts
  }

  async start() {
    if (this.running) throw new Error("Already running")
    this.native.startMicrophone({
      sampleRate: this.opts.sampleRate,
      chunkDurationMs: this.opts.chunkDurationMs,
      stereo: this.opts.stereo,
      deviceId: this.opts.deviceId,
      gain: this.opts.gain,
    })
    this.running = true
    this.poll = setInterval(() => {
      if (!this.running) return
      for (const evt of this.native.processEvents()) {
        switch (evt.type) {
          case 0:
            if (evt.data) this.emit("data", { data: evt.data })
            break
          case 1:
            this.emit("start")
            break
          case 2:
            this.emit("stop")
            break
          case 3:
            this.emit("error", new Error(evt.message || "Unknown error"))
            break
        }
      }
    }, 10)
  }

  async stop() {
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
}
