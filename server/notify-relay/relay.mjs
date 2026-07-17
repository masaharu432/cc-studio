import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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

// ── トランスクリプト走査（突発キャンセルの正確な発生時刻を自動収集） ─────────
// DOM 文字列検知（アプリ側）は「見えている時しか拾えない・時刻が発生とズレる」ため補助扱い。
// 一次証拠は ~/.claude/projects/**.jsonl のセッショントランスクリプト。ここを増分走査し、
// ツール拒否メッセージ（CLI 定数 uQ。CLI 自身も startsWith で判定している）を
// t=正確な発生時刻 で observer.jsonl に自動追記する。
const TX_ROOT = path.join(os.homedir(), ".claude", "projects")
const TX_STATE_FILE = path.join(DATA_DIR, "tx-scan-state.json")
const TX_SCAN_MS = 60_000
const TX_NEW_FILE_WINDOW_MS = 48 * 3600 * 1000   // 初見ファイルはこの期間内に更新されたものだけ全走査
const CANCEL_TEXT = "The user doesn't want to take this action right now."

/**
 * トランスクリプト1行 → キャンセルレコード（該当しなければ null）。
 * 本物の判定条件: type=user の message.content[] に、content が CANCEL_TEXT で**始まる**
 * tool_result があること（startsWith 判定。引用・ノート・会話中の言及は先頭一致しないため除外される）。
 */
export function txCancelFromLine(line) {
  if (!line || line.indexOf("want to take this action") < 0) return null  // 安価な前置フィルタ
  let o
  try { o = JSON.parse(line) } catch { return null }
  if (!o || o.type !== "user") return null
  const items = o.message && o.message.content
  if (!Array.isArray(items)) return null
  const hit = items.some((it) => {
    if (!it || it.type !== "tool_result") return false
    const c = it.content
    const text = typeof c === "string" ? c
      : Array.isArray(c) ? String((c.find((x) => x && x.type === "text") || {}).text || "") : ""
    return text.startsWith(CANCEL_TEXT)
  })
  if (!hit) return null
  const t = Date.parse(o.timestamp || "") || 0
  return {
    t, iso: asString(o.timestamp), src: "cancel", kind: "cancel", via: "transcript",
    cwd: asString(o.cwd), session: asString(o.sessionId).slice(0, 8),
  }
}

const TX_NOTIFY_FRESH_MS = 10 * 60 * 1000  // これより古い検出（初回バックフィル等）は通知しない

/**
 * 走査で見つけたキャンセルを phone 向け通知イベント（cc-notify 形式）に変換する。
 * 古い検出は null（通知スパム防止。60秒周期の走査で新規発生は常に fresh）。
 */
export function txCancelEvent(rec, now) {
  if (!rec || !rec.t || now - rec.t > TX_NOTIFY_FRESH_MS) return null
  const cwd = asString(rec.cwd)
  return {
    event: "cc-notify", kind: "Cancel",
    project: cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "" : "",
    branch: "", cwd, sessionId: asString(rec.session),
    message: "ツール呼び出しが中断されました（「続けて」で再開できます）",
    ts: Math.floor(rec.t / 1000),
  }
}

function loadTxState() {
  try { return JSON.parse(fs.readFileSync(TX_STATE_FILE, "utf8")) } catch { return { files: {} } }
}
function saveTxState(st) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(TX_STATE_FILE, JSON.stringify(st)) }
  catch (e) { console.error("tx-state save failed:", e.message) }
}

/** 全プロジェクトのトランスクリプトを増分走査し、見つけたキャンセルを追記。見つけた件数を返す。 */
export function scanTranscriptsOnce(root = TX_ROOT) {
  const st = loadTxState()
  st.files = st.files || {}
  const now = Date.now()
  let found = 0
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return 0 }
  for (const d of dirs) {
    let files = []
    try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".jsonl")) } catch { continue }
    for (const f of files) {
      const p = path.join(root, d, f)
      let stat
      try { stat = fs.statSync(p) } catch { continue }
      const known = st.files[p]
      if (!known && now - stat.mtimeMs > TX_NEW_FILE_WINDOW_MS) {
        st.files[p] = { offset: stat.size }   // 古いファイルは履歴を掘らず末尾から追う
        continue
      }
      let offset = known ? known.offset : 0
      if (stat.size < offset) offset = 0      // truncate された場合は先頭から
      if (stat.size <= offset) continue
      let text = ""
      try {
        const fd = fs.openSync(p, "r")
        const buf = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        text = buf.toString("utf8")
      } catch { continue }
      const lastNl = text.lastIndexOf("\n")
      if (lastNl < 0) continue                 // 末尾の行が未完（書き込み途中）なら次回へ
      const chunk = text.slice(0, lastNl)
      st.files[p] = { offset: offset + Buffer.byteLength(chunk, "utf8") + 1 }
      for (const line of chunk.split("\n")) {
        const rec = txCancelFromLine(line)
        if (rec) {
          appendObserver(JSON.stringify(rec) + "\n")
          found++
          const ev = txCancelEvent(rec, now)   // 新鮮な検出だけ phone へ通知
          if (ev) broadcast(ev)
        }
      }
    }
  }
  for (const p of Object.keys(st.files)) {    // 7日更新の無いエントリは掃除
    try { if (now - fs.statSync(p).mtimeMs > 7 * 86400e3) delete st.files[p] } catch { delete st.files[p] }
  }
  saveTxState(st)
  return found
}

const LS_HOME = process.env.HOME || "/root"
const LS_LIMIT = 500

/** target 配下のサブディレクトリ名（昇順）。読めない/存在しない/ファイル → null。 */
export function listDirs(target, { home = LS_HOME, limit = LS_LIMIT } = {}) {
  const p = target && String(target).trim() ? String(target) : home
  let st
  try { st = fs.statSync(p) } catch { return null }
  if (!st.isDirectory()) return null
  let entries
  try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return null }
  const dirs = []
  for (const e of entries) {
    let isDir = false
    try {
      isDir = e.isDirectory() ||
        (e.isSymbolicLink() && fs.statSync(path.join(p, e.name)).isDirectory())
    } catch { isDir = false }
    if (isDir) dirs.push(e.name)
  }
  dirs.sort((a, b) => a.localeCompare(b))
  const truncated = dirs.length > limit
  return {
    path: p,
    parent: p === "/" ? "/" : path.dirname(p),
    dirs: truncated ? dirs.slice(0, limit) : dirs,
    truncated,
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
    if (req.method === "GET") {
      let u
      try { u = new URL(req.url, "http://x") } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "bad_request" }))
        return
      }
      if (u.pathname.endsWith("/ls")) {
        const result = listDirs(u.searchParams.get("path"))
        if (!result) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "not_a_directory" }))
          return
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(404); res.end(); return
    }
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

// 文字列連結の file:// 比較はパスに空白・非 ASCII があると percent-encoding で一致せず
// 起動しない（exit 0 なので Restart=on-failure も効かない）。pathToFileURL で正規化して比較。
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  createServer().listen(PORT, HOST, () => {
    console.log(`notify-relay on ${HOST}:${PORT}`)
  })
  // トランスクリプト走査: 起動時に1回＋60秒ごと。テスト import では起動しない。
  try { const n = scanTranscriptsOnce(); if (n) console.log(`tx-scan: ${n} cancel(s) found`) } catch {}
  setInterval(() => { try { scanTranscriptsOnce() } catch {} }, TX_SCAN_MS)
}
