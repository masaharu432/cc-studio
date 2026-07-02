import test from "node:test"
import assert from "node:assert"
import net from "node:net"
import crypto from "node:crypto"
import { normalizeEvent, encodeTextFrame, createServer } from "./relay.mjs"

test("normalizeEvent maps fields and derives project", () => {
  const ev = normalizeEvent({ hook_event_name: "Stop", cwd: "/a/proj", session_id: "s1" })
  assert.equal(ev.event, "cc-notify")
  assert.equal(ev.kind, "Stop")
  assert.equal(ev.project, "proj")
  assert.equal(ev.cwd, "/a/proj")
  assert.equal(ev.sessionId, "s1")
})

test("normalizeEvent tolerates junk", () => {
  assert.equal(normalizeEvent(null).kind, "Stop")
  assert.equal(normalizeEvent("x").cwd, "")
  assert.equal(normalizeEvent({}).project, "")
})

test("encodeTextFrame short payload", () => {
  const f = encodeTextFrame("hi")
  assert.equal(f[0], 0x81)
  assert.equal(f[1], 2)
  assert.equal(f.subarray(2).toString(), "hi")
})

test("POST broadcasts to a connected ws client", async () => {
  const server = createServer()
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const key = crypto.randomBytes(16).toString("base64")
  const sock = net.connect(port, "127.0.0.1")
  const msg = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let upgraded = false
    sock.on("error", reject)
    sock.on("connect", () => {
      sock.write(
        `GET /cc-notify/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    })
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d])
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n")
        if (idx === -1) return
        upgraded = true
        buf = buf.subarray(idx + 4)
        // client is registered now (server added it before sending 101) -> fire the POST
        fetch(`http://127.0.0.1:${port}/cc-notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hook_event_name: "Stop", cwd: "/a/proj", session_id: "s1" }),
        }).then((res) => res.json()).then((j) => assert.equal(j.delivered, 1)).catch(reject)
      }
      if (upgraded && buf.length >= 2) {
        let len = buf[1] & 0x7f
        let headerLen = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          headerLen = 4
        }
        if (buf.length >= headerLen + len) {
          resolve(JSON.parse(buf.subarray(headerLen, headerLen + len).toString("utf8")))
        }
      }
    })
  })
  sock.destroy()
  await new Promise((r) => server.close(r))
  assert.equal(msg.event, "cc-notify")
  assert.equal(msg.project, "proj")
  assert.equal(msg.branch, "")
})

import { isObserverBatch, formatBatchRecords, serverKeepaliveLine } from "./relay.mjs"

test("isObserverBatch detects observer batch bodies", () => {
  assert.equal(isObserverBatch({ type: "cc-observer", lines: "{}\n" }), true)
  assert.equal(isObserverBatch({ hook_event_name: "Stop" }), false)
  assert.equal(isObserverBatch(null), false)
  assert.equal(isObserverBatch({ type: "cc-observer" }), false)
})

test("formatBatchRecords appends lines then a server batch marker", () => {
  const out = formatBatchRecords({ type: "cc-observer", device: "d1", sentAt: 111, lines: '{"t":1}\n{"t":2}' }, 999)
  const lines = out.trim().split("\n")
  assert.equal(lines[0], '{"t":1}')
  assert.equal(lines[1], '{"t":2}')
  const marker = JSON.parse(lines[2])
  assert.equal(marker.src, "server")
  assert.equal(marker.kind, "batch")
  assert.equal(marker.t_server, 999)
  assert.equal(marker.device, "d1")
  assert.equal(marker.count, 2)
  assert.equal(marker.sentAt, 111)
})

test("serverKeepaliveLine builds connect/disconnect line", () => {
  const o = JSON.parse(serverKeepaliveLine("disconnect", 555).trim())
  assert.equal(o.src, "server")
  assert.equal(o.kind, "keepalive")
  assert.equal(o.event, "disconnect")
  assert.equal(o.t_server, 555)
})

import { txCancelFromLine } from "./relay.mjs"

const UQ = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."

test("txCancelFromLine extracts a genuine cancel (string content)", () => {
  const line = JSON.stringify({
    type: "user", timestamp: "2026-07-02T07:03:05.523Z",
    cwd: "/mnt/x/cc-studio", sessionId: "4fe4eaaf-fe8a-4b9b-80c5-301ed78519e8",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: UQ }] },
  })
  const r = txCancelFromLine(line)
  assert.ok(r)
  assert.equal(r.src, "cancel")
  assert.equal(r.via, "transcript")
  assert.equal(r.t, Date.parse("2026-07-02T07:03:05.523Z"))
  assert.equal(r.cwd, "/mnt/x/cc-studio")
  assert.equal(r.session, "4fe4eaaf")
})

test("txCancelFromLine extracts array-content variant", () => {
  const line = JSON.stringify({
    type: "user", timestamp: "2026-07-02T07:03:05.523Z", cwd: "/x", sessionId: "abcd1234efgh",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: UQ }] }] },
  })
  assert.ok(txCancelFromLine(line))
})

test("txCancelFromLine rejects mere quotes (contains but not startsWith)", () => {
  const line = JSON.stringify({
    type: "user", timestamp: "2026-07-02T07:00:00Z", cwd: "/x", sessionId: "s",
    message: { content: [{ type: "tool_result", content: "1\t# note quoting: " + UQ }] },
  })
  assert.equal(txCancelFromLine(line), null)
})

test("txCancelFromLine rejects non-user / junk lines", () => {
  assert.equal(txCancelFromLine("not-json " + UQ), null)
  assert.equal(txCancelFromLine(JSON.stringify({ type: "assistant", message: { content: UQ } })), null)
  assert.equal(txCancelFromLine(JSON.stringify({ type: "user", message: { content: "plain " } })), null)
})
