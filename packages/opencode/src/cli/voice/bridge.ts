/**
 * Voice Bridge
 * 
 * Main bridge component that connects RCLI voice proxy with OpenCode.
 * Manages the RCLI process, handles socket communication, and translates
 * between protocols.
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { RcliSocketClient } from "./socket-client"
import { SentenceDetector, sanitizeForTts } from "./sentence-detector"
import type { RcliMessage, BridgeMessage } from "./protocol"
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
  private config: VoiceBridgeConfig
  private rcliProcess: ChildProcess | null = null
  private socket: RcliSocketClient
  private sentenceDetector: SentenceDetector

  private state: VoiceState = "idle"
  private sessionID: string | null = null
  private isEnabled = false
  private ttsQueue: string[] = []
  private isSpeaking = false
  private audioLevel = 0
  private isSpeech = false
  private lastTranscript = ""

  constructor(config: VoiceBridgeConfig) {
    super()
    vlog("Bridge", `constructor called, socketPath=${config.socketPath}`)
    this.config = config
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
    })

    this.socket.on("message", (msg: RcliMessage) => {
      this.handleRcliMessage(msg)
    })

    this.socket.on("error", (err: Error) => {
      this.emit("error", err)
    })
  }

  /**
   * Start the voice bridge by connecting to RCLI proxy.
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
    } catch (err) {
      vlog("Bridge", `Failed to connect to RCLI proxy: ${err}`)
      throw err
    }
  }

  /**
   * Stop the voice bridge and cleanup.
   */
  stop(): void {
    vlog("Bridge", "stop() called")
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

    if (!enabled) {
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
        this.audioLevel = msg.level
        this.isSpeech = msg.isSpeech
        this.emit("audioLevel", msg.level, msg.isSpeech)
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

    if (isFinal && this.sessionID) {
      // Send to OpenCode via SDK
      this.sendToOpencode(text)
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
    }
    this.send(config)
  }
}
