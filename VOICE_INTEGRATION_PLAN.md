# Voice Integration Plan: RCLI + OpenCode

## Overview

This document describes how to integrate the RCLI on-device voice pipeline (STT + TTS) with OpenCode's AI coding assistant. This enables hands-free voice interaction with OpenCode, including interrupt/barge-in support.

**Related Projects:**
- **RCLI** (the voice pipeline): `../..` from this directory
- **OpenCode** (this project): Current directory

---

## Architecture

### Integration Approach: Sidecar Process with Unix Socket

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER INTERACTION                                   │
│                                                                              │
│   ┌──────────────┐          ┌──────────────┐          ┌──────────────┐       │
│   │   Keyboard   │          │  Microphone  │          │   Speaker    │       │
│   └──────┬───────┘          └──────┬───────┘          └──────┬───────┘       │
│          │                         │                         │               │
│          │ Toggle Voice Mode       │ Capture audio           │ Play audio    │
│          │ (Ctrl+V)                │ (16kHz PCM)             │ (24kHz PCM)   │
│          │                         │                         │               │
└──────────┼─────────────────────────┼─────────────────────────┼───────────────┘
           │                         │                         │
           ▼                         │                         ▼
┌──────────────────────┐            │            ┌──────────────────────┐
│   OpenCode TUI       │            │            │   RCLI Proxy         │
│   (TypeScript/Bun)   │            │            │   (C++17)            │
│                      │            │            │                      │
│  ┌─────────────────┐ │            │            │  ┌─────────────────┐ │
│  │ Voice Overlay   │ │◄───────────┼────────────┼──┤ Audio Level     │ │
│  │ (mic waveform)  │ │            │            │  └─────────────────┘ │
│  └─────────────────┘ │            │            │                      │
│                      │            │            │  ┌─────────────────┐ │
│  ┌─────────────────┐ │◄───────────┴────────────┼──┤ VAD → STT       │ │
│  │ Keybind Handler │ │   Socket Protocol       │  │ (Zipformer)     │ │
│  │ (Ctrl+V toggle) │ │   JSON lines            │  └─────────────────┘ │
│  └─────────────────┘ │                         │                      │
│                      │                         │  ┌─────────────────┐ │
│  ┌─────────────────┐ │────────────────────────►│  │ TTS → Speaker   │ │
│  │ SSE Event       │ │  1. POST /session/:id/  │  │ (Kokoro/Piper)  │ │
│  │ Listener        │ │     /prompt_async       │  └─────────────────┘ │
│  │                 │ │                         │                      │
│  │ Listens for:    │ │  2. POST /session/:id/  │  ┌─────────────────┐ │
│  │ - message.part. │ │     /abort (barge-in)   │  │ Socket Server   │ │
│  │   delta         │ │                         │  │ (Unix domain)   │ │
│  │ - permission.   │ │  HTTP + SSE             │  └─────────────────┘ │
│  │   asked         │ │  (OpenCode Server)      │                      │
│  └─────────────────┘ │                         └──────────────────────┘
└──────────────────────┘                                    │
           │                                                │
           ▼                                                ▼
┌──────────────────────┐                         ┌──────────────────────┐
│  OpenCode Server     │                         │  RCLI Socket Bridge  │
│  (Hono HTTP/SSE)     │                         │  (stdio ↔ socket)    │
│                      │                         │                      │
│  Routes:             │                         │  Translates between  │
│  - POST /session/    │                         │  socket JSON and     │
│    :id/prompt_async  │                         │  RCLI C API calls    │
│  - POST /session/    │                         └──────────────────────┘
│    :id/abort         │
│  - GET /event (SSE)  │
│                      │
└──────────────────────┘
```

---

## Components

### 1. RCLI Proxy Mode (New C++ Component)

**Location:** `../..` (RCLI project root)

**Purpose:** Acts as a pure STT+TTS bridge, forwarding transcribed text to OpenCode and speaking responses.

**New Files:**
```
src/cli/cmd_proxy.cpp          # Main proxy command implementation
src/cli/cmd_proxy.h            # Header
src/pipeline/socket_protocol.h # JSON protocol definitions
```

**Communication:** Unix domain socket at `~/.opencode/rcli-voice.sock`

**Protocol:** JSON line protocol over socket

**State Machine:**
```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
                    ▼                                             │
┌────────┐    ┌─────────┐    ┌──────────┐    ┌──────────┐        │
│  INIT  │───►│  IDLE   │───►│ LISTENING│───►│   STT    │        │
└────────┘    └────┬────┘    └──────────┘    └────┬─────┘        │
                   │                              │              │
                   │ { "type": "toggle" }         │ { "type": "transcript",
                   │                              │   "text": "..." }
                   │                              ▼              │
                   │                         ┌──────────┐        │
                   │                         │  AWAIT   │        │
                   │                         │  LLM     │        │
                   │                         └────┬─────┘        │
                   │                              │              │
                   │ { "type": "llm_delta",        │ { "type": "speak",
                   │   "text": "..." }             │   "text": "..." }
                   │                              ▼              │
                   │                         ┌──────────┐        │
                   │                         │  TTS     │────────┘
                   │                         │ SPEAKING │  Barge-in
                   │                         └──────────┘  (VAD detects
                   │                                         speech)
                   │
                   │ { "type": "interrupt" }
                   ▼
              ┌──────────┐
              │ INTERRUPT│
              └──────────┘
