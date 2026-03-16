/**
 * Voice Module Public API
 */

export { VoiceBridge, type VoiceBridgeConfig, type VoiceState, type VoiceBridgeEvents } from "./bridge"
export { RcliSocketClient, type SocketClientOptions } from "./socket-client"
export { SentenceDetector, sanitizeForTts, type SentenceDetectorConfig } from "./sentence-detector"
export { EnergyVad, type EnergyVadOptions, type SpeechSegment } from "./energy-vad"
export type {
  RcliMessage,
  BridgeMessage,
  TranscriptMessage,
  StateMessage,
  AudioLevelMessage,
  AudioChunkMessage,
  BargeInMessage,
  ErrorMessage,
  ToggleMessage,
  SpeakMessage,
  InterruptMessage,
  ConfigMessage,
  AudioFinalMessage,
} from "./protocol"
