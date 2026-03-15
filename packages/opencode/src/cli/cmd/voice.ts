/**
 * Voice CLI Command
 * 
 * `opencode voice` subcommand for managing voice mode.
 */

import { cmd } from "../cmd/cmd"
import { VoiceBridge, type VoiceBridgeConfig } from "../voice/index"
import { Config } from "../../config/config"

export const VoiceCommand = cmd({
  command: "voice [action]",
  describe: "Manage voice mode for hands-free interaction",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["start", "stop", "status", "config"],
        describe: "Voice action to perform",
      })
      .option("session", {
        type: "string",
        alias: "s",
        describe: "Session ID to use for voice commands",
      })
      .option("rcli-path", {
        type: "string",
        describe: "Path to RCLI binary",
      })
      .option("socket-path", {
        type: "string",
        describe: "Path to Unix socket",
      }),
  handler: async (args) => {
    const action = args.action || "status"
    const config = await Config.load()

    switch (action) {
      case "start":
        await startVoiceMode(args, config)
        break
      case "stop":
        await stopVoiceMode()
        break
      case "status":
        await showVoiceStatus(config)
        break
      case "config":
        await showVoiceConfig(config)
        break
      default:
        console.log("Unknown action. Use: start, stop, status, or config")
    }
  },
})

async function startVoiceMode(args: any, config: Config.Info): Promise<void> {
  const bridgeConfig: VoiceBridgeConfig = {
    rcliPath: args["rcliPath"] || config.voice?.rcliPath || "../../rcli/build/rcli",
    socketPath: args["socketPath"] || config.voice?.socketPath || "~/.opencode/rcli-voice.sock",
    serverUrl: "http://localhost:4096", // Will be detected from running server
    directory: process.cwd(),
    voiceConfig: config.voice,
  }

  console.log("Starting voice mode...")
  console.log(`RCLI path: ${bridgeConfig.rcliPath}`)
  console.log(`Socket path: ${bridgeConfig.socketPath}`)

  const bridge = new VoiceBridge(bridgeConfig)

  bridge.on("connect", () => {
    console.log("✓ Connected to RCLI voice proxy")
    bridge.toggle(true)
    console.log("✓ Voice mode enabled. Speak to interact with OpenCode.")
    console.log("  Press Ctrl+C to stop.")
  })

  bridge.on("disconnect", () => {
    console.log("✗ Disconnected from RCLI")
  })

  bridge.on("stateChange", (state) => {
    console.log(`State: ${state}`)
  })

  bridge.on("transcript", (text, isFinal) => {
    if (isFinal) {
      console.log(`You said: "${text}"`)
    } else {
      process.stdout.write(`\rHeard: "${text}"`)
    }
  })

  bridge.on("error", (err) => {
    console.error("Error:", err.message)
  })

  if (args.session) {
    bridge.setSessionID(args.session)
  }

  try {
    await bridge.start()

    // Keep running until Ctrl+C
    process.on("SIGINT", () => {
      console.log("\nStopping voice mode...")
      bridge.stop()
      process.exit(0)
    })

    // Keep alive
    await new Promise(() => {})
  } catch (err) {
    console.error("Failed to start voice mode:", err)
    process.exit(1)
  }
}

async function stopVoiceMode(): Promise<void> {
  console.log("Voice mode stopped.")
  // TODO: Send signal to running voice process if any
}

async function showVoiceStatus(config: Config.Info): Promise<void> {
  console.log("Voice Mode Status")
  console.log("=================")
  console.log(`Enabled: ${config.voice?.enabled || false}`)
  console.log(`Keybind: ${config.voice?.keybind || "ctrl+v"}`)
  console.log(`RCLI path: ${config.voice?.rcliPath || "../../rcli/build/rcli"}`)
  console.log(`Socket path: ${config.voice?.socketPath || "~/.opencode/rcli-voice.sock"}`)
  console.log("")
  console.log("STT Configuration:")
  console.log(`  Model: ${config.voice?.stt?.model || "zipformer"}`)
  console.log(`  Language: ${config.voice?.stt?.language || "en"}`)
  console.log("")
  console.log("TTS Configuration:")
  console.log(`  Model: ${config.voice?.tts?.model || "kokoro-en"}`)
  console.log(`  Voice: ${config.voice?.tts?.voice || "default"}`)
  console.log(`  Speed: ${config.voice?.tts?.speed || 1.0}`)
  console.log("")
  console.log("Permission Settings:")
  console.log(`  Voice confirmation: ${config.voice?.permissions?.voiceConfirm || true}`)
}

async function showVoiceConfig(config: Config.Info): Promise<void> {
  console.log(JSON.stringify(config.voice, null, 2))
}
