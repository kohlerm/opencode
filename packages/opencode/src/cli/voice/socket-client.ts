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
      throw new Error("Already connected")
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
      vlog("Socket", `Received ${data.length} bytes: ${data.toString("utf-8").trim()}`)
      this.handleData(data)
    })

    this.socket.on("close", (hadError: boolean) => {
      vlog("Socket", `Socket closed! hadError=${hadError} destroyed=${this.destroyed} reconnect=${this.options.reconnect}`)
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
        this.emit("error", new Error(`Failed to parse message: ${line}`))
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return
    this.reconnecting = true

    setTimeout(() => {
      this.reconnecting = false
      if (!this.destroyed) {
        this.connect().catch(() => {
          // Reconnection failed, will retry
        })
      }
    }, this.options.reconnectDelay)
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
    this.socket?.end()
    this.socket = null
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === "open"
  }
}
