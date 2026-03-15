/**
 * WebRTC VAD Module (Stub Implementation)
 * 
 * This is a stub implementation since @minhducsun2002/node-webrtc-vad is not
 * available on npm. For production use, you should either:
 * 
 * 1. Use a native WebRTC VAD binding (requires building from source)
 * 2. Use an energy-based VAD (implemented here as fallback)
 * 3. Use a cloud-based VAD service
 * 
 * The interface matches what would be expected from WebRTC VAD for easy
 * replacement with a real implementation later.
 */

import { EventEmitter } from "node:events"
import { vlog } from "./vlog"

export type FrameDuration = 10 | 20 | 30

export interface WebRtcVadOptions {
  /** Sample rate (must be 8000, 16000, or 32000 Hz) */
  sampleRate?: number
  /** Frame duration in ms (10, 20, or 30) */
  frameDuration?: FrameDuration
  /** Aggressiveness level (0-3, where 3 is most aggressive) */
  aggressiveness?: number
  /** Silence threshold in ms before considering speech ended */
  silenceThresholdMs?: number
  /** Minimum speech duration in ms to trigger a speech segment */
  minSpeechDurationMs?: number
  /** Maximum speech duration in ms before forcing a split */
  maxSpeechDurationMs?: number
  /** RMS threshold for speech detection (default: 0.01) */
  rmsThreshold?: number
}

export interface SpeechSegment {
  /** Audio buffer containing the speech segment */
  buffer: Buffer
  /** Start time of the segment */
  startTime: number
  /** End time of the segment */
  endTime: number
  /** Duration in ms */
  durationMs: number
}

/**
 * Energy-based VAD as a fallback implementation.
 * Uses RMS energy to detect speech vs silence.
 */
export class WebRtcVad extends EventEmitter {
  private options: Required<WebRtcVadOptions>
  private isProcessing = false
  
  // State machine for speech detection
  private state: "idle" | "speaking" | "silence" = "idle"
  private currentSegment: Buffer[] = []
  private segmentStartTime: number = 0
  private silenceDuration = 0
  private speechDuration = 0
  private lastRms = 0
  
  // Buffer for incomplete frames
  private frameBuffer: Buffer = Buffer.alloc(0)

  constructor(options: WebRtcVadOptions = {}) {
    super()
    this.options = {
      sampleRate: options.sampleRate ?? 16000,
      frameDuration: options.frameDuration ?? 30,
      aggressiveness: options.aggressiveness ?? 3,
      silenceThresholdMs: options.silenceThresholdMs ?? 500,
      minSpeechDurationMs: options.minSpeechDurationMs ?? 250,
      maxSpeechDurationMs: options.maxSpeechDurationMs ?? 30000,
      rmsThreshold: options.rmsThreshold ?? 0.01,
    }

    // Adjust RMS threshold based on aggressiveness
    // Higher aggressiveness = lower threshold = MORE sensitive (easier to trigger)
    // Lower aggressiveness = higher threshold = less sensitive (harder to trigger)
    // For voice, we want to be more sensitive to catch speech early
    const aggressivenessMultiplier = 1.5 - (this.options.aggressiveness * 0.3)
    this.options.rmsThreshold *= aggressivenessMultiplier

    // Validate sample rate
    if (![8000, 16000, 32000].includes(this.options.sampleRate)) {
      throw new Error(`Invalid sample rate: ${this.options.sampleRate}. Must be 8000, 16000, or 32000 Hz`)
    }

    // Validate frame duration
    if (![10, 20, 30].includes(this.options.frameDuration)) {
      throw new Error(`Invalid frame duration: ${this.options.frameDuration}. Must be 10, 20, or 30 ms`)
    }
  }

  /**
   * Initialize the VAD instance.
   * For the stub, this just logs a warning about using energy-based VAD.
   */
  async init(): Promise<void> {
    vlog("WebRtcVad", `Initialized (STUB - energy-based VAD)`)
    vlog("WebRtcVad", `  Sample rate: ${this.options.sampleRate}Hz`)
    vlog("WebRtcVad", `  Frame duration: ${this.options.frameDuration}ms`)
    vlog("WebRtcVad", `  RMS threshold: ${this.options.rmsThreshold.toFixed(4)}`)
    vlog("WebRtcVad", `  Aggressiveness: ${this.options.aggressiveness}`)
    
    // Log warning about stub implementation
    console.warn(
      "[Voice] Using energy-based VAD (stub). For production, consider:\n" +
      "  - Installing a native WebRTC VAD binding\n" +
      "  - Using @tensorflow-models/speech-commands\n" +
      "  - Using a cloud VAD API"
    )
  }

