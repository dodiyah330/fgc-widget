#!/usr/bin/env node
/**
 * Soak / reconnect probe against the production WebSocket (Node built-in WebSocket).
 * Usage: node scripts/ws-soak-probe.mjs [durationMinutes=3]
 *
 * Remains passive like the widget. Ratchet sends protocol-level ping frames;
 * Node/Chromium answer protocol pong frames automatically.
 */
const URL = process.env.WS_URL || 'ws://incivisme.fgc.cat:8080'
const DURATION_MIN = Number(process.argv[2] || 3)
const endAt = Date.now() + DURATION_MIN * 60_000

const closes = []
let opens = 0
let messages = 0
let intentional = false
let socket = null
let reconnectTimer = null
let connectedAt = null
let attempt = 0

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function connect() {
  if (intentional) return
  log('connecting', URL, `attempt=${attempt}`)
  socket = new WebSocket(URL)

  socket.addEventListener('open', () => {
    opens += 1
    connectedAt = Date.now()
    attempt = 0
    log('OPEN')
  })

  socket.addEventListener('message', (event) => {
    messages += 1
    log('message', String(event.data).slice(0, 200))
  })

  socket.addEventListener('close', (event) => {
    const durationMs = connectedAt ? Date.now() - connectedAt : null
    const entry = {
      code: event.code,
      reason: event.reason || '',
      wasClean: event.wasClean,
      durationMs,
      intentional,
      at: new Date().toISOString(),
    }
    closes.push(entry)
    log('CLOSE', entry)
    connectedAt = null
    socket = null
    if (!intentional && Date.now() < endAt) {
      const delay = Math.min(2000 * 2 ** attempt, 30000)
      attempt += 1
      reconnectTimer = setTimeout(connect, delay)
    }
  })

  socket.addEventListener('error', () => {
    log('ERROR (see following CLOSE)')
  })
}

connect()

const watch = setInterval(() => {
  if (Date.now() >= endAt) {
    intentional = true
    clearInterval(watch)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, 'probe_done')
    }
    setTimeout(() => {
      const durations = closes.map((c) => c.durationMs).filter((d) => d != null)
      const spontaneousCloses = closes.filter((c) => !c.intentional)
      const avg =
        durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null
      log('SUMMARY', {
        durationMin: DURATION_MIN,
        opens,
        spontaneousCloses: spontaneousCloses.length,
        messages,
        avgSessionMs: avg,
        closeDurationsMs: durations,
        stillOpen: socket?.readyState === WebSocket.OPEN,
      })
      process.exit(0)
    }, 800)
  }
}, 1000)
