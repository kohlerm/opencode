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
}

export type BridgeMessage = ToggleMessage | SpeakMessage | InterruptMessage | ConfigMessage
