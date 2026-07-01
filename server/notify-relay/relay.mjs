import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PORT = parseInt(process.env.CC_NOTIFY_RELAY_PORT || "8770", 10)
const HOST = "127.0.0.1"
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const asString = (v) => (typeof v === "string" ? v : "")

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data")
const DATA_FILE = path.join(DATA_DIR, "observer.jsonl")

/** 観測ログのアップロード本文か（type=cc-observer かつ lines 文字列）。 */
export function isObserverBatch(o) {
  return !!(o && typeof o === "object" && o.type === "cc-observer" && typeof o.lines === "string")
}

/** 端末の JSONL 行群＋サーバ受信マーカー1行を追記用テキストに整形する。 */
export function formatBatchRecords(o, tServer) {
  const raw = String(o.lines || "")
  const lines = raw.split("\n").filter((s) => s.trim())
  const marker = JSON.stringify({
    src: "server", kind: "batch", t_server: tServer,
    device: asString(o.device), count: lines.length, sentAt: Number(o.sentAt) || 0,
  })
  return lines.concat(marker).join("\n") + "\n"
}

/** サーバ視点の keepalive 接続/切断1行。 */
export function serverKeepaliveLine(event, tServer) {
  return JSON.stringify({ src: "server", kind: "keepalive", event, t_server: tServer }) + "\n"
}

function appendObserver(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(DATA_FILE, text)
  } catch (e) {
    console.error("observer append failed:", e.message)
  }
}

export function normalizeEvent(raw) {
  const o = raw && typeof raw === "object" ? raw : {}
  const cwd = asString(o.cwd)
  return {
    event: "cc-notify",
    kind: asString(o.hook_event_name) || "Stop",
    project: cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "" : "",
    branch: "",
    cwd,
    sessionId: asString(o.session_id),
    message: asString(o.message),
    ts: Math.floor(Date.now() / 1000),
  }
}

/** WS テキストフレーム（unmasked, FIN+text）。 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8")
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

const clients = new Set()

export function broadcast(event) {
  const frame = encodeTextFrame(JSON.stringify(event))
  let sent = 0
  for (const sock of clients) {
    try {
      sock.write(frame)
      sent++
    } catch {
      clients.delete(sock)
      try { sock.destroy() } catch {}
    }
  }
  return sent
}

function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"]
  if (!key) { socket.destroy(); return }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64")
  // Register client BEFORE writing 101 so any POST fired immediately after 101 sees the client.
  clients.add(socket)
  appendObserver(serverKeepaliveLine("connect", Date.now()))
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  // disconnect は close の1箇所だけで記録（error/end→drop→destroy でも最終的に close が発火する）。
  const drop = () => { clients.delete(socket); try { socket.destroy() } catch {} }
  socket.on("close", () => { clients.delete(socket); appendObserver(serverKeepaliveLine("disconnect", Date.now())) })
  socket.on("error", drop)
  socket.on("end", drop)
  socket.on("data", (buf) => {
    // クライアントからの close フレーム（opcode 0x8）だけ処理。他の受信は無視。
    if (buf.length >= 1 && (buf[0] & 0x0f) === 0x8) { drop(); try { socket.end() } catch {} }
  })
}

export function createServer() {
  const server = http.createServer((req, res) => {
    // tailscale serve のパス挙動に依存しないよう POST は method だけで判定（tailnet 前提）。
    if (req.method === "POST") {
      let body = ""
      req.on("data", (c) => {
        body += c
        if (body.length > 1_000_000) req.destroy()
      })
      req.on("end", () => {
        let parsed
        try { parsed = body ? JSON.parse(body) : {} } catch { parsed = {} }
        if (isObserverBatch(parsed)) {
          appendObserver(formatBatchRecords(parsed, Date.now()))
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ saved: true }))
          return
        }
        const delivered = broadcast(normalizeEvent(parsed))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ delivered }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  // 全 Upgrade を WS 購読として受ける（パスのプレフィックス有無に依存しない）。
  server.on("upgrade", (req, socket) => handleUpgrade(req, socket))
  return server
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  createServer().listen(PORT, HOST, () => {
    console.log(`notify-relay on ${HOST}:${PORT}`)
  })
}