```

---

### 2. OpenCode Voice Bridge (New TypeScript Component)

**Location:** `packages/opencode/src/cli/voice/`

**Purpose:** Manages the RCLI process, translates between RCLI socket protocol and OpenCode HTTP API.

**New Files:**
```
packages/opencode/src/cli/voice/
├── bridge.ts          # Main bridge logic
├── socket-client.ts   # Unix socket client for RCLI
├── protocol.ts        # Protocol types and message builders
├── state-machine.ts   # Voice state management
└── index.ts           # Public API

packages/opencode/src/cli/cmd/voice.ts    # CLI command

packages/opencode/src/cli/cmd/tui/component/
├── voice-overlay.tsx   # TUI overlay component
└── voice-indicator.tsx # Mic level indicator
```

---

### 3. OpenCode TUI Integration (Modifications)

**Files to Modify:**
```
packages/opencode/src/cli/cmd/tui/
├── app.tsx                      # Add voice command registration
├── context/keybind.tsx          # Add Ctrl+V keybind
├── routes/session/index.tsx     # Add voice overlay rendering
└── component/dialog-status.tsx  # Add voice status section
```

---

## Protocol Specification

### Socket Protocol (RCLI ↔ Voice Bridge)

**Transport:** Unix domain socket at `~/.opencode/rcli-voice.sock`

**Format:** JSON lines (newline-delimited JSON)

#### Messages: Bridge → RCLI

```typescript
// Toggle voice mode on/off
type ToggleMessage = {
  type: "toggle";
  enabled: boolean;      // true = start listening, false = stop
};

// Request to speak text
type SpeakMessage = {
  type: "speak";
  text: string;          // Text to synthesize and speak
  priority?: "normal" | "interrupt";  // interrupt = clear queue first
};

// Stop speaking immediately
type InterruptMessage = {
  type: "interrupt";
};

// Configuration update
type ConfigMessage = {
  type: "config";
  ttsVoice?: string;     // e.g., "kokoro-en", "piper-lessac"
  sttModel?: string;     // e.g., "zipformer"
  vadThreshold?: number; // 0.0 - 1.0, default 0.5
};
```

#### Messages: RCLI → Bridge

```typescript
// Transcription result from STT
type TranscriptMessage = {
  type: "transcript";
  text: string;          // The transcribed text
  isFinal: boolean;      // true = endpoint detected, false = interim
  confidence?: number;   // 0.0 - 1.0
};

// State change notification
type StateMessage = {
  type: "state";
  state: "idle" | "listening" | "processing" | "speaking" | "interrupted";
};

// Audio level for TUI visualization
type AudioLevelMessage = {
  type: "audio_level";
  level: number;         // RMS level 0.0 - 1.0
  isSpeech: boolean;     // VAD detection result
};

// Barge-in detected (user spoke while TTS playing)
type BargeInMessage = {
  type: "barge_in";
  transcript?: string;   // Optional: partial transcript of interruption
};

