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
        const len = buf[1] & 0x7f
        if (buf.length >= 2 + len) {
          resolve(JSON.parse(buf.subarray(2, 2 + len).toString("utf8")))
        }
      }
    })
  })
  sock.destroy()
  await new Promise((r) => server.close(r))
  assert.equal(msg.event, "cc-notify")
  assert.equal(msg.project, "proj")
})
