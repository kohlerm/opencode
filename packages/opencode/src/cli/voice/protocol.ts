/**
 * Voice Protocol Types
 *
 * JSON line protocol for communication between OpenCode and RCLI voice proxy
 * via Unix domain socket.
 */

// ============================================================================
// RCLI → Bridge messages (from voice proxy to OpenCode)
// ============================================================================

export interface TranscriptMessage {
  type: "transcript"
  text: string
  isFinal: boolean
  confidence?: number
}

export interface StateMessage {
  type: "state"
  state: "idle" | "listening" | "processing" | "speaking" | "interrupted"
}

export interface AudioLevelMessage {
  type: "audio_level"
  level: number
  isSpeech: boolean
}

export interface BargeInMessage {
  type: "barge_in"
  transcript?: string
}

export interface ErrorMessage {
  type: "error"
  code: string
  message: string
}

/**
 * Audio chunk from RCLI CoreAudio capture — sent to OpenCode for client-side VAD.
 * Base64-encoded PCM16 mono at 16000 Hz.
 */
export interface AudioChunkMessage {
  type: "audio_chunk"
  /** Base64-encoded PCM16 audio data */
  data: string
  /** Number of float32 samples (before PCM16 encoding) */
  samples: number
}

export type RcliMessage =
  | TranscriptMessage
  | StateMessage
  | AudioLevelMessage
  | BargeInMessage
  | ErrorMessage
  | AudioChunkMessage

// ============================================================================
// Bridge → RCLI messages (from OpenCode to voice proxy)
// ============================================================================

export interface ToggleMessage {
  type: "toggle"
  enabled: boolean
  /** When true, client handles mic/VAD; RCLI should not open CoreAudio */
  clientAudioCapture?: boolean
}

export interface SpeakMessage {
  type: "speak"
  text: string
  priority?: "normal" | "interrupt"
}

export interface InterruptMessage {
  type: "interrupt"
}

export interface ConfigMessage {
  type: "config"
  ttsVoice?: string
  sttModel?: string
  vadThreshold?: number
  /** When true, OpenCode handles audio capture and VAD; RCLI only does STT */
  clientAudioCapture?: boolean
}

/**
 * Complete speech segment for offline STT (Parakeet TDT / Whisper).
 * Sent when EnergyVad detects speech end. Contains the full utterance audio.
 */
export interface AudioFinalMessage {
  type: "audio_final"
  /** Base64-encoded PCM16 audio data (complete utterance) */
  data: string
  /** Sample rate in Hz (typically 16000) */
  sampleRate: number
  /** Always true for final segments */
  isFinal: true
  /** Timestamp in ms */
  timestamp?: number
}

export type BridgeMessage = ToggleMessage | SpeakMessage | InterruptMessage | ConfigMessage | AudioFinalMessage
