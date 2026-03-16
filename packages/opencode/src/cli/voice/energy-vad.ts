/**
 * Energy-based Voice Activity Detection Module
 * 
 * A pure energy-based VAD implementation using:
 * - RMS energy for speech detection
 * - Adaptive noise floor tracking
 * - Pre-emphasis filter to boost voice frequencies
 * - Configurable silence timeout with hangover
 * - Smooth state transitions to prevent rapid switching
 * 
 * This is NOT WebRTC VAD - it's a lightweight energy-based alternative
 * that requires no native dependencies or external libraries.
 */

import { EventEmitter } from "node:events"
import { vlog } from "./vlog"

export type FrameDuration = 10 | 20 | 30

export interface EnergyVadOptions {
  /** Sample rate (must be 8000, 16000, 32000, or 48000 Hz) */
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
  /** RMS threshold for speech detection (default: auto-calculated) */
  rmsThreshold?: number
  /** Enable adaptive threshold based on noise floor (default: true) */
  adaptiveThreshold?: boolean
  /** Pre-emphasis coefficient (0.0-1.0, default: 0.97) - boosts high frequencies */
  preEmphasis?: number
  /** Hangover frames to prevent chopping (default: 5) */
  hangoverFrames?: number
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
 * Energy-based Voice Activity Detector
 * Uses RMS energy with adaptive threshold and pre-emphasis for voice detection.
 */
export class EnergyVad extends EventEmitter {
  private options: Required<EnergyVadOptions>
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
  
  // Adaptive threshold tracking
  private noiseFloor = 0
  private noiseFloorHistory: number[] = []
  private readonly noiseFloorHistorySize = 30 // ~1 second at 30ms frames
  private hangoverCount = 0
  private lastSample = 0 // For pre-emphasis

  constructor(options: EnergyVadOptions = {}) {
    super()
    this.options = {
      sampleRate: options.sampleRate ?? 16000,
      frameDuration: options.frameDuration ?? 30,
      aggressiveness: options.aggressiveness ?? 3,
      silenceThresholdMs: options.silenceThresholdMs ?? 500,
      minSpeechDurationMs: options.minSpeechDurationMs ?? 250,
      maxSpeechDurationMs: options.maxSpeechDurationMs ?? 30000,
      rmsThreshold: options.rmsThreshold ?? 0.01,
      adaptiveThreshold: options.adaptiveThreshold ?? true,
      preEmphasis: options.preEmphasis ?? 0.97,
      hangoverFrames: options.hangoverFrames ?? 5,
    }

    // Adjust base RMS threshold based on aggressiveness
    // Higher aggressiveness = lower threshold = MORE sensitive (easier to trigger)
    const aggressivenessMultiplier = 1.5 - (this.options.aggressiveness * 0.3)
    this.options.rmsThreshold *= aggressivenessMultiplier

    // Validate sample rate - support common rates including 48kHz
    if (![8000, 16000, 32000, 48000].includes(this.options.sampleRate)) {
      throw new Error(`Invalid sample rate: ${this.options.sampleRate}. Must be 8000, 16000, 32000, or 48000 Hz`)
    }

    // Validate frame duration
    if (![10, 20, 30].includes(this.options.frameDuration)) {
      throw new Error(`Invalid frame duration: ${this.options.frameDuration}. Must be 10, 20, or 30 ms`)
    }
  }

  /**
   * Initialize the VAD instance.
   */
  async init(): Promise<void> {
    vlog("EnergyVad", `Initialized (energy-based VAD)`)
    vlog("EnergyVad", `  Sample rate: ${this.options.sampleRate}Hz`)
    vlog("EnergyVad", `  Frame duration: ${this.options.frameDuration}ms`)
    vlog("EnergyVad", `  Base RMS threshold: ${this.options.rmsThreshold.toFixed(4)}`)
    vlog("EnergyVad", `  Adaptive threshold: ${this.options.adaptiveThreshold}`)
    vlog("EnergyVad", `  Pre-emphasis: ${this.options.preEmphasis}`)
    vlog("EnergyVad", `  Aggressiveness: ${this.options.aggressiveness}`)
  }

  /**
   * Calculate RMS of audio buffer with optional pre-emphasis.
   * Pre-emphasis boosts high frequencies where voice energy is concentrated.
   */
  private calculateRms(buffer: Buffer): number {
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    let sum = 0
    
    for (let i = 0; i < samples.length; i++) {
      let sample = samples[i] / 32768.0 // Normalize to -1.0 to 1.0
      
      // Apply pre-emphasis filter: y[n] = x[n] - alpha * x[n-1]
      // This boosts high frequencies (voice formants) and suppresses low-freq noise
      if (this.options.preEmphasis > 0 && i > 0) {
        const prevSample = samples[i - 1] / 32768.0
        sample = sample - this.options.preEmphasis * prevSample
      }
      
      sum += sample * sample
    }
    
    // Store last sample for next frame continuity
    if (samples.length > 0) {
      this.lastSample = samples[samples.length - 1] / 32768.0
    }
    
    return Math.sqrt(sum / samples.length)
  }

  /**
   * Update noise floor estimate using exponential moving average.
   * This adapts to ambient noise levels over time.
   */
  private updateNoiseFloor(rms: number, isSpeech: boolean): void {
    if (!this.options.adaptiveThreshold) return
    
    // Only update noise floor during silence
    if (!isSpeech) {
      this.noiseFloorHistory.push(rms)
      if (this.noiseFloorHistory.length > this.noiseFloorHistorySize) {
        this.noiseFloorHistory.shift()
      }
      
      // Use percentile to avoid noise spikes affecting the floor
      const sorted = [...this.noiseFloorHistory].sort((a, b) => a - b)
      const percentile30 = sorted[Math.floor(sorted.length * 0.3)] || 0
      
      // Smooth update with exponential decay
      const alpha = 0.1 // Smoothing factor
      this.noiseFloor = (1 - alpha) * this.noiseFloor + alpha * percentile30
    }
  }