// Error notification
type ErrorMessage = {
  type: "error";
  code: string;
  message: string;
};
```

---

## User Experience

### Voice Mode Toggle

**Keybind:** `Ctrl+V` (configurable in `opencode.json`)

**Visual Feedback:**
- When voice mode is OFF: Status bar shows `🔇 Voice` (muted microphone icon)
- When voice mode is ON: Status bar shows `🎤 Voice ON` with animated mic level bars
- Voice overlay panel appears at bottom of TUI showing:
  - Real-time audio waveform
  - Current state (Listening / Processing / Speaking)
  - Last transcription (fades after 3 seconds)

### Workflow

1. **User presses Ctrl+V** → Voice mode enabled
   - RCLI starts listening (mic active, VAD monitoring)
   - TUI shows overlay with waveform

2. **User speaks** → "Create a React component for a button"
   - VAD detects speech start
   - Zipformer STT transcribes in real-time
   - Overlay shows interim text
   - VAD detects speech end (silence)
   - RCLI sends `{ type: "transcript", text: "...", isFinal: true }`

3. **Bridge sends to OpenCode:**
   ```
   POST /session/:id/prompt_async
   Body: { parts: [{ type: "text", text: "Create a React component for a button" }] }
   ```

4. **OpenCode streams response via SSE:**
   - Bridge receives `message.part.delta` events
   - Accumulates text until sentence boundary detected
   - Sends `{ type: "speak", text: "Here's a React button component:" }`

5. **RCLI speaks:**
   - TTS synthesizes (Kokoro/Piper)
   - Audio plays via CoreAudio
   - Overlay shows "Speaking..." with progress bar

6. **Barge-in handling:**
   - While speaking, VAD continues monitoring
   - If user speaks louder than playback: barge-in triggers
   - RCLI sends `{ type: "barge_in" }`
   - Bridge calls `POST /session/:id/abort`
   - TTS stops immediately, mic reactivates
   - User's new command is transcribed

7. **Permission prompts:**
   - If OpenCode asks for permission (e.g., "Allow editing package.json?")
   - Bridge receives `permission.asked` SSE event
   - TTS reads: "Permission request: Allow editing package.json? Say yes or no."
   - RCLI listens for "yes", "allow", "no", "reject"
   - Bridge sends `POST /permission/:id/reply` with response

---

## Configuration

### New opencode.json Schema

```json
{
  "voice": {
    "enabled": true,
    "keybind": "ctrl+v",
    "rcliPath": "../../rcli/build/rcli",
    "socketPath": "~/.opencode/rcli-voice.sock",
    "stt": {
      "model": "zipformer",
      "language": "en"
    },
    "tts": {
      "model": "kokoro-en",
      "voice": "af_sarah",
      "speed": 1.0
    },
    "vad": {
      "threshold": 0.5,
      "minSilenceDuration": 0.5,
      "minSpeechDuration": 0.25
    },
    "permissions": {
      "voiceConfirm": true,
      "autoApprove": ["read", "glob"],
      "requireConfirm": ["write", "edit", "bash"]
    },
    "ui": {
      "overlayPosition": "bottom",
      "showWaveform": true,
      "showTranscript": true,
      "transcriptTimeout": 3000
    }
  }
}
```

### Implementation Note: Schema Extension

The OpenCode config schema uses `.strict()` which rejects unknown keys. To add the `voice` section:

**File:** `packages/opencode/src/config/config.ts`

**Change:** Around line 1200, add `voice` property to `Config.Info` Zod schema:

```typescript
Config.Info = z.object({
  // ... existing fields ...
  voice: z.object({
    enabled: z.boolean().optional(),
    keybind: z.string().optional(),
    rcliPath: z.string().optional(),
    // ... nested schemas for stt, tts, vad, permissions, ui
  }).optional(),
}).strict();
```

---

## Implementation Phases

### Phase 1: RCLI Proxy Mode

**Goal:** Create a standalone RCLI command that runs STT+TTS over a socket.

**Tasks:**
1. Create `src/cli/cmd_proxy.cpp/h` with proxy command implementation
2. Implement Unix domain socket server in proxy
3. Implement JSON protocol encoder/decoder
4. Wire up existing VAD, STT, TTS engines to protocol
5. Add main.cpp dispatch for `rcli proxy` subcommand
6. Test with netcat: `echo '{"type":"toggle","enabled":true}' | nc -U ~/.opencode/rcli-voice.sock`

**Testing:**
```bash
cd ../..
mkdir -p build && cd build
cmake .. && make -j$(sysctl -n hw.ncpu)
./rcli proxy --socket ~/.opencode/rcli-voice.sock --tts-model kokoro-en

# In another terminal:
echo '{"type":"toggle","enabled":true}' | nc -U ~/.opencode/rcli-voice.sock
# Speak, then:
echo '{"type":"speak","text":"Hello from OpenCode"}' | nc -U ~/.opencode/rcli-voice.sock
```

---

### Phase 2: OpenCode Voice Bridge

**Goal:** TypeScript bridge that manages RCLI process and translates protocols.

**Tasks:**
1. Create `packages/opencode/src/cli/voice/` directory structure
2. Implement Unix socket client (`socket-client.ts`)
3. Define protocol types (`protocol.ts`)
4. Implement state machine (`state-machine.ts`)
5. Create bridge that:
   - Spawns RCLI proxy process
   - Connects to socket
   - Translates RCLI messages to OpenCode SDK calls
   - Subscribes to OpenCode SSE and forwards to RCLI
6. Handle permission prompts via voice confirmation
7. Implement barge-in detection and abort propagation

**Key Code Structure:**
```typescript
// bridge.ts
export class VoiceBridge {
  private rcliProcess: Subprocess;
  private socket: UnixSocket;
  private state: VoiceState;
  private openCode: OpencodeClient;
  
  async start(): Promise<void> {
    // Spawn RCLI proxy
    // Connect to socket
    // Start SSE subscription
  }
  
  async onRcliMessage(msg: RcliMessage): Promise<void> {
    switch (msg.type) {
      case "transcript":
        await this.sendToOpencode(msg.text);
        break;
      case "barge_in":
        await this.abortCurrentSession();
        break;
    }
  }
  
