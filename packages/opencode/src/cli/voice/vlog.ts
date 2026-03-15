/**
 * Voice debug logger - writes to /tmp/opencode-voice.log
 */
import { appendFileSync, writeFileSync } from "node:fs"

const LOG_PATH = "/tmp/opencode-voice.log"

// Clear log on module load
try { writeFileSync(LOG_PATH, "") } catch {}

export function vlog(component: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  const line = `[${ts}] [${component}] ${msg}\n`
  try { appendFileSync(LOG_PATH, line) } catch {}
}
