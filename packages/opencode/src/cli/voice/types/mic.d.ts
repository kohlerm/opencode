/**
 * Type declarations for mic package
 */

declare module "mic" {
  import { EventEmitter } from "events"

  interface MicOptions {
    /** Sample rate (e.g., "16000") */
    rate?: string
    /** Number of channels (e.g., "1") */
    channels?: string
    /** Bit width (e.g., "16") */
    bitwidth?: string
    /** Audio device */
    device?: string
    /** Exit on silence duration */
    exitOnSilence?: number
    /** Debug mode */
    debug?: boolean
    /** File type */
    fileType?: string
  }

  interface MicInstance {
    /** Start recording */
    start(): void
    /** Stop recording */
    stop(): void
    /** Pause recording */
    pause(): void
    /** Resume recording */
    resume(): void
    /** Get the audio stream */
    getAudioStream(): NodeJS.ReadableStream
  }

  function mic(options?: MicOptions): MicInstance

  export = mic
}
