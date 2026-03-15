/**
 * Voice Module Public API
 */

export { VoiceBridge, type VoiceBridgeConfig, type VoiceState, type VoiceBridgeEvents } from "./bridge"
export { RcliSocketClient, type SocketClientOptions } from "./socket-client"
export { SentenceDetector, sanitizeForTts, type SentenceDetectorConfig } from "./sentence-detector"
export { AudioCapture, type AudioCaptureOptions, type AudioChunk } from "./audio-capture"
export { WebRtcVad, type WebRtcVadOptions, type SpeechSegment } from "./webrtc-vad"
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
  AudioMessage,
} from "./protocol"