  async onSseEvent(event: Event): Promise<void> {
    switch (event.type) {
      case "message.part.delta":
        await this.queueForTts(event.properties.delta);
        break;
      case "permission.asked":
        await this.handlePermissionViaVoice(event);
        break;
    }
  }
}
```

---

### Phase 3: TUI Integration

**Goal:** Add voice controls and overlay to the OpenCode TUI.

**Tasks:**
1. Add `voice` keybind to default keybinds (`config.ts`)
2. Create `VoiceOverlay` component with:
   - Audio waveform visualization (using `rcli_get_audio_level` data)
   - State indicator (Listening/Processing/Speaking)
   - Transcript display area
3. Create `VoiceIndicator` component for status bar
4. Modify `app.tsx`:
   - Register voice toggle command
   - Add voice bridge initialization
5. Modify `session/index.tsx`:
   - Render voice overlay when voice mode enabled
6. Modify `context/keybind.tsx`:
   - Handle voice toggle keybind

**VoiceOverlay Component:**
```tsx
// voice-overlay.tsx
export function VoiceOverlay(props: { sessionID: string }) {
  const voice = useVoiceContext();
  
  return (
    <box borderStyle="single" borderColor={voice.isListening ? "green" : "gray"}>
      <text>
        {voice.isListening ? "🎤 Listening..." : 
         voice.isSpeaking ? "🔊 Speaking..." : "🔇 Voice Ready"}
      </text>
      <AudioWaveform level={voice.audioLevel} />
      <FadeText text={voice.lastTranscript} timeout={3000} />
    </box>
  );
}
```

---

### Phase 4: Sentence Detection & Streaming TTS

**Goal:** Stream LLM tokens into sentences for responsive TTS.

**Tasks:**
1. Port RCLI's `SentenceDetector` to TypeScript (or implement equivalent)
2. In bridge, accumulate LLM deltas and detect sentence boundaries
3. When sentence is complete, send to RCLI TTS immediately
4. While sentence is being spoken, continue accumulating next sentence
5. Implement double-buffered TTS queue

**Sentence Detection Rules:**
- Break on `. `, `! `, `? `, `\n` followed by space or EOF
- First sentence: min 1 word (for fast response)
- Subsequent: min 6 words
- Fallback: flush at 20 words even without punctuation
- Strip `<think>` blocks, `<tool_call>` tags, markdown formatting

**TypeScript Implementation:**
```typescript
class SentenceDetector {
  private buffer = "";
  private sentenceCount = 0;
  
  feed(text: string, callback: (sentence: string) => void): void {
    this.buffer += text;
    this.checkBoundaries(callback);
  }
  
  private checkBoundaries(callback: (sentence: string) => void): void {
    // Find sentence boundaries
    // Check word counts
    // Call callback for complete sentences
  }
  
  flush(callback: (sentence: string) => void): void {
    // Send remaining buffer as final sentence
  }
}
```

---

### Phase 5: Permission Voice Confirmation

**Goal:** Handle tool permission prompts hands-free.

**Tasks:**
1. When `permission.asked` event received:
   - Build permission description text
   - Send to RCLI TTS: "Permission request: Allow editing file package.json? Say yes or no."
2. RCLI listens for voice response
3. Keywords: "yes", "allow", "sure", "no", "reject", "deny"
4. Bridge sends `POST /permission/:id/reply`
5. Confirm action via TTS: "Permission granted" / "Permission denied"

**Implementation:**
```typescript
async handlePermission(event: PermissionAskedEvent): Promise<void> {
  const description = this.formatPermission(event);
  await this.rcli.speak(`Permission request: ${description}. Say yes or no.`);
  
  const response = await this.rcli.listenForKeywords({
    positive: ["yes", "allow", "sure"],
    negative: ["no", "reject", "deny"],
    timeout: 10000
  });
  
  await this.openCode.permission.reply({
    requestID: event.requestID,
    reply: response === "positive" ? "once" : "reject"
  });
}
```

---

### Phase 6: Polish & Configuration

**Goal:** Production-ready with full configurability.

**Tasks:**
1. Add all voice settings to `opencode.json` schema
2. Create voice configuration CLI: `opencode voice config`
3. Add voice status to `/status` dialog
4. Implement voice model picker (`opencode voice models`)
5. Add auto-start option (start voice mode on TUI launch)
6. Implement fallback if RCLI not available (show warning)
7. Add voice session history (transcripts stored in SQLite)
8. Optimize for latency (profile STT, LLM, TTS timing)

---

## File-by-File Implementation

### RCLI Changes (Phase 1)

**New File: `../../src/cli/cmd_proxy.h`**
```cpp
#pragma once
#include <string>

namespace rcli {

struct ProxyConfig {
    std::string socket_path = "~/.opencode/rcli-voice.sock";
    std::string tts_model = "kokoro-en";
    std::string stt_model = "zipformer";
    float vad_threshold = 0.5f;
};

int cmd_proxy(const ProxyConfig& config);

} // namespace rcli
```

**New File: `../../src/cli/cmd_proxy.cpp`**
```cpp
#include "cmd_proxy.h"
#include "../engines/vad_engine.h"
#include "../engines/stt_engine.h"
#include "../engines/tts_engine.h"
#include "../pipeline/orchestrator.h"
#include "../api/rcli_api.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <nlohmann/json.hpp>

