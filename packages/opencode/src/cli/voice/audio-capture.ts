/**
 * Audio Capture Module
 *
 * Captures audio from the microphone using coreaudio-node.
 * Provides a stream of audio chunks for VAD processing.
 */

import { EventEmitter } from "node:events"
import { MicrophoneRecorder } from "./coreaudio"
import { vlog } from "./vlog"

export interface AudioCaptureOptions {
  /** Sample rate in Hz (default: 16000) */
  sampleRate?: number
  /** Number of channels (default: 1 - mono) */
  channels?: number
  /** Bit depth (default: 16) */
  bitDepth?: number
  /** Audio device (default: null - system default) */
  device?: string | null
  /** Whether to exit on silence (default: false) */
  exitOnSilence?: number
  /** Debug mode (default: false) */
  debug?: boolean
}

export interface AudioChunk {
  /** Raw audio buffer */
  buffer: Buffer
  /** Sample rate */
  sampleRate: number
  /** Number of samples in this chunk */
  samples: number
  /** Timestamp when captured */
  timestamp: number
}

export class AudioCapture extends EventEmitter {
  private options: Required<AudioCaptureOptions>
  private recorder: any = null
  private isCapturing = false

  constructor(options: AudioCaptureOptions = {}) {
    super()
    this.options = {
      sampleRate: options.sampleRate ?? 16000,
      channels: options.channels ?? 1,
      bitDepth: options.bitDepth ?? 16,
      device: options.device ?? null,
      exitOnSilence: options.exitOnSilence ?? 0,
      debug: options.debug ?? false,
    }
  }

  /**
   * Start capturing audio from the microphone.
   */
  async start(): Promise<void> {
    if (this.isCapturing) {
      vlog("AudioCapture", "Already capturing, ignoring start()")
      return
    }

    vlog(
      "AudioCapture",
      `Starting capture: ${this.options.sampleRate}Hz, ${this.options.channels}ch, ${this.options.bitDepth}bit`,
    )

    this.recorder = new MicrophoneRecorder({
      sampleRate: this.options.sampleRate,
      chunkDurationMs: 80,
      stereo: this.options.channels > 1,
      deviceId: this.options.device ?? undefined,
    })

    this.recorder.on("error", (err: Error) => {
      vlog("AudioCapture", `Recorder error: ${err.message}`)
      this.emit("error", err)
    })

    this.recorder.on("data", (chunk: { data: Buffer }) => {
      const audioChunk: AudioChunk = {
        buffer: chunk.data,
        sampleRate: this.options.sampleRate,
        samples: chunk.data.length / (this.options.bitDepth / 8),
        timestamp: Date.now(),
      }
      this.emit("data", audioChunk)
    })

    this.recorder.on("start", () => {
      vlog("AudioCapture", "Capture started")
      this.isCapturing = true
      this.emit("started")
    })

    this.recorder.on("stop", () => {
      vlog("AudioCapture", "Capture stopped")
      this.isCapturing = false
      this.emit("stopped")
    })

    await this.recorder.start()
  }

  /**
   * Stop capturing audio.
   */
  async stop(): Promise<void> {
    if (!this.isCapturing || !this.recorder) {
      vlog("AudioCapture", "Not capturing, ignoring stop()")
      return
    }

    vlog("AudioCapture", "Stopping capture...")
    await this.recorder.stop()
    this.isCapturing = false
  }

  /**
   * Pause capturing (silence detection still active).
   */
  pause(): void {
    vlog("AudioCapture", "Pause not implemented in coreaudio-node")
  }

  /**
   * Resume capturing.
   */
  resume(): void {
    vlog("AudioCapture", "Resume not implemented in coreaudio-node")
  }

  /**
   * Check if currently capturing.
   */
  isActive(): boolean {
    return this.isCapturing
  }

  /**
   * Get current sample rate.
   */
  getSampleRate(): number {
    return this.options.sampleRate
  }

  /**
   * Get bytes per sample.
   */
  getBytesPerSample(): number {
    return this.options.bitDepth / 8
  }
}

export default AudioCapture
