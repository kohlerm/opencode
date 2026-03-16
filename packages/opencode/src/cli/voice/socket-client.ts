/**
 * RCLI Socket Client
 *
 * Unix domain socket client for communicating with the RCLI voice proxy.
 */

import { Socket } from "node:net"
import { EventEmitter } from "node:events"
import type { RcliMessage, BridgeMessage } from "./protocol"
import { vlog } from "./vlog"

export interface SocketClientOptions {
  socketPath: string
  reconnect?: boolean
  reconnectDelay?: number
}

export class RcliSocketClient extends EventEmitter {
  private socket: Socket | null = null
  private buffer = ""
  private options: SocketClientOptions
  private reconnecting = false
  private destroyed = false
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(options: SocketClientOptions) {
    super()
    this.options = {
      reconnect: true,
      reconnectDelay: 1000,
      ...options,
    }
  }

  async connect(): Promise<void> {
    if (this.socket) {
      // Clean up any stale socket before reconnecting.
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }

    // Expand ~ in socket path
    let socketPath = this.options.socketPath
    if (socketPath.startsWith("~")) {
      socketPath = socketPath.replace("~", process.env.HOME || "~")
    }

    vlog("Socket", `Connecting to ${socketPath}... (destroyed=${this.destroyed})`)

    this.socket = new Socket()

    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.socket!.off("error", onError)
        this.setupSocket()
        vlog("Socket", `Connected! readyState=${this.socket?.readyState}`)
        this.emit("connect")
        resolve()
      }

      const onError = (err: Error) => {
        vlog("Socket", `Connection error: ${err.message}`)
        this.socket!.off("connect", onConnect)
        this.socket!.off("error", onError)
        this.socket?.destroy()
        this.socket = null
        reject(err)
      }

      this.socket!.once("connect", onConnect)
      this.socket!.once("error", onError)
      this.socket!.connect(socketPath)
    })
  }

  private setupSocket(): void {
    if (!this.socket) return

    this.socket.on("data", (data: Buffer) => {
      // Don't log audio_chunk data (too large)
      if (data.length < 500) {
        vlog("Socket", `Received ${data.length} bytes: ${data.toString("utf-8").trim()}`)
      }
      this.handleData(data)
    })

    this.socket.on("close", (hadError: boolean) => {
      vlog(
        "Socket",
        `Socket closed! hadError=${hadError} destroyed=${this.destroyed} reconnect=${this.options.reconnect}`,
      )
      this.socket = null
      this.emit("disconnect")

      if (this.options.reconnect && !this.destroyed) {
        this.scheduleReconnect()
      }
    })

    this.socket.on("error", (err: Error) => {
      vlog("Socket", `Socket error: ${err.message}`)
      this.emit("error", err)
    })
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString("utf-8")
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const message = JSON.parse(line) as RcliMessage
        this.emit("message", message)
      } catch (err) {
        // Log parse errors (truncated audio_chunk messages etc)
        const preview = line.length > 100 ? line.substring(0, 100) + "..." : line
        vlog("Socket", `Parse error (${line.length} bytes): ${preview}`)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return
    this.reconnecting = true

    const attempt = async () => {
      if (this.destroyed) {
        this.reconnecting = false
        return
      }

      try {
        await this.connect()
        this.reconnecting = false
        this.reconnectTimer = null
      } catch (err) {
        vlog("Socket", `Reconnect attempt failed: ${err instanceof Error ? err.message : String(err)}`)
        this.reconnectTimer = setTimeout(attempt, this.options.reconnectDelay)
      }
    }

    this.reconnectTimer = setTimeout(attempt, this.options.reconnectDelay)
  }

  send(message: BridgeMessage): void {
    if (!this.socket) {
      vlog("Socket", `send() called but socket is null!`)
      throw new Error("Not connected")
    }

    const line = JSON.stringify(message) + "\n"
    vlog("Socket", `Sending: ${line.trim()}`)
    this.socket.write(line)
  }

  disconnect(): void {
    vlog("Socket", `disconnect() called (destroyed=${this.destroyed}, socket=${!!this.socket})`)
    this.destroyed = true
    this.reconnecting = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.end()
    this.socket?.destroy()
    this.socket = null
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === "open"
  }
}