// ... implementation
```

**Modified: `../../src/cli/main.cpp`**
Add to command dispatch:
```cpp
} else if (command == "proxy") {
    rcli::ProxyConfig config;
    config.socket_path = get_arg(args, "--socket", config.socket_path);
    config.tts_model = get_arg(args, "--tts-model", config.tts_model);
    return rcli::cmd_proxy(config);
```

---

### OpenCode Changes (Phases 2-6)

**New File: `packages/opencode/src/cli/voice/protocol.ts`**
```typescript
// RCLI → Bridge messages
export interface TranscriptMessage {
  type: "transcript";
  text: string;
  isFinal: boolean;
  confidence?: number;
}

export interface StateMessage {
  type: "state";
  state: "idle" | "listening" | "processing" | "speaking" | "interrupted";
}

export interface AudioLevelMessage {
  type: "audio_level";
  level: number;
  isSpeech: boolean;
}

export interface BargeInMessage {
  type: "barge_in";
  transcript?: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type RcliMessage = 
  | TranscriptMessage 
  | StateMessage 
  | AudioLevelMessage 
  | BargeInMessage 
  | ErrorMessage;

// Bridge → RCLI messages
export interface ToggleMessage {
  type: "toggle";
  enabled: boolean;
}

export interface SpeakMessage {
  type: "speak";
  text: string;
  priority?: "normal" | "interrupt";
}

export interface InterruptMessage {
  type: "interrupt";
}

export interface ConfigMessage {
  type: "config";
  ttsVoice?: string;
  sttModel?: string;
  vadThreshold?: number;
}

export type BridgeMessage =
  | ToggleMessage
  | SpeakMessage
  | InterruptMessage
  | ConfigMessage;
```

**New File: `packages/opencode/src/cli/voice/socket-client.ts`**
```typescript
import { Socket } from "net";
import { EventEmitter } from "events";
import type { RcliMessage, BridgeMessage } from "./protocol";

export class RcliSocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  
  async connect(socketPath: string): Promise<void> {
    this.socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      this.socket!.connect(socketPath, resolve);
      this.socket!.once("error", reject);
    });
    
    this.socket.on("data", (data) => this.handleData(data));
    this.socket.on("close", () => this.emit("disconnect"));
  }
  
  send(message: BridgeMessage): void {
    if (!this.socket) throw new Error("Not connected");
    this.socket.write(JSON.stringify(message) + "\n");
  }
  
  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    
    for (const line of lines) {
      if (line.trim()) {
        const msg = JSON.parse(line) as RcliMessage;
        this.emit("message", msg);
      }
    }
  }
  
  disconnect(): void {
    this.socket?.end();
  }
}
```

**New File: `packages/opencode/src/cli/voice/bridge.ts`**
```typescript
import { RcliSocketClient } from "./socket-client";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { SentenceDetector } from "./sentence-detector";
import type { RcliMessage } from "./protocol";

export interface VoiceBridgeConfig {
  rcliPath: string;
  socketPath: string;
  serverUrl: string;
  directory: string;
}

export class VoiceBridge {
  private rcli: RcliSocketClient;
  private openCode: ReturnType<typeof createOpencodeClient>;
  private sentenceDetector: SentenceDetector;
  private config: VoiceBridgeConfig;
  private sessionID: string | null = null;
  private ttsQueue: string[] = [];
  private isSpeaking = false;
  
  constructor(config: VoiceBridgeConfig) {
    this.config = config;
    this.rcli = new RcliSocketClient();
    this.openCode = createOpencodeClient({ 
      baseUrl: config.serverUrl,
      directory: config.directory 
    });
    this.sentenceDetector = new SentenceDetector({
      minWords: 6,
      firstSentenceMinWords: 1,
      maxWordsSecondary: 35
    });
  }
  
  async start(sessionID: string): Promise<void> {
    this.sessionID = sessionID;
    
    // Spawn RCLI proxy process
    await this.spawnRcli();
    
    // Connect to socket
    await this.rcli.connect(this.config.socketPath);
    this.rcli.on("message", (msg) => this.handleRcliMessage(msg));
    
    // Subscribe to OpenCode events
    const eventStream = await this.openCode.global.event();
    for await (const event of eventStream) {
      await this.handleSseEvent(event);
    }
  }
  
  async toggle(enabled: boolean): Promise<void> {
    this.rcli.send({ type: "toggle", enabled });
  }
  
  private async handleRcliMessage(msg: RcliMessage): Promise<void> {
    switch (msg.type) {
      case "transcript":
        if (msg.isFinal && this.sessionID) {
          await this.sendToOpencode(msg.text);
        }
        break;
      case "barge_in":
        await this.handleBargeIn();
        break;
      case "audio_level":
        this.emit("audioLevel", msg.level, msg.isSpeech);
        break;
      case "state":
        this.emit("stateChange", msg.state);
        break;
    }
  }
  
  private async sendToOpencode(text: string): Promise<void> {
    if (!this.sessionID) return;
    
    await this.openCode.session.promptAsync({
      sessionID: this.sessionID,
      parts: [{ type: "text", text }]
    });
  }
  
