#!/usr/bin/env node
/**
 * Idle control probe: connect and do NOT send heartbeat.
 * Confirms whether ~120s idle close is infra-side.
 * Usage: node scripts/ws-idle-probe.mjs [durationMinutes=3]
 */
const URL = process.env.WS_URL || 'ws://incivisme.fgc.cat:8080'
const DURATION_MIN = Number(process.argv[2] || 3)
const endAt = Date.now() + DURATION_MIN * 60_000

const closes = []
let opens = 0
let intentional = false
let socket = null
let connectedAt = null

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function connect() {
  log('connecting (NO heartbeat)', URL)
  socket = new WebSocket(URL)

  socket.addEventListener('open', () => {
    opens += 1
    connectedAt = Date.now()
    log('OPEN — sitting idle')
  })

  socket.addEventListener('message', (event) => {
    log('message', String(event.data).slice(0, 200))
  })

  socket.addEventListener('close', (event) => {
    const durationMs = connectedAt ? Date.now() - connectedAt : null
    const entry = {
      code: event.code,
      reason: event.reason || '',
      wasClean: event.wasClean,
      durationMs,
      durationSec: durationMs != null ? Math.round(durationMs / 1000) : null,
      at: new Date().toISOString(),
    }
    closes.push(entry)
    log('CLOSE', entry)
    connectedAt = null
    socket = null
  })

  socket.addEventListener('error', () => log('ERROR'))
}

connect()

const watch = setInterval(() => {
  if (Date.now() >= endAt) {
    intentional = true
    clearInterval(watch)
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, 'probe_done')
    }
    setTimeout(() => {
      log('SUMMARY', { opens, closes, stillOpen: socket?.readyState === WebSocket.OPEN })
      process.exit(0)
    }, 800)
  }
}, 1000)