  /**
   * Calculate RMS of audio buffer.
   */
  private calculateRms(buffer: Buffer): number {
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] / 32768.0 // Normalize to -1.0 to 1.0
      sum += sample * sample
    }
    return Math.sqrt(sum / samples.length)
  }

  /**
   * Process an audio chunk and detect speech.
   * Emits 'speechStart' when speech begins, 'speechEnd' with the segment when speech ends.
   */
  processAudio(chunk: Buffer, timestamp: number): void {
    if (!this.isProcessing) {
      this.isProcessing = true
      this.emit("started")
    }

    // Append to frame buffer
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk])

    // Calculate frame size in bytes (16-bit samples)
    const bytesPerSample = 2
    const samplesPerFrame = (this.options.sampleRate * this.options.frameDuration) / 1000
    const frameSizeBytes = samplesPerFrame * bytesPerSample

    // Process complete frames
    while (this.frameBuffer.length >= frameSizeBytes) {
      const frame = this.frameBuffer.subarray(0, frameSizeBytes)
      this.frameBuffer = this.frameBuffer.subarray(frameSizeBytes)

      const rms = this.calculateRms(frame)
      this.lastRms = rms
      const isSpeech = rms > this.options.rmsThreshold
      
      this.handleVadResult(isSpeech, frame, timestamp)
    }
  }

  private handleVadResult(isSpeech: boolean, frame: Buffer, timestamp: number): void {
    const frameDurationMs = this.options.frameDuration

    switch (this.state) {
      case "idle":
        if (isSpeech) {
          // Speech started
          this.state = "speaking"
          this.currentSegment = [frame]
          this.segmentStartTime = timestamp
          this.speechDuration = frameDurationMs
          this.silenceDuration = 0
          vlog("WebRtcVad", `Speech started (rms=${this.lastRms.toFixed(4)})`)
          this.emit("speechStart")
        }
        break

      case "speaking":
        this.currentSegment.push(frame)
        this.speechDuration += frameDurationMs

        if (isSpeech) {
          // Still speaking, reset silence counter
          this.silenceDuration = 0
        } else {
          // Potential silence
          this.silenceDuration += frameDurationMs
          
          // Check if we've reached silence threshold
          if (this.silenceDuration >= this.options.silenceThresholdMs) {
            // End of speech segment
            this.endSegment()
          }
        }

        // Check max speech duration
        if (this.speechDuration >= this.options.maxSpeechDurationMs) {
          vlog("WebRtcVad", `Max speech duration reached (${this.options.maxSpeechDurationMs}ms), forcing split`)
          this.endSegment()
        }
        break

      case "silence":
        if (isSpeech) {
          // New speech started after silence
          this.state = "speaking"
          this.currentSegment = [frame]
          this.segmentStartTime = timestamp
          this.speechDuration = frameDurationMs
          this.silenceDuration = 0
          vlog("WebRtcVad", `Speech started (after silence, rms=${this.lastRms.toFixed(4)})`)
          this.emit("speechStart")
        } else {
          // Accumulate silence time
          this.silenceDuration += frameDurationMs
          
          // Reset to idle after extended silence (ready for next utterance)
          if (this.silenceDuration >= this.options.silenceThresholdMs * 2) {
            vlog("WebRtcVad", "Reset to idle after extended silence")
            this.state = "idle"
            this.silenceDuration = 0
          }
        }
        break
    }
  }

  private endSegment(): void {
    if (this.currentSegment.length === 0) {
      this.state = "idle"
      return
    }

    const segmentBuffer = Buffer.concat(this.currentSegment)
    const durationMs = this.speechDuration

    // Only emit if segment meets minimum duration
    if (durationMs >= this.options.minSpeechDurationMs) {
      const segment: SpeechSegment = {
        buffer: segmentBuffer,
        startTime: this.segmentStartTime,
        endTime: Date.now(),
        durationMs,
      }

      vlog("WebRtcVad", `Speech ended: ${durationMs}ms, ${segmentBuffer.length} bytes`)
      this.emit("speechEnd", segment)
    } else {
      vlog("WebRtcVad", `Segment too short (${durationMs}ms < ${this.options.minSpeechDurationMs}ms), discarding`)
    }

    // Reset state
    this.state = "silence"
    this.currentSegment = []
    this.speechDuration = 0
    this.silenceDuration = 0
  }

  /**
   * Force end the current segment (if any).
   */
  flush(): void {
    if (this.state === "speaking" && this.currentSegment.length > 0) {
      this.endSegment()
    }
    this.state = "idle"
    this.frameBuffer = Buffer.alloc(0)
  }

  /**
   * Reset the VAD state.
   */
  reset(): void {
    this.state = "idle"
    this.currentSegment = []
    this.segmentStartTime = 0
    this.speechDuration = 0
    this.silenceDuration = 0
    this.frameBuffer = Buffer.alloc(0)
    vlog("WebRtcVad", "Reset")
  }

  /**
   * Stop processing and cleanup.
   */
  stop(): void {
    this.flush()
    this.isProcessing = false
    vlog("WebRtcVad", "Stopped")
    this.emit("stopped")
  }

  /**
   * Check if VAD is initialized.
   */
  isInitialized(): boolean {
    return true // Always initialized in stub
  }

  /**
   * Check if currently processing.
   */
  isActive(): boolean {
    return this.isProcessing
  }

  /**
   * Get current state.
   */
  getState(): "idle" | "speaking" | "silence" {
    return this.state
  }

  /**
   * Get current speech duration in ms.
   */
  getSpeechDuration(): number {
    return this.speechDuration
  }

  /**
   * Get last calculated RMS value.
   */
  getLastRms(): number {
    return this.lastRms
  }
}

export default WebRtcVad
