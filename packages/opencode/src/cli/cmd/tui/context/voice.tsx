/**
 * Voice Context for TUI
 * 
 * SolidJS context for managing voice state in the TUI.
 * The VoiceBridge is only constructed when voice mode is enabled (Ctrl+V),
 * so no socket connections are attempted until the user explicitly toggles voice.
 */

import { createContext, useContext, createSignal, createEffect, onCleanup } from "solid-js"
import type { Accessor, Setter, JSX } from "solid-js"
import { VoiceBridge, type VoiceState } from "../../../voice/bridge.js"
import { vlog } from "../../../voice/vlog.js"

export type { VoiceState }

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
  bridge: Accessor<VoiceBridge | null>
}

const VoiceContext = createContext<VoiceContextValue>()

export function VoiceProvider(props: {
  children: JSX.Element
}) {
  const [isEnabled, setEnabled] = createSignal(false)
  const [state, setState] = createSignal<VoiceState>("idle")
  const [audioLevel, setAudioLevel] = createSignal(0)
  const [isSpeech, setIsSpeech] = createSignal(false)
  const [lastTranscript, setLastTranscript] = createSignal("")
  const [isConnected, setIsConnected] = createSignal(false)
  const [bridge, setBridge] = createSignal<VoiceBridge | null>(null)

  let currentBridge: VoiceBridge | null = null
  let effectRunCount = 0

  // Lazily connect to RCLI when voice is enabled
  createEffect(() => {
    const enabled = isEnabled()
    effectRunCount++
    vlog("VoiceCtx", `createEffect run #${effectRunCount}, isEnabled=${enabled}, hasBridge=${!!currentBridge}`)

    if (!enabled) {
      // Tear down bridge when disabled
      if (currentBridge) {
        vlog("VoiceCtx", "Tearing down bridge (isEnabled=false)")
        currentBridge.stop()
        currentBridge = null
        setBridge(null)
        setIsConnected(false)
        setState("idle")
      }
      return
    }

    // Build config from defaults (voice config from opencode config may not exist yet)
    const voiceConfig = {
      enabled: true,
      keybind: "ctrl+v",
      rcliPath: "../../rcli/build/rcli",
      socketPath: "~/.opencode/rcli-voice.sock",
      stt: { model: "zipformer" as const, language: "en" },
      tts: { model: "kokoro-en" as const, speed: 1.0 },
      vad: { threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25 },
      permissions: {
        voiceConfirm: true,
        autoApprove: ["read", "glob"],
        requireConfirm: ["write", "edit", "bash"],
      },
      ui: {
        overlayPosition: "bottom" as const,
        showWaveform: true,
        showTranscript: true,
        transcriptTimeout: 3000,
      },
    }

    const bridgeConfig = {
      rcliPath: voiceConfig.rcliPath,
      socketPath: voiceConfig.socketPath,
      serverUrl: "http://localhost:4096",
      directory: process.cwd(),
      voiceConfig,
      // Enable client-side audio capture with WebRTC VAD
      clientAudioCapture: true,
      vadAggressiveness: 3,
    }

    const newBridge = new VoiceBridge(bridgeConfig)
    currentBridge = newBridge
    setBridge(newBridge)

    newBridge.on("connect", () => {
      vlog("VoiceCtx", "Bridge connected! Sending toggle(true)")
      setIsConnected(true)
      // Start STT capture now that we're connected
      newBridge.toggle(true)
    })

    newBridge.on("disconnect", () => {
      vlog("VoiceCtx", "Bridge disconnected!")
      setIsConnected(false)
    })

    newBridge.on("stateChange", (newState: VoiceState) => {
      vlog("VoiceCtx", `State change: ${newState}`)
      setState(newState)
    })

    newBridge.on("audioLevel", (level: number, speech: boolean) => {
      setAudioLevel(level)
      setIsSpeech(speech)
    })

    newBridge.on("transcript", (text: string, isFinal: boolean) => {
      vlog("VoiceCtx", `Transcript (final=${isFinal}): ${text}`)
      const trimmed = text.trim()
      if (isFinal) {
        setLastTranscript(trimmed)
        return
      }

      // Suppress noisy micro-partials (single letters / fragments).
      // Keep overlay stable and rely on finals for correctness.
      if (trimmed.length <= 2) return
      if (trimmed.length < 5 && !trimmed.includes(" ")) return

      setLastTranscript(trimmed)
    })

    newBridge.start().catch((err: unknown) => {
      vlog("VoiceCtx", `Failed to start voice bridge: ${err}`)
      // Don't disable — user might want to see the disconnected state
    })
  })

  // Cleanup on unmount
  onCleanup(() => {
    vlog("VoiceCtx", "VoiceProvider onCleanup (unmount)")
    if (currentBridge) {
      currentBridge.stop()
      currentBridge = null
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
