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

export type RcliMessage =
  | TranscriptMessage
  | StateMessage
  | AudioLevelMessage
  | BargeInMessage
  | ErrorMessage

// ============================================================================
// Bridge → RCLI messages (from OpenCode to voice proxy)
// ============================================================================

export interface ToggleMessage {
  type: "toggle"
  enabled: boolean
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
 * Audio data message - sent from OpenCode to RCLI when clientAudioCapture is enabled.
 * Audio data is base64-encoded PCM16 mono at 16000 Hz.
 */
export interface AudioMessage {
  type: "audio"
  /** Base64-encoded PCM16 audio data */
  data: string
  /** Sample rate in Hz (typically 16000) */
  sampleRate: number
  /** Whether this is the final chunk of a speech segment */
  isFinal: boolean
  /** Timestamp in ms */
  timestamp?: number
}

export type BridgeMessage = ToggleMessage | SpeakMessage | InterruptMessage | ConfigMessage | AudioMessage
