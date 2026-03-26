/**
 * Voice debug logger - writes to /tmp/opencode-voice.log
 */
import { openSync, writeSync, closeSync, writeFileSync } from "node:fs"

const LOG_PATH = "/tmp/opencode-voice.log"

// Truncate on load so each process gets a fresh log (see OPENCODE_VOICE_NATIVE_LOGS for native noise).
try {
  writeFileSync(LOG_PATH, "")
} catch {}

export function vlog(component: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  const line = `[${ts}] [${component}] ${msg}\n`
  try {
    const fd = openSync(LOG_PATH, "a")
    writeSync(fd, line)
    closeSync(fd)
  } catch {}
}
