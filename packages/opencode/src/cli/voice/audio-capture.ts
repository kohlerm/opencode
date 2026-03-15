/**
 * Audio Capture Module
 *
 * Captures audio from the microphone using the `mic` library.
 * Provides a stream of audio chunks for VAD processing.
 */

import { EventEmitter } from "node:events"
import { vlog } from "./vlog"
import mic from "mic"

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
  private mic: ReturnType<typeof mic> | null = null
  private isCapturing = false
  private audioStream: NodeJS.ReadableStream | null = null

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

    vlog("AudioCapture", `Starting capture: ${this.options.sampleRate}Hz, ${this.options.channels}ch, ${this.options.bitDepth}bit`)

    this.mic = mic({
      rate: String(this.options.sampleRate),
      channels: String(this.options.channels),
      bitwidth: String(this.options.bitDepth),
      device: this.options.device ?? undefined,
      exitOnSilence: this.options.exitOnSilence,
      debug: this.options.debug,
    })

    this.audioStream = this.mic.getAudioStream()

    // Handle audio data
    this.audioStream!.on("data", (data: Buffer) => {
      const chunk: AudioChunk = {
        buffer: data,
        sampleRate: this.options.sampleRate,
        samples: data.length / (this.options.bitDepth / 8),
        timestamp: Date.now(),
      }
      this.emit("data", chunk)
    })

    // Handle errors
    this.audioStream!.on("error", (err: Error) => {
      vlog("AudioCapture", `Stream error: ${err.message}`)
      this.emit("error", err)
    })

    // Handle silence (if exitOnSilence is set)
    this.audioStream!.on("silence", () => {
      vlog("AudioCapture", "Silence detected")
      this.emit("silence")
    })

    // Handle process exit
    this.audioStream!.on("processExitComplete", () => {
      vlog("AudioCapture", "Process exited")
      this.isCapturing = false
      this.emit("stopped")
    })

    this.mic!.start()
    this.isCapturing = true
    vlog("AudioCapture", "Capture started")
    this.emit("started")
  }

  /**
   * Stop capturing audio.
   */
  stop(): void {
    if (!this.isCapturing || !this.mic) {
      vlog("AudioCapture", "Not capturing, ignoring stop()")
      return
    }

    vlog("AudioCapture", "Stopping capture...")
    this.mic.stop()
    this.isCapturing = false
  }

  /**
   * Pause capturing (silence detection still active).
   */
  pause(): void {
    if (!this.isCapturing || !this.mic) {
      return
    }

    vlog("AudioCapture", "Pausing capture")
    this.mic.pause()
  }

  /**
   * Resume capturing.
   */
  resume(): void {
    if (!this.isCapturing || !this.mic) {
      return
    }

    vlog("AudioCapture", "Resuming capture")
    this.mic.resume()
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
