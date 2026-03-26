/**
 * Voice Context for TUI
 *
 * SolidJS context for managing voice state in the TUI.
 * The VoiceBridge is only constructed when voice mode is enabled.
 * Uses Kyutai MLX streaming STT via streaming_stt_server.py.
 */

import { createContext, useContext, createSignal, createEffect, onCleanup } from "solid-js"
import type { Accessor, Setter, JSX } from "solid-js"
import { VoiceBridge, type VoiceState } from "../../../voice/bridge.js"
import { VoiceWyomingBridge } from "../../../voice/wyoming.js"
import { vlog } from "../../../voice/vlog.js"
import { useToast } from "@tui/ui/toast"

export type { VoiceState }
type Bridge = VoiceBridge | VoiceWyomingBridge

export interface VoiceContextValue {
  /** Whether voice mode is enabled */
  isEnabled: Accessor<boolean>
  /** Toggle voice mode */
  setEnabled: Setter<boolean>
  /** Current voice state */
  state: Accessor<VoiceState>
  /** Current audio level (0-1) */
  audioLevel: Accessor<number>
  /** Whether VAD detects speech */
  isSpeech: Accessor<boolean>
  /** Last transcript text */
  lastTranscript: Accessor<string>
  /** Whether bridge is connected */
  isConnected: Accessor<boolean>
  /** The voice bridge instance (for direct access) */
  bridge: Accessor<Bridge | null>
  /** Streaming transcript (partial, in-progress) — null when idle */
  streamingTranscript: Accessor<string | null>
}

const VoiceContext = createContext<VoiceContextValue>()

export function VoiceProvider(props: { children: JSX.Element }) {
  const toast = useToast()
  const [isEnabled, setEnabled] = createSignal(false)
  const [state, setState] = createSignal<VoiceState>("idle")
  const [audioLevel, setAudioLevel] = createSignal(0)
  const [isSpeech, setIsSpeech] = createSignal(false)
  const [lastTranscript, setLastTranscript] = createSignal("")
  const [isConnected, setIsConnected] = createSignal(false)
  const [bridge, setBridge] = createSignal<Bridge | null>(null)
  const [streamingTranscript, setStreamingTranscript] = createSignal<string | null>(null)

  let current: Bridge | null = null
  let runs = 0

  createEffect(() => {
    const enabled = isEnabled()
    runs++
    vlog("VoiceCtx", `createEffect run #${runs}, isEnabled=${enabled}, hasBridge=${!!current}`)

    if (!enabled) {
      if (current) {
        vlog("VoiceCtx", "Tearing down bridge (isEnabled=false)")
        current.stop()
        current = null
        setBridge(null)
        setIsConnected(false)
        setState("idle")
        setStreamingTranscript(null)
      }
      return
    }

    const mode = (process.env.OPENCODE_STT_BACKEND ?? "").toLowerCase()
    const b =
      mode === "wyoming"
        ? new VoiceWyomingBridge({
            uri: process.env.OPENCODE_WYOMING_URI ?? "tcp://127.0.0.1:10301",
            language: process.env.OPENCODE_STT_LANGUAGE ?? "en",
            silenceMs: (() => {
              const n = Number(process.env.OPENCODE_WYOMING_SILENCE_MS)
              return Number.isFinite(n) && n > 0 ? n : 1250
            })(),
            timeoutMs: (() => {
              const n = Number(process.env.OPENCODE_WYOMING_TIMEOUT_MS)
              return Number.isFinite(n) && n > 0 ? n : 15000
            })(),
          })
        : new VoiceBridge({
            sttServerPath:
              process.env.OPENCODE_STT_SERVER ??
              `${process.env.HOME}/parakeet-mlx/kyutai-mlx/python/streaming_stt_server.py`,
            python: process.env.OPENCODE_PYTHON ?? "python3",
            // Default model picks candle when vad is on (see VoiceBridge) so Kyutai emits end_of_turn; pure -mlx has no VAD heads.
            vad: process.env.OPENCODE_STT_VAD === "1",
          })
    vlog("VoiceCtx", `backend=${mode === "wyoming" ? "wyoming" : "stdio"}`)
    current = b
    setBridge(b)

    b.on("connect", () => {
      vlog("VoiceCtx", "Bridge connected!")
      setIsConnected(true)
    })

    b.on("disconnect", () => {
      vlog("VoiceCtx", "Bridge disconnected!")
      setIsConnected(false)
      setStreamingTranscript(null)
    })

    b.on("stateChange", (s: VoiceState) => {
      vlog("VoiceCtx", `State change: ${s}`)
      setState(s)
    })

    b.on("audioLevel", (level: number, speech: boolean) => {
      setAudioLevel(level)
      setIsSpeech(speech)
    })

    b.on("transcript", (text: string, isFinal: boolean) => {
      vlog("VoiceCtx", `Transcript (final=${isFinal}): ${text}`)
      if (isFinal) {
        setLastTranscript(text.trim())
        setStreamingTranscript(null)
      } else {
        // Append token to streaming transcript
        setStreamingTranscript((prev) => (prev ?? "") + text)
      }
    })

    const onErr = (err: Error) => {
      vlog("VoiceCtx", `Bridge error: ${err.message}`)
      toast.show({ variant: "error", message: err.message, duration: 6000 })
    }
    b.on("error", onErr)

    b.start().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      vlog("VoiceCtx", `Failed to start voice bridge: ${msg}`)
      toast.show({ variant: "error", message: msg, duration: 8000 })
      if (current === b) {
        b.off("error", onErr)
        b.stop()
        current = null
        setBridge(null)
        setIsConnected(false)
        setState("idle")
        setStreamingTranscript(null)
      }
      setEnabled(false)
    })

    onCleanup(() => {
      b.off("error", onErr)
    })
  })

  onCleanup(() => {
    vlog("VoiceCtx", "VoiceProvider onCleanup (unmount)")
    if (current) {
      current.stop()
      current = null
    }
  })

  const value: VoiceContextValue = {
    isEnabled,
    setEnabled,
    state,
    audioLevel,
    isSpeech,
    lastTranscript,
    isConnected,
    bridge,
    streamingTranscript,
  }

  return <VoiceContext.Provider value={value}>{props.children}</VoiceContext.Provider>
}

export function useVoice() {
  const context = useContext(VoiceContext)
  if (!context) {
    throw new Error("useVoice must be used within a VoiceProvider")
  }
  return context
}
