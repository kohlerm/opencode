/**
 * Sentence Detector
 * 
 * Accumulates streaming text and detects sentence boundaries for TTS scheduling.
 * Based on RCLI's C++ SentenceDetector implementation.
 */

export interface SentenceDetectorConfig {
  /** Minimum words for first sentence (lower for fast TTFA) */
  firstSentenceMinWords: number
  /** Minimum words for subsequent sentences */
  minWords: number
  /** Secondary boundary word threshold (for ; :) */
  maxWordsSecondary: number
  /** Word count to force flush if no punctuation found */
  wordFlushThreshold?: number
}

export class SentenceDetector {
  private buffer = ""
  private sentenceCount = 0
  private config: SentenceDetectorConfig

  constructor(config: Partial<SentenceDetectorConfig> = {}) {
    this.config = {
      firstSentenceMinWords: 1,
      minWords: 6,
      maxWordsSecondary: 35,
      wordFlushThreshold: 20,
      ...config,
    }
  }

  /**
   * Feed text into the detector. Calls callback for each complete sentence found.
   */
  feed(text: string, callback: (sentence: string) => void): void {
    this.buffer += text
    this.checkBoundaries(callback)
  }

  /**
   * Flush remaining buffer as a final sentence.
   */
  flush(callback: (sentence: string) => void): void {
    const trimmed = this.buffer.trim()
    if (trimmed) {
      callback(trimmed)
    }
    this.buffer = ""
    this.sentenceCount = 0
  }

  /**
   * Clear the buffer without emitting.
   */
  clear(): void {
    this.buffer = ""
    this.sentenceCount = 0
  }

  /**
   * Get current buffer content (for debugging).
   */
  getBuffer(): string {
    return this.buffer
  }

  /**
   * Check if detector has any buffered text.
   */
  hasContent(): boolean {
    return this.buffer.trim().length > 0
  }

  private checkBoundaries(callback: (sentence: string) => void): void {
    const minWords = this.sentenceCount === 0 ? this.config.firstSentenceMinWords : this.config.minWords

    let start = 0
    let i = 0

    while (i < this.buffer.length) {
      const char = this.buffer[i]

      // Primary boundaries: . ! ? \n (when followed by space, quote, or EOF)
      if (char === "." || char === "!" || char === "?" || char === "\n") {
        const next = this.buffer[i + 1]
        const isBoundary = !next || next === " " || next === "\"" || next === "'" || next === "\n"

        if (isBoundary) {
          const candidate = this.buffer.slice(start, i + 1).trim()
          const wordCount = this.countWords(candidate)

          if (wordCount >= minWords) {
            callback(candidate)
            start = i + 1
            this.sentenceCount++
          }
        }
      }

      // Secondary boundaries: ; : (only after many words to avoid false splits)
      if ((char === ";" || char === ":") && i > 0) {
        const candidate = this.buffer.slice(start, i + 1).trim()
        const wordCount = this.countWords(candidate)

        if (wordCount >= this.config.maxWordsSecondary!) {
          callback(candidate)
          start = i + 1
          this.sentenceCount++
        }
      }

      i++
    }

    // Keep remaining text in buffer
    this.buffer = this.buffer.slice(start)

    // Word-level flush: if we have too many words without punctuation, flush at last space
    const wordCount = this.countWords(this.buffer)
    const wordThreshold = this.sentenceCount === 0 ? Math.max(5, this.config.wordFlushThreshold!) : this.config.wordFlushThreshold!

    if (wordCount >= wordThreshold) {
      const lastSpace = this.buffer.lastIndexOf(" ")
      if (lastSpace > 0) {
        const candidate = this.buffer.slice(0, lastSpace).trim()
        if (candidate) {
          callback(candidate)
          this.buffer = this.buffer.slice(lastSpace + 1)
          this.sentenceCount++
        }
      }
    }
  }

  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length
  }
}

/**
 * Sanitize text for TTS by removing non-speakable content.
 */
export function sanitizeForTts(text: string): string {
  let result = text

  // 1. Strip <think> blocks (chain-of-thought reasoning)
  result = result.replace(/<think>.*?<\/think>/gs, "")

  // 2. Strip <tool_call> blocks
  result = result.replace(/<tool_call>.*?<\/tool_call>/gs, "")

  // 3. Strip remaining <...> tags
  result = result.replace(/<[^>]+>/g, "")

  // 4. Strip markdown links [text](url) -> text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  // 5. Strip markdown formatting
  result = result.replace(/[*~`#]/g, "") // Bold, italic, code, headings
  result = result.replace(/^>\s*/gm, "") // Block quotes
  result = result.replace(/^-\s*/gm, "") // Bullet points
  result = result.replace(/^---\s*$/gm, "") // Horizontal rules
  result = result.replace(/^\d+\.\s*/gm, "") // Numbered lists
  result = result.replace(/\/\/.*$/gm, "") // Double-slash comments

  // 6. Normalize quotes
  result = result.replace(/[\u2018\u2019]/g, "'") // Smart single quotes
  result = result.replace(/[\u201C\u201D]/g, '"') // Smart double quotes

  // 7. Expand common contractions (helps Kokoro TTS)
  const contractions: Record<string, string> = {
    "don't": "do not",
    "won't": "will not",
    "can't": "cannot",
    "isn't": "is not",
    "aren't": "are not",
    "wasn't": "was not",
    "weren't": "were not",
    "haven't": "have not",
    "hasn't": "has not",
    "hadn't": "had not",
    "wouldn't": "would not",
    "shouldn't": "should not",
    "couldn't": "could not",
    "I'm": "I am",
    "you're": "you are",
    "he's": "he is",
    "she's": "she is",
    "it's": "it is",
    "we're": "we are",
    "they're": "they are",
    "I've": "I have",
    "you've": "you have",
    "we've": "we have",
    "they've": "they have",
    "I'll": "I will",
    "you'll": "you will",
    "he'll": "he will",
    "she'll": "she will",
    "we'll": "we will",
    "they'll": "they will",
  }

  for (const [contraction, expansion] of Object.entries(contractions)) {
    const regex = new RegExp(`\\b${contraction.replace(/'/g, "'")}\\b`, "gi")
    result = result.replace(regex, expansion)
  }

  // 8. Collapse whitespace and trim
  result = result.replace(/\s+/g, " ").trim()

  return result
}
