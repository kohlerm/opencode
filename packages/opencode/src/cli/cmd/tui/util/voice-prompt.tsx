import { createEffect } from "solid-js"
import type { PromptRef } from "@tui/component/prompt"
import type { VoiceContextValue } from "@tui/context/voice"

export function isVoiceStopCommand(text: string): boolean {
  const cmd = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
  if (!cmd) return false
  if (cmd.includes("never mind")) return true
  const words = cmd.split(" ")
  return words.includes("stop") || words.includes("cancel") || words.includes("abort") || words.includes("halt")
}

/** Append partial STT tokens into the prompt field while the user is speaking. */
export function useVoiceStreamingAppend(prompt: () => PromptRef | undefined, voice: VoiceContextValue) {
  let last: string | null = null
  createEffect(() => {
    const text = voice.streamingTranscript()
    if (text === null) {
      last = null
      return
    }
    const p = prompt()
    if (!p) return
    const delta = last === null ? text : text.slice(last.length)
    last = text
    if (delta) {
      const current = p.current.input
      p.set({ input: current + delta, parts: [] })
    }
  })
}
