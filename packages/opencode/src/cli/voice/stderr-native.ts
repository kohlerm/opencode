import { dlopen } from "bun:ffi"

let depth = 0
let saved = -1
let libc: ReturnType<typeof dlopen> | null = null

function load() {
  if (libc) return libc
  try {
    libc = dlopen("/usr/lib/libSystem.B.dylib", {
      dup: { args: ["i32"], returns: "i32" },
      dup2: { args: ["i32", "i32"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
      open: { args: ["cstring", "i32"], returns: "i32" },
    })
    return libc
  } catch {
    return null
  }
}

function hush() {
  if (process.platform !== "darwin") return false
  if (process.env.OPENCODE_VOICE_NATIVE_LOGS === "1") return false

  const lib = load()
  if (!lib) return false
  const open = lib.symbols.open as unknown as (file: Buffer, flags: number) => number
  const dup = lib.symbols.dup as unknown as (fd: number) => number
  const dup2 = lib.symbols.dup2 as unknown as (src: number, dst: number) => number
  const close = lib.symbols.close as unknown as (fd: number) => number
  const dev = open(Buffer.from("/dev/null\0"), 1)
  if (dev < 0) return false

  const fd = dup(2)
  if (fd < 0) {
    close(dev)
    return false
  }

  if (dup2(dev, 2) < 0) {
    close(dev)
    close(fd)
    return false
  }

  close(dev)
  saved = fd
  return true
}

function restore() {
  if (saved < 0) return
  const lib = load()
  if (!lib) return
  const dup2 = lib.symbols.dup2 as unknown as (src: number, dst: number) => number
  const close = lib.symbols.close as unknown as (fd: number) => number
  dup2(saved, 2)
  close(saved)
  saved = -1
}

export function mute() {
  if (depth === 0) hush()
  depth++

  return () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) restore()
  }
}
