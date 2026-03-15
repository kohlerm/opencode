import { Log } from "../util/log"
import { Process } from "../util/process"

export namespace BunProc {
  const log = Log.create({ service: "bun" })

  export async function run(cmd: string[], options?: Process.RunOptions) {
    const full = [which(), ...cmd]
    log.info("running", {
      cmd: full,
      ...options,
    })
    const result = await Process.run(full, {
      cwd: options?.cwd,
      abort: options?.abort,
      kill: options?.kill,
      timeout: options?.timeout,
      nothrow: options?.nothrow,
      env: {
        ...process.env,
        ...options?.env,
        BUN_BE_BUN: "1",
      },
    })
    log.info("done", {
      code: result.code,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    return result
  }

  export function which() {
    return process.execPath
  }
}