  private async handleSseEvent(event: any): Promise<void> {
    switch (event.type) {
      case "message.part.delta":
        if (event.properties.field === "text") {
          this.sentenceDetector.feed(
            event.properties.delta,
            (sentence) => this.queueTts(sentence)
          );
        }
        break;
      case "permission.asked":
        await this.handlePermission(event);
        break;
      case "session.idle":
        this.sentenceDetector.flush((sentence) => this.queueTts(sentence));
        break;
    }
  }
  
  private queueTts(text: string): void {
    const cleanText = sanitizeForTts(text);
    if (!cleanText) return;
    
    this.rcli.send({ type: "speak", text: cleanText });
  }
  
  private async handleBargeIn(): Promise<void> {
    if (!this.sessionID) return;
    
    // Stop TTS
    this.rcli.send({ type: "interrupt" });
    
    // Abort OpenCode session
    await this.openCode.session.abort({ sessionID: this.sessionID });
    
    this.emit("bargeIn");
  }
  
  private async handlePermission(event: any): Promise<void> {
    // TTS ask permission
    const question = this.formatPermissionQuestion(event);
    this.rcli.send({ 
      type: "speak", 
      text: `Permission request: ${question}. Say yes or no.` 
    });
    
    // TODO: Implement keyword detection in RCLI
    // For now, rely on TUI
  }
  
  // ... additional methods
}

