/**
 * Voice Module Public API
 */

export { VoiceBridge, type VoiceBridgeConfig, type VoiceState, type VoiceBridgeEvents } from "./bridge"
export { RcliSocketClient, type SocketClientOptions } from "./socket-client"
export { SentenceDetector, sanitizeForTts, type SentenceDetectorConfig } from "./sentence-detector"
export type {
  RcliMessage,
  BridgeMessage,
  TranscriptMessage,
  StateMessage,
  AudioLevelMessage,
  BargeInMessage,
  ErrorMessage,
  ToggleMessage,
  SpeakMessage,
  InterruptMessage,
  ConfigMessage,
} from "./protocol"