  /**
   * Get the current effective threshold considering noise floor.
   */
  private getEffectiveThreshold(): number {
    if (!this.options.adaptiveThreshold || this.noiseFloor === 0) {
      return this.options.rmsThreshold
    }
    
    // Dynamic threshold: base threshold + margin above noise floor
    // This ensures we detect speech even in noisy environments
    const noiseMargin = 3.0 // 3x above noise floor
    const dynamicThreshold = Math.max(
      this.options.rmsThreshold * 0.5,
      this.noiseFloor * noiseMargin
    )
    
    return dynamicThreshold
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
      const threshold = this.getEffectiveThreshold()
      const isSpeech = rms > threshold
      
      this.handleVadResult(isSpeech, frame, timestamp)
    }
  }

  /**
   * Calibrate the VAD by sampling ambient noise.
   * Call this during silence to establish noise floor baseline.
   * @param durationMs Duration to sample in milliseconds (default: 1000)
   */
  async calibrate(durationMs: number = 1000): Promise<void> {
    vlog("EnergyVad", `Calibrating noise floor for ${durationMs}ms...`)
    this.noiseFloorHistory = []
    
    // Reset last sample for pre-emphasis continuity
    this.lastSample = 0
    
    // Wait for calibration period while collecting noise samples
    const startTime = Date.now()
    while (Date.now() - startTime < durationMs) {
      // Process any pending audio frames to collect noise floor data
      if (this.frameBuffer.length >= this.getFrameSizeBytes()) {
        const frameSize = this.getFrameSizeBytes()
        const frame = this.frameBuffer.subarray(0, frameSize)
        this.frameBuffer = this.frameBuffer.subarray(frameSize)
        
        const rms = this.calculateRms(frame)
        this.noiseFloorHistory.push(rms)
        if (this.noiseFloorHistory.length > this.noiseFloorHistorySize) {
          this.noiseFloorHistory.shift()
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    
    // Calculate initial noise floor from collected samples
    if (this.noiseFloorHistory.length > 0) {
      const sorted = [...this.noiseFloorHistory].sort((a, b) => a - b)
      const percentile30 = sorted[Math.floor(sorted.length * 0.3)] || 0
      this.noiseFloor = percentile30
      vlog("EnergyVad", `Calibration complete. Noise floor: ${this.noiseFloor.toFixed(4)}`)
    }
  }

  /**
   * Get the current frame size in bytes.
   */
  private getFrameSizeBytes(): number {
    const bytesPerSample = 2
    const samplesPerFrame = (this.options.sampleRate * this.options.frameDuration) / 1000
    return samplesPerFrame * bytesPerSample
  }

  /**
   * Get current noise floor estimate.
   */
  getNoiseFloor(): number {
    return this.noiseFloor
  }

  /**
   * Get current effective threshold (considers adaptive threshold if enabled).
   */
  getEffectiveThresholdValue(): number {
    return this.getEffectiveThreshold()
  }

  private handleVadResult(rawIsSpeech: boolean, frame: Buffer, timestamp: number): void {
    const frameDurationMs = this.options.frameDuration
    
    // Update noise floor tracking
    this.updateNoiseFloor(this.lastRms, rawIsSpeech)
    
    // Apply hangover logic to prevent rapid state switching
    // Hangover keeps speech state active briefly after signal drops
    let isSpeech = rawIsSpeech
    if (this.state === "speaking" && !rawIsSpeech) {
      if (this.hangoverCount > 0) {
        isSpeech = true
        this.hangoverCount--
      }
    } else if (this.state === "speaking" && rawIsSpeech) {
      // Reset hangover when speech continues
      this.hangoverCount = this.options.hangoverFrames
    }

    switch (this.state) {
      case "idle":
        if (isSpeech) {
          // Speech started
          this.state = "speaking"
          this.currentSegment = [frame]
          this.segmentStartTime = timestamp
          this.speechDuration = frameDurationMs
          this.silenceDuration = 0
          this.hangoverCount = this.options.hangoverFrames
          vlog("EnergyVad", `Speech started (rms=${this.lastRms.toFixed(4)}, threshold=${this.getEffectiveThreshold().toFixed(4)})`)
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
          vlog("EnergyVad", `Max speech duration reached (${this.options.maxSpeechDurationMs}ms), forcing split`)
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
          this.hangoverCount = this.options.hangoverFrames
          vlog("EnergyVad", `Speech started (after silence, rms=${this.lastRms.toFixed(4)})`)
          this.emit("speechStart")
        } else {
          // Accumulate silence time
          this.silenceDuration += frameDurationMs
          
          // Reset to idle after extended silence (ready for next utterance)
          if (this.silenceDuration >= this.options.silenceThresholdMs * 2) {
            vlog("EnergyVad", "Reset to idle after extended silence")
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

      vlog("EnergyVad", `Speech ended: ${durationMs}ms, ${segmentBuffer.length} bytes`)
      this.emit("speechEnd", segment)
    } else {
      vlog("EnergyVad", `Segment too short (${durationMs}ms < ${this.options.minSpeechDurationMs}ms), discarding`)
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
    this.hangoverCount = 0
    this.lastSample = 0
    // Keep noise floor - it was calibrated for this environment
    vlog("EnergyVad", "Reset")
  }

  /**
   * Stop processing and cleanup.
   */
  stop(): void {
    this.flush()
    this.isProcessing = false
    vlog("EnergyVad", "Stopped")
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

export default EnergyVad
