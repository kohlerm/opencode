/**
 * Voice Bridge
 *
 * Main bridge component that connects RCLI voice proxy with OpenCode.
 * Manages the RCLI process, handles socket communication, and translates
 * between protocols.
 *
 * Architecture (client-side VAD):
 * 1. RCLI captures audio via CoreAudio and streams PCM16 chunks over socket
 * 2. Bridge runs EnergyVad on received chunks for speech detection
 * 3. On speech end, bridge sends complete segment back to RCLI for offline STT (Parakeet TDT)
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { RcliSocketClient } from "./socket-client"
import { SentenceDetector, sanitizeForTts } from "./sentence-detector"
import { EnergyVad } from "./energy-vad"
import type { RcliMessage, BridgeMessage } from "./protocol"
import type { SpeechSegment } from "./energy-vad"
import type { Config } from "../../config/config"
import { vlog } from "./vlog"

export interface VoiceBridgeConfig {
  /** Path to RCLI binary */
  rcliPath: string
  /** Unix socket path for RCLI proxy */
  socketPath: string
  /** OpenCode server URL */
  serverUrl: string
  /** Project directory */
  directory: string
  /** Voice configuration */
  voiceConfig: Config.Info["voice"]
  /** Enable client-side audio capture with energy-based VAD (default: true) */
  clientAudioCapture?: boolean
  /** VAD aggressiveness level (0-3, default: 3) */
  vadAggressiveness?: number
  /** Enable adaptive noise floor threshold (default: true) */
  vadAdaptiveThreshold?: boolean
  /** Pre-emphasis coefficient (0.0-1.0, default: 0.97) */
  vadPreEmphasis?: number
  /** Hangover frames to prevent chopping (default: 5) */
  vadHangoverFrames?: number
  /** Silence threshold in ms before considering speech ended (default: 500) */
  vadSilenceThresholdMs?: number
  /** Minimum speech duration in ms to trigger a speech segment (default: 250) */
  vadMinSpeechDurationMs?: number
  /** Maximum speech duration in ms before forcing a split (default: 30000) */
  vadMaxSpeechDurationMs?: number
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
  private rcliProcess: ChildProcess | null = null
  private socket: RcliSocketClient
  private sentenceDetector: SentenceDetector

  // Audio capture and VAD
  private energyVad: EnergyVad | null = null
  private isCapturing = false

  private state: VoiceState = "idle"
  private sessionID: string | null = null
  private isEnabled = false
  private ttsQueue: string[] = []
  private isSpeaking = false
  private audioLevel = 0
  private isSpeech = false
  private lastTranscript = ""
  private processingTimeout: ReturnType<typeof setTimeout> | null = null

  // Barge-in detection
  private playbackRms = 0
  private consecutiveSpeechFrames = 0
  private readonly BARGE_IN_DEBOUNCE_FRAMES = 3
  private readonly BARGE_IN_ENERGY_FLOOR = 0.02
  private readonly BARGE_IN_ENERGY_RATIO = 2.5

  constructor(config: VoiceBridgeConfig) {
    super()
    vlog("Bridge", `constructor called, socketPath=${config.socketPath}`)

    // Set defaults
    this.config = {
      ...config,
      clientAudioCapture: config.clientAudioCapture ?? true,
      vadAggressiveness: config.vadAggressiveness ?? 3,
      vadAdaptiveThreshold: config.vadAdaptiveThreshold ?? true,
      vadPreEmphasis: config.vadPreEmphasis ?? 0.97,
      vadHangoverFrames: config.vadHangoverFrames ?? 5,
      vadSilenceThresholdMs: config.vadSilenceThresholdMs ?? 300,
      vadMinSpeechDurationMs: config.vadMinSpeechDurationMs ?? 250,
      vadMaxSpeechDurationMs: config.vadMaxSpeechDurationMs ?? 30000,
    }

    this.socket = new RcliSocketClient({
      socketPath: config.socketPath,
      reconnect: true,
      reconnectDelay: 1000,
    })

    this.sentenceDetector = new SentenceDetector({
      minWords: config.voiceConfig?.tts?.speed === 1.0 ? 6 : 4,
      firstSentenceMinWords: 1,
      maxWordsSecondary: 35,
    })

    this.setupSocketHandlers()
  }

  private setupSocketHandlers(): void {
    this.socket.on("connect", () => {
      this.emit("connect")
      this.sendConfig()
    })

    this.socket.on("disconnect", () => {
      this.emit("disconnect")
      this.setState("idle")
      this.stopAudioCapture()
    })

    this.socket.on("message", (msg: RcliMessage) => {
      this.handleRcliMessage(msg)
    })

    this.socket.on("error", (err: Error) => {
      this.emit("error", err)
    })
  }

  /**
   * Start the voice bridge by connecting to RCLI proxy and initializing audio capture.
   */
  async start(): Promise<void> {
    // Expand ~ in socket path
    let socketPath = this.config.socketPath
    if (socketPath.startsWith("~")) {
      socketPath = socketPath.replace("~", process.env.HOME || "~")
    }

    vlog("Bridge", `Connecting to RCLI proxy at ${socketPath}...`)

    try {
      // Initialize audio capture and VAD BEFORE connecting,
      // so they're ready when the connect handler calls toggle().
      if (this.config.clientAudioCapture) {
        await this.initAudioCapture()
      }

      await this.socket.connect()
      vlog("Bridge", "Connected to RCLI proxy successfully!")
    } catch (err) {
      vlog("Bridge", `Failed to connect to RCLI proxy: ${err}`)
      throw err
    }
  }

  /**
   * Initialize energy-based VAD for processing audio chunks from RCLI.
   * Audio capture is handled by RCLI (CoreAudio) — we only need the VAD here.
   */
  private async initAudioCapture(): Promise<void> {
    vlog("Bridge", "Initializing energy-based VAD...")

    try {
      // Create energy-based VAD
      this.energyVad = new EnergyVad({
        sampleRate: 16000,
        frameDuration: 30,
        aggressiveness: this.config.vadAggressiveness,
        silenceThresholdMs: this.config.vadSilenceThresholdMs,
        minSpeechDurationMs: this.config.vadMinSpeechDurationMs,
        maxSpeechDurationMs: this.config.vadMaxSpeechDurationMs,
        adaptiveThreshold: this.config.vadAdaptiveThreshold,
        preEmphasis: this.config.vadPreEmphasis,
        hangoverFrames: this.config.vadHangoverFrames,
      })

      // Initialize VAD
      await this.energyVad.init()

      // Setup VAD handlers
      this.energyVad.on("speechStart", () => {
        this.isSpeech = true
        this.emit("audioLevel", this.audioLevel, true)
        vlog("Bridge", "VAD: Speech started")
      })

      this.energyVad.on("speechEnd", (segment: SpeechSegment) => {
        this.isSpeech = false
        this.emit("audioLevel", this.audioLevel, false)
        this.handleSpeechSegment(segment)
      })

      vlog("Bridge", "Energy-based VAD initialized successfully")
    } catch (err) {
      vlog("Bridge", `Failed to initialize VAD: ${err}`)
      throw err
    }
  }

  /**
   * Handle audio chunk received from RCLI via socket (CoreAudio capture).
   * Feed to EnergyVad for speech detection.
   */
  private handleAudioChunk(buffer: Buffer, timestamp: number): void {
    if (!this.energyVad || !this.isEnabled) {
      return
    }

    // Calculate RMS for audio level
    let sum = 0
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] / 32768.0
      sum += sample * sample
    }
    this.audioLevel = Math.sqrt(sum / samples.length)

    // Check for barge-in if speaking
    if (this.isSpeaking) {
      this.checkBargeIn()
    }

    // Process audio with VAD
    this.energyVad.processAudio(buffer, timestamp)
  }

  /**
   * Check for barge-in (user interrupting TTS).
   */
  private checkBargeIn(): void {
    const micRms = this.audioLevel
    const pbRms = this.playbackRms

    const strongMic = micRms > this.BARGE_IN_ENERGY_FLOOR
    const louderThanSpeaker = pbRms < 0.001 || micRms > pbRms * this.BARGE_IN_ENERGY_RATIO

    if (this.isSpeech && strongMic && louderThanSpeaker) {
      this.consecutiveSpeechFrames++

      if (this.consecutiveSpeechFrames >= this.BARGE_IN_DEBOUNCE_FRAMES) {
        vlog("Bridge", `Barge-in detected: mic=${micRms.toFixed(4)}, pb=${pbRms.toFixed(4)}`)
        this.handleBargeIn()
        this.consecutiveSpeechFrames = 0
      }
    } else {
      this.consecutiveSpeechFrames = 0
    }
  }

  /**
   * Handle detected speech segment - send to RCLI for STT.
   */
  private handleSpeechSegment(segment: SpeechSegment): void {
    if (!this.isEnabled) {
      vlog("Bridge", "Ignoring speech segment - voice not enabled")
      return
    }

    // Allow speech segments in listening or idle state (client-side capture)
    // Don't process if we're already processing or speaking
    if (this.state === "processing" || this.state === "speaking") {
      vlog("Bridge", `Ignoring speech segment - currently ${this.state}`)
      return
    }

    vlog("Bridge", `Sending speech segment to RCLI: ${segment.durationMs}ms, ${segment.buffer.length} bytes`)

    // Convert audio to base64
    const audio = segment.buffer.toString("base64")

    // Send complete segment as audio_final for Parakeet TDT / Whisper offline transcription
    this.send({
      type: "audio_final",
      data: audio,
      sampleRate: 16000,
      isFinal: true,
      timestamp: segment.startTime,
    })

    this.setState("processing")

    // Safety timeout: if no transcript arrives within 5s, go back to listening
    this.clearProcessingTimeout()
    this.processingTimeout = setTimeout(() => {
      if (this.state === "processing") {
        vlog("Bridge", "Processing timeout — no transcript received, returning to listening")
        this.setState("listening")
      }
    }, 5000)
  }

  /**
   * Start audio capture — RCLI handles mic via CoreAudio,
   * we just need to mark ourselves as ready to receive audio_chunk messages.
   */
  private async startAudioCapture(): Promise<void> {
    if (!this.energyVad) {
      vlog("Bridge", `Cannot start capture: VAD not initialized`)
      return
    }

    if (this.isCapturing) {
      vlog("Bridge", "Audio capture already active, ignoring start request")
      return
    }

    this.isCapturing = true
    vlog("Bridge", "Audio capture started (RCLI handles mic)")
  }

  /**
   * Stop audio capture.
   */
  private stopAudioCapture(): void {
    this.isCapturing = false
    this.clearProcessingTimeout()
    if (this.energyVad) {
      this.energyVad.stop()
    }
    vlog("Bridge", "Audio capture stopped")
  }

  private clearProcessingTimeout(): void {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout)
      this.processingTimeout = null
    }
  }

  /**
   * Stop the voice bridge and cleanup.
   */
  stop(): void {
    vlog("Bridge", "stop() called")
    this.stopAudioCapture()
    this.socket.disconnect()
    if (this.rcliProcess) {
      this.rcliProcess.kill()
      this.rcliProcess = null
    }
    this.setState("idle")
  }

  /**
   * Toggle voice mode on/off.
   */
  toggle(enabled: boolean): void {
    vlog("Bridge", `toggle(${enabled}) called`)
    this.isEnabled = enabled
    // Send toggle with clientAudioCapture flag so RCLI knows not to open its own mic
    this.send({ type: "toggle", enabled, clientAudioCapture: this.config.clientAudioCapture })

    if (enabled) {
      // Start audio capture immediately when enabled (don't wait for state change)
      if (this.config.clientAudioCapture) {
        vlog("Bridge", "Starting audio capture immediately (client-side capture)")
        this.startAudioCapture()
        // Set state to listening since we're now capturing
        this.setState("listening")
      }
    } else {
      // Stop audio capture when disabled
      this.stopAudioCapture()
      this.setState("idle")
      this.sentenceDetector.clear()
    }
  }

  /**
   * Check if voice is enabled.
   */
  isVoiceEnabled(): boolean {
    return this.isEnabled
  }

  /**
   * Get current voice state.
   */
  getState(): VoiceState {
    return this.state
  }

  /**
   * Get current audio level (0-1).
   */
  getAudioLevel(): number {
    return this.audioLevel
  }

  /**
   * Check if VAD detects speech.
   */
  isSpeechDetected(): boolean {
    return this.isSpeech
  }

  /**
   * Get last transcript.
   */
  getLastTranscript(): string {
    return this.lastTranscript
  }

  /**
   * Set the active session ID.
   */
  setSessionID(sessionID: string): void {
    this.sessionID = sessionID
  }

  /**
   * Feed LLM text delta for TTS.
   */
  feedLLMText(text: string): void {
    if (!this.isEnabled) return

    this.sentenceDetector.feed(text, (sentence) => {
      this.queueTts(sentence)
    })
  }

  /**
   * Flush any remaining LLM text.
   */
  flushLLMText(): void {
    this.sentenceDetector.flush((sentence) => {
      this.queueTts(sentence)
    })
  }

  private async spawnRcli(): Promise<void> {
    const args = [
      "proxy",
      "--socket",
      this.config.socketPath,
      "--tts-model",
      this.config.voiceConfig?.tts?.model || "kokoro-en",
      "--stt-model",
      this.config.voiceConfig?.stt?.model || "zipformer",
    ]

    if (this.config.voiceConfig?.tts?.voice) {
      args.push("--tts-voice", this.config.voiceConfig.tts.voice)
    }

    return new Promise((resolve, reject) => {
      this.rcliProcess = spawn(this.config.rcliPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      this.rcliProcess.on("error", reject)
      this.rcliProcess.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          this.emit("error", new Error(`RCLI process exited with code ${code}`))
        }
        this.rcliProcess = null
      })

      // Wait for socket to be ready (RCLI will print "Listening on ...")
      let buffer = ""
      this.rcliProcess.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString()
        if (buffer.includes("Listening on") || buffer.includes("Socket ready")) {
          resolve()
        }
      })

      this.rcliProcess.stderr?.on("data", (data: Buffer) => {
        console.error("RCLI stderr:", data.toString())
      })

      // Timeout after 10 seconds
      setTimeout(() => {
        reject(new Error("Timeout waiting for RCLI to start"))
      }, 10000)
    })
  }

  private handleRcliMessage(msg: RcliMessage): void {
    switch (msg.type) {
      case "transcript":
        this.handleTranscript(msg.text, msg.isFinal)
        break
      case "state":
        // In client audio mode, the bridge manages listening/processing state
        // based on local VAD.  Accept RCLI state messages for:
        //  - "speaking" and "interrupted" which RCLI controls (TTS playback)
        // Ignore RCLI "idle", "listening", "processing" which would clobber local state.
        if (this.config.clientAudioCapture) {
          if (msg.state === "speaking" || msg.state === "interrupted") {
            this.setState(msg.state)
          }
        } else {
          this.setState(msg.state)
        }
        break
      case "audio_chunk":
        // Audio from RCLI CoreAudio capture — feed to local EnergyVad
        if (this.config.clientAudioCapture && this.isCapturing) {
          const buf = Buffer.from(msg.data, "base64")
          this.handleAudioChunk(buf, Date.now())
        }
        if (this.config.clientAudioCapture && this.isCapturing) {
          const buf = Buffer.from(msg.data, "base64")
          this.handleAudioChunk(buf, Date.now())
        }
        break
      case "audio_level":
        // Only use RCLI audio levels if not using client audio capture
        if (!this.config.clientAudioCapture) {
          this.audioLevel = msg.level
          this.isSpeech = msg.isSpeech
          this.emit("audioLevel", msg.level, msg.isSpeech)
        }
        break
      case "barge_in":
        this.handleBargeIn()
        break
      case "error":
        this.emit("error", new Error(`RCLI error: ${msg.message}`))
        break
    }
  }

  private handleTranscript(text: string, isFinal: boolean): void {
    if (isFinal && !text.trim()) {
      // Empty final — STT produced no result (e.g. short noise).
      // Just go back to listening without submitting anything.
      vlog("Bridge", "Empty final transcript — returning to listening")
      this.clearProcessingTimeout()
      if (this.isEnabled) {
        this.setState("listening")
      }
      return
    }

    this.lastTranscript = text
    this.emit("transcript", text, isFinal)

    if (isFinal) {
      this.clearProcessingTimeout()

      // Send final transcript event (session may be null on Home route).
      this.sendToOpencode(text)

      // After final transcript, go back to listening state
      if (this.isEnabled) {
        this.setState("listening")
      }
    }
  }

  private async sendToOpencode(text: string): Promise<void> {
    // This will be implemented with actual SDK call
    // For now, emit event for consumer to handle
    this.emit("transcriptFinal", text, this.sessionID)
  }

  private handleBargeIn(): void {
    this.emit("bargeIn")

    // Stop TTS
    this.send({ type: "interrupt" })
    this.isSpeaking = false
    this.ttsQueue = []
    this.sentenceDetector.clear()

    // Emit event for consumer to abort OpenCode session
    this.emit("abortSession", this.sessionID)
  }

  private queueTts(text: string): void {
    const cleanText = sanitizeForTts(text)
    if (!cleanText) return

    this.ttsQueue.push(cleanText)
    this.processTtsQueue()
  }

  private processTtsQueue(): void {
    if (this.isSpeaking || this.ttsQueue.length === 0 || !this.isEnabled) {
      return
    }

    const text = this.ttsQueue.shift()
    if (!text) return

    this.isSpeaking = true
    this.send({ type: "speak", text })
  }

  private setState(state: VoiceState): void {
    if (this.state !== state) {
      this.state = state
      this.emit("stateChange", state)

      // Keep audio capture running continuously while voice is enabled.
      // The mic + VAD pipeline must stay active so we can detect the next
      // utterance after processing finishes.  Only start here if it wasn't
      // already started by toggle().
      if (state === "listening" && this.config.clientAudioCapture && this.isEnabled && !this.isCapturing) {
        this.startAudioCapture()
      }

      // When speaking finishes, process next in queue
      if (state !== "speaking") {
        this.isSpeaking = false
        this.processTtsQueue()
      }
    }
  }

  private send(message: BridgeMessage): void {
    try {
      this.socket.send(message)
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)))
    }
  }

  private sendConfig(): void {
    const config: BridgeMessage = {
      type: "config",
      ttsVoice: this.config.voiceConfig?.tts?.voice,
      sttModel: this.config.voiceConfig?.stt?.model,
      vadThreshold: this.config.voiceConfig?.vad?.threshold,
      clientAudioCapture: this.config.clientAudioCapture,
    }
    this.send(config)
  }
}
