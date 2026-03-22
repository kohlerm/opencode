/**
 * Voice Overlay Component
 *
 * Shows voice mode status in the TUI.
 * Only renders when voice mode is enabled via Ctrl+V.
 */

import { Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useVoice } from "../context/voice"

export function VoiceOverlay() {
  const { theme } = useTheme()
  const voice = useVoice()

  const stateLabel = createMemo(() => {
    switch (voice.state()) {
      case "starting":
        return "Starting..."
      case "listening":
        return "Listening..."
      case "processing":
        return "Processing..."
      case "speaking":
        return "Speaking..."
      case "interrupted":
        return "Interrupted"
      default:
        return "Voice Ready"
    }
  })

  const shortTranscript = createMemo(() => {
    const t = voice.lastTranscript()
    if (!t) return ""
    const words = t.trim().split(/\s+/)
    return (words.length > 4 ? "... " : "") + words.slice(-4).join(" ")
  })

  const stateColor = createMemo(() => {
    switch (voice.state()) {
      case "starting":
        return theme.textMuted
      case "listening":
        return theme.success
      case "processing":
        return theme.warning
      case "speaking":
        return theme.info
      case "interrupted":
        return theme.error
      default:
        return theme.textMuted
    }
  })

  return (
    <Show when={voice.isEnabled()}>
      <box
        position="absolute"
        bottom={2}
        right={2}
        borderStyle="single"
        borderColor={stateColor()}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundPanel}
        zIndex={9999}
      >
        <text fg={stateColor()} attributes={TextAttributes.BOLD}>
          MIC {stateLabel()}
          <Show when={voice.isConnected()}>
            <span style={{ fg: theme.success }}> *</span>
          </Show>
          <Show when={!voice.isConnected()}>
            <span style={{ fg: theme.textMuted }}> (disconnected)</span>
          </Show>
        </text>
        <Show when={shortTranscript()}>
          <text fg={theme.text}>{shortTranscript()}</text>
        </Show>
      </box>
    </Show>
  )
}

export function VoiceIndicator() {
  const voice = useVoice()
  return (
    <Show when={voice.isEnabled()}>
      <text>MIC ON</text>
    </Show>
  )
}