function sanitizeForTts(text: string): string {
  // Remove <think> blocks
  // Remove <tool_call> tags
  // Strip markdown
  // Expand contractions
  return text
    .replace(/<think>.*?<\/think>/gs, "")
    .replace(/<tool_call>.*?<\/tool_call>/gs, "")
    .replace(/[`*#~]/g, "")
    .trim();
}
```

**Modified: `packages/opencode/src/config/config.ts`**

Add to `Config.Info` schema around line 1200:

```typescript
voice: z.object({
  enabled: z.boolean().default(false),
  keybind: z.string().default("ctrl+v"),
  rcliPath: z.string().default("../../rcli/build/rcli"),
  socketPath: z.string().default("~/.opencode/rcli-voice.sock"),
  stt: z.object({
    model: z.enum(["zipformer", "whisper-base", "parakeet-tdt"]).default("zipformer"),
    language: z.string().default("en")
  }).default({}),
  tts: z.object({
    model: z.enum(["kokoro-en", "kokoro-multi", "piper-lessac", "piper-amy"]).default("kokoro-en"),
    voice: z.string().optional(),
    speed: z.number().default(1.0)
  }).default({}),
  vad: z.object({
    threshold: z.number().default(0.5),
    minSilenceDuration: z.number().default(0.5),
    minSpeechDuration: z.number().default(0.25)
  }).default({}),
  permissions: z.object({
    voiceConfirm: z.boolean().default(true),
    autoApprove: z.array(z.string()).default(["read", "glob"]),
    requireConfirm: z.array(z.string()).default(["write", "edit", "bash"])
  }).default({}),
  ui: z.object({
    overlayPosition: z.enum(["top", "bottom"]).default("bottom"),
    showWaveform: z.boolean().default(true),
    showTranscript: z.boolean().default(true),
    transcriptTimeout: z.number().default(3000)
  }).default({})
}).optional()
```

**New File: `packages/opencode/src/cli/voice/sentence-detector.ts`**
```typescript
export interface SentenceDetectorConfig {
  minWords: number;
  firstSentenceMinWords: number;
  maxWordsSecondary: number;
}

export class SentenceDetector {
  private buffer = "";
  private sentenceCount = 0;
  private config: SentenceDetectorConfig;
  
  constructor(config: SentenceDetectorConfig) {
    this.config = config;
  }
  
  feed(text: string, callback: (sentence: string) => void): void {
    this.buffer += text;
    this.checkBoundaries(callback);
  }
  
  flush(callback: (sentence: string) => void): void {
    const trimmed = this.buffer.trim();
    if (trimmed) {
      callback(trimmed);
    }
    this.buffer = "";
    this.sentenceCount = 0;
  }
  
  private checkBoundaries(callback: (sentence: string) => void): void {
    const minWords = this.sentenceCount === 0 
      ? this.config.firstSentenceMinWords 
      : this.config.minWords;
    
    let start = 0;
    
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      
      // Primary boundaries: . ! ? \n
      if (char === "." || char === "!" || char === "?" || char === "\n") {
        // Check if followed by space, quote, or end of buffer
        const next = this.buffer[i + 1];
        if (!next || next === " " || next === "\"" || next === "'" || next === "\n") {
          const candidate = this.buffer.slice(start, i + 1).trim();
          if (this.countWords(candidate) >= minWords) {
            callback(candidate);
            start = i + 1;
            this.sentenceCount++;
          }
        }
      }
      
      // Secondary boundaries: ; : (only after many words)
      if ((char === ";" || char === ":") && i > 0) {
        const candidate = this.buffer.slice(start, i + 1).trim();
        const wordCount = this.countWords(candidate);
        if (wordCount >= this.config.maxWordsSecondary) {
          callback(candidate);
          start = i + 1;
          this.sentenceCount++;
        }
      }
    }
    
    // Keep remaining text in buffer
    this.buffer = this.buffer.slice(start);
  }
  
  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  }
}
```

**Modified: `packages/opencode/src/cli/cmd/tui/app.tsx`**

Add voice command registration (around line 356 where other commands are registered):

```typescript
command.register(() => [
  {
    id: "voice.toggle",
    label: "Toggle Voice Mode",
    shortcut: keybind.print("voice_toggle"),
    keybind: "voice_toggle",
    onSelect: () => {
      voiceBridge.toggle(!voiceState.isEnabled);
    }
  },
  {
    id: "voice.config",
    label: "Voice Settings...",
    onSelect: () => {
      dialog.replace(() => <DialogVoiceSettings />);
    }
  }
]);
```

**New File: `packages/opencode/src/cli/cmd/tui/component/voice-overlay.tsx`**
```typescript
import { useVoiceContext } from "../context/voice";

export function VoiceOverlay() {
  const voice = useVoiceContext();
  const theme = useTheme();
  
  return (
    <box 
      borderStyle="single" 
      borderColor={voice.isListening ? theme.colors.success : theme.colors.muted}
      padding={1}
    >
      <box flexDirection="row">
        <text color={voice.isListening ? "green" : undefined}>
          {voice.isListening ? "🎤" : voice.isSpeaking ? "🔊" : "🔇"}
        </text>
        <text> </text>
        <text bold>
          {voice.isListening ? "Listening..." : 
           voice.isSpeaking ? "Speaking..." : 
           voice.state === "processing" ? "Processing..." : "Voice Ready"}
        </text>
        <spacer />
        <text dim>{keybind.print("voice_toggle")} to toggle</text>
      </box>
      
      {voice.config.ui.showWaveform && (
        <AudioWaveform 
          level={voice.audioLevel} 
          isSpeech={voice.isSpeech}
        />
      )}
      
      {voice.config.ui.showTranscript && voice.lastTranscript && (
        <FadeText 
          text={`"${voice.lastTranscript}"`}
          timeout={voice.config.ui.transcriptTimeout}
        />
      )}
    </box>
  );
}

function AudioWaveform(props: { level: number; isSpeech: boolean }) {
  const bars = 20;
  const filled = Math.floor(props.level * bars);
  const barChar = "█";
  const emptyChar = "░";
  
  return (
    <box>
      <text color={props.isSpeech ? "green" : undefined}>
        {barChar.repeat(filled) + emptyChar.repeat(bars - filled)}
      </text>
    </box>
  );
}
```

---

## Testing Strategy

### Unit Tests

**RCLI Side:**
- Test JSON protocol encoding/decoding
- Test socket server message handling
- Test state machine transitions

**OpenCode Side:**
- Test sentence detection algorithm
- Test socket client reconnection
- Test bridge state management

### Integration Tests

1. **End-to-end flow:**
   ```bash
   # Terminal 1: Start OpenCode server
   cd packages/opencode
   bun run opencode serve --port 4096
   
   # Terminal 2: Start RCLI proxy
   ../../rcli/build/rcli proxy
   
   # Terminal 3: Run bridge test
   bun test packages/opencode/src/cli/voice/__tests__/bridge.test.ts
   ```

2. **Manual test scenarios:**
   - Toggle voice mode with Ctrl+V
   - Speak a command, verify transcription appears
   - Wait for LLM response, verify TTS plays
   - Interrupt while speaking by speaking louder
   - Grant/deny permission via voice
   - Change TTS voice and verify

### Performance Targets

| Metric | Target | Current RCLI |
|--------|--------|--------------|
| STT latency (first word) | < 300ms | ~200ms |
| Time to first audio (TTFA) | < 1.5s | ~800ms |
| TTS synthesis (per sentence) | < 200ms | ~100ms |
| Barge-in detection | < 100ms | ~50ms |
| End-to-end latency | < 2s | ~1.2s |

---

## Appendix: Data Flow Examples

### Example 1: Simple Voice Command

```
[User] Presses Ctrl+V
  ├─► TUI: Toggle voice mode ON
  ├─► Bridge: Connects to RCLI socket
  ├─► Bridge: Sends { type: "toggle", enabled: true }
  └─► RCLI: Starts mic capture, VAD monitoring

[User] Speaks: "List all files"
  ├─► RCLI: VAD detects speech
  ├─► RCLI: Zipformer transcribes → "List all files"
  └─► RCLI: Socket → { type: "transcript", text: "List all files", isFinal: true }

[Bridge] Receives transcript
  ├─► HTTP POST /session/:id/prompt_async
  │     Body: { parts: [{ type: "text", text: "List all files" }] }
  └─► OpenCode processes, streams response

[OpenCode] Streams via SSE:
  ├─► { type: "message.part.delta", text: "Here" }
  ├─► { type: "message.part.delta", text: " are" }
  ├─► { type: "message.part.delta", text: " the" }
  ├─► { type: "message.part.delta", text: " files:" }
  └─► { type: "message.part.delta", text: "\n\nfile1.txt\nfile2.js" }

[Bridge] Accumulates text:
  ├─► SentenceDetector detects: "Here are the files:"
  ├─► Socket → { type: "speak", text: "Here are the files:" }
  ├─► [later] Detects: "file1.txt, file2.js"
  └─► Socket → { type: "speak", text: "file1.txt, file2.js" }

[RCLI] Receives speak commands:
  ├─► TTS synthesizes "Here are the files:"
  ├─► CoreAudio plays audio
  ├─► [later] Synthesizes "file1.txt, file2.js"
  └─► Plays audio

[User] Hears response spoken aloud
```

### Example 2: Barge-in

```
[Ongoing] OpenCode speaking long response via TTS

[User] Speaks louder: "Stop, just open Safari"
  ├─► RCLI: VAD detects speech
  ├─► RCLI: Echo cancellation check (mic > 2.5x playback)
  ├─► RCLI: BARGE_IN triggered!
  ├─► RCLI: Clears playback ring buffer (instant silence)
  ├─► RCLI: Socket → { type: "barge_in" }
  └─► RCLI: Starts new STT session

[Bridge] Receives barge_in
  ├─► HTTP POST /session/:id/abort
  └─► OpenCode cancels current LLM stream

[User] "just open Safari" transcribed
  ├─► RCLI: Socket → { type: "transcript", text: "just open Safari", isFinal: true }
  ├─► Bridge: Sends to OpenCode as new prompt
  └─► New response cycle begins
```

### Example 3: Permission Voice Confirmation

```
[OpenCode] LLM calls edit tool, needs permission
  └─► SSE: { type: "permission.asked", tool: "edit", file: "package.json" }

[Bridge] Receives permission event
  ├─► Socket → { 
  │     type: "speak", 
  │     text: "Permission request: Allow editing package.json? Say yes or no." 
  │   }
  └─► RCLI: TTS speaks the prompt

[User] Speaks: "Yes"
  ├─► RCLI: STT transcribes "Yes"
  ├─► RCLI: Keyword detection matches positive intent
  └─► RCLI: Socket → { type: "transcript", text: "Yes", intent: "grant" }

[Bridge] Receives voice confirmation
  ├─► HTTP POST /permission/:id/reply
  │     Body: { reply: "once" }
  ├─► Socket → { type: "speak", text: "Permission granted." }
  └─► LLM continues with tool execution
```

---

## References

### RCLI API Documentation
See `../..` for:
- `src/api/rcli_api.h` - C API surface
- `src/cli/main.cpp` - CLI entry point
- `src/pipeline/orchestrator.h` - Pipeline state machine
- `src/engines/vad_engine.h` - VAD interface
- `src/engines/stt_engine.h` - STT interface
- `src/engines/tts_engine.h` - TTS interface

### OpenCode API Documentation
See OpenCode OpenAPI spec:
- `packages/sdk/openapi.json`
- Or running server: `GET /doc`

### Related Files in This Plan

**RCLI (Phase 1):**
```
../../
├── src/cli/cmd_proxy.h         # New
├── src/cli/cmd_proxy.cpp       # New
└── src/cli/main.cpp            # Modified
```

**OpenCode (Phases 2-6):**
```
packages/opencode/src/
├── cli/
│   ├── voice/
│   │   ├── index.ts            # Public API
│   │   ├── bridge.ts           # Main bridge logic
│   │   ├── socket-client.ts    # Unix socket client
│   │   ├── protocol.ts         # Message types
│   │   ├── state-machine.ts    # Voice state
│   │   └── sentence-detector.ts # Sentence detection
│   ├── cmd/
│   │   ├── voice.ts            # CLI command
│   │   └── tui/
│   │       ├── app.tsx         # Modified
│   │       ├── context/
│   │       │   └── voice.tsx   # New voice context
│   │       ├── component/
│   │       │   ├── voice-overlay.tsx    # New
│   │       │   └── voice-indicator.tsx  # New
│   │       └── routes/session/
│   │           └── index.tsx   # Modified
├── config/
│   └── config.ts               # Modified (voice schema)
└── cli/cmd/tui/
    └── component/dialog-status.tsx  # Modified
```

---

## Summary

This integration adds a complete voice interface to OpenCode:

1. **RCLI runs as a sidecar** providing STT (Zipformer) and TTS (Kokoro/Piper)
2. **Unix socket protocol** enables bidirectional JSON communication
3. **OpenCode bridge** translates between RCLI and OpenCode HTTP API
4. **TUI overlay** shows voice status and audio visualization
5. **Barge-in support** allows interrupting responses by speaking
6. **Voice permissions** enable hands-free tool confirmation

**Key Benefits:**
- OpenCode retains its powerful LLM providers (Claude, GPT, etc.)
- RCLI provides low-latency on-device audio processing
- Clean separation: voice is optional, TUI works normally without it
- Extensible: can support multiple STT/TTS models via RCLI

**Next Steps:**
1. Implement Phase 1 (RCLI proxy mode)
2. Implement Phase 2 (OpenCode bridge)
3. Test integration with netcat/manual testing
4. Implement Phases 3-6 iteratively
