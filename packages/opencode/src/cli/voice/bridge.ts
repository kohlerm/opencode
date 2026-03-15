/**
 * Voice Bridge
 * 
 * Main bridge component that connects RCLI voice proxy with OpenCode.
 * Manages the RCLI process, handles socket communication, and translates
 * between protocols.
 * 
 * With WebRTC VAD integration, this bridge now:
 * 1. Captures audio locally using `mic`
 * 2. Runs WebRTC VAD for speech detection
 * 3. Sends speech segments to RCLI for STT
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { RcliSocketClient } from "./socket-client"
import { SentenceDetector, sanitizeForTts } from "./sentence-detector"
import { AudioCapture } from "./audio-capture"
import { WebRtcVad } from "./webrtc-vad"
import type { RcliMessage, BridgeMessage } from "./protocol"
import type { SpeechSegment } from "./webrtc-vad"
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
  /** Enable client-side audio capture with WebRTC VAD (default: true) */
  clientAudioCapture?: boolean
  /** WebRTC VAD aggressiveness (0-3, default: 3) */
  vadAggressiveness?: number
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
  private audioCapture: AudioCapture | null = null
  private webRtcVad: WebRtcVad | null = null
  private isCapturing = false

  private state: VoiceState = "idle"
  private sessionID: string | null = null
  private isEnabled = false
  private ttsQueue: string[] = []
  private isSpeaking = false
  private audioLevel = 0
  private isSpeech = false
  private lastTranscript = ""

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
      await this.socket.connect()
      vlog("Bridge", "Connected to RCLI proxy successfully!")
      
      // Initialize audio capture and VAD if enabled
      if (this.config.clientAudioCapture) {
        await this.initAudioCapture()
      }
    } catch (err) {
      vlog("Bridge", `Failed to connect to RCLI proxy: ${err}`)
      throw err
    }
  }

  /**
   * Initialize audio capture and WebRTC VAD.
   */
  private async initAudioCapture(): Promise<void> {
    vlog("Bridge", "Initializing audio capture with WebRTC VAD...")

    try {
      // Create audio capture (16kHz, mono, 16-bit)
      this.audioCapture = new AudioCapture({
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        debug: false,
      })

      // Create WebRTC VAD
      this.webRtcVad = new WebRtcVad({
        sampleRate: 16000,
        frameDuration: 30,
        aggressiveness: this.config.vadAggressiveness,
        silenceThresholdMs: 500,
        minSpeechDurationMs: 250,
        maxSpeechDurationMs: 30000,
      })

      // Initialize VAD
      await this.webRtcVad.init()

      // Setup audio capture handlers
      this.audioCapture.on("data", (chunk) => {
        this.handleAudioChunk(chunk)
      })

      this.audioCapture.on("error", (err) => {
        vlog("Bridge", `Audio capture error: ${err.message}`)
        this.emit("error", err)
      })

      // Setup VAD handlers
      this.webRtcVad.on("speechStart", () => {
        this.isSpeech = true
        this.emit("audioLevel", this.audioLevel, true)
        vlog("Bridge", "VAD: Speech started")
      })

      this.webRtcVad.on("speechEnd", (segment: SpeechSegment) => {
        this.isSpeech = false
        this.emit("audioLevel", this.audioLevel, false)
        this.handleSpeechSegment(segment)
      })

      vlog("Bridge", "Audio capture and VAD initialized successfully")
    } catch (err) {
      vlog("Bridge", `Failed to initialize audio capture: ${err}`)
      throw err
    }
  }

  private handleAudioChunk(chunk: { buffer: Buffer; sampleRate: number; samples: number; timestamp: number }): void {
    if (!this.webRtcVad || !this.isEnabled) {
      if (!this.webRtcVad) vlog("Bridge", "Skipping audio chunk - VAD not initialized")
      if (!this.isEnabled) vlog("Bridge", "Skipping audio chunk - voice not enabled")
      return
    }

    // Calculate RMS for audio level
    let sum = 0
    const samples = new Int16Array(chunk.buffer.buffer, chunk.buffer.byteOffset, chunk.buffer.length / 2)
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] / 32768.0 // Normalize to -1.0 to 1.0
      sum += sample * sample
    }
    this.audioLevel = Math.sqrt(sum / samples.length)

    // Check for barge-in if speaking
    if (this.isSpeaking) {
      this.checkBargeIn()
    }

    // Process audio with VAD
    this.webRtcVad.processAudio(chunk.buffer, chunk.timestamp)
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
    const audioBase64 = segment.buffer.toString("base64")

    // Send to RCLI
    this.send({
      type: "audio",
      data: audioBase64,
      sampleRate: 16000,
      isFinal: true,
      timestamp: segment.startTime,
    })

    this.setState("processing")
  }

  /**
   * Start audio capture when entering listening state.
   */
  private async startAudioCapture(): Promise<void> {
    if (!this.audioCapture || !this.webRtcVad) {
      vlog("Bridge", `Cannot start capture: audioCapture=${!!this.audioCapture}, webRtcVad=${!!this.webRtcVad}`)
      return
    }
    
    if (this.isCapturing) {
      vlog("Bridge", "Audio capture already active, ignoring start request")
      return
    }

    try {
      vlog("Bridge", "Starting audio capture...")
      await this.audioCapture.start()
      this.isCapturing = true
      vlog("Bridge", "Audio capture started successfully")
    } catch (err) {
      vlog("Bridge", `Failed to start audio capture: ${err}`)
      this.emit("error", err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * Stop audio capture.
   */
  private stopAudioCapture(): void {
    if (this.audioCapture) {
      this.audioCapture.stop()
      this.isCapturing = false
      vlog("Bridge", "Audio capture stopped")
    }
    if (this.webRtcVad) {
      this.webRtcVad.stop()
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
    this.send({ type: "toggle", enabled })

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
        this.setState(msg.state)
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
    this.lastTranscript = text
    this.emit("transcript", text, isFinal)

    if (isFinal) {
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

      // When entering listening state, start audio capture
      if (state === "listening" && this.config.clientAudioCapture && this.isEnabled) {
        this.startAudioCapture()
      }

      // When leaving listening state, stop audio capture
      if (state !== "listening" && this.config.clientAudioCapture) {
        if (this.audioCapture?.isActive()) {
          this.audioCapture.stop()
          this.isCapturing = false
        }
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
