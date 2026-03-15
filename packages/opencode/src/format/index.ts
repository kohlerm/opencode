import { Bus } from "../bus"
import { File } from "../file"
import { Log } from "../util/log"
import path from "path"
import z from "zod"

import * as Formatter from "./formatter"
import { Config } from "../config/config"
import { mergeDeep } from "remeda"
import { Instance } from "../project/instance"
import { Process } from "../util/process"

export namespace Format {
  const log = Log.create({ service: "format" })

  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  const state = Instance.state(async () => {
    const cache: Record<string, string[] | false> = {}
    const cfg = await Config.get()

    const formatters: Record<string, Formatter.Info> = {}
    if (cfg.formatter === false) {
      log.info("all formatters are disabled")
      return {
        cache,
        formatters,
      }
    }

    for (const item of Object.values(Formatter)) {
      formatters[item.name] = item
    }
    for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
      if (item.disabled) {
        delete formatters[name]
        continue
      }
      const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
        extensions: [],
        ...item,
      })

      result.enabled = async () => item.command ?? false
      result.name = name
      formatters[name] = result
    }

    return {
      cache,
      formatters,
    }
  })

  async function resolveCommand(item: Formatter.Info) {
    const s = await state()
    let command = s.cache[item.name]
    if (command === undefined) {
      log.info("resolving command", { name: item.name })
      command = await item.enabled()
      s.cache[item.name] = command
    }
    return command
  }

  async function getFormatter(ext: string) {
    const formatters = await state().then((x) => x.formatters)
    const result: { info: Formatter.Info; command: string[] }[] = []
    for (const item of Object.values(formatters)) {
      if (!item.extensions.includes(ext)) continue
      const command = await resolveCommand(item)
      if (!command) continue
      log.info("enabled", { name: item.name, ext })
      result.push({ info: item, command })
    }
    return result
  }

  export async function status() {
    const s = await state()
    const result: Status[] = []
    for (const formatter of Object.values(s.formatters)) {
      const command = await resolveCommand(formatter)
      result.push({
        name: formatter.name,
        extensions: formatter.extensions,
        enabled: !!command,
      })
    }
    return result
  }

  export function init() {
    log.info("init")
    Bus.subscribe(File.Event.Edited, async (payload) => {
      const file = payload.properties.file
      log.info("formatting", { file })
      const ext = path.extname(file)

      for (const { info, command } of await getFormatter(ext)) {
        const replaced = command.map((x) => x.replace("$FILE", file))
        log.info("running", { replaced })
        try {
          const proc = Process.spawn(replaced, {
            cwd: Instance.directory,
            env: { ...process.env, ...info.environment },
            stdout: "ignore",
            stderr: "ignore",
          })
          const exit = await proc.exited
          if (exit !== 0)
            log.error("failed", {
              command,
              ...info.environment,
            })
        } catch (error) {
          log.error("failed to format file", {
            error,
            command,
            ...info.environment,
            file,
          })
        }
      }
    })
  }
}
