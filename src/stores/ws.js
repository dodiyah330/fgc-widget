import { acceptHMRUpdate, defineStore } from 'pinia'

// const URL = 'ws://localhost:5901/numbers'
//const URL = 'ws://incivisme-alertes.informagedevelop.com:6018'
//const URL = 'ws://dev-fgc-incivisme.iboomobile.com:6018'
const URL = 'ws://incivisme.fgc.cat:8080'

/** Keep under common proxy/LB idle timeouts (~60–120s). */
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 30_000

/** Module-scoped timers (not Pinia state). */
let heartbeatTimer = null
let heartbeatTimeout = null
let reconnectTimer = null
let awaitingPong = false
let intentionalDisconnect = false

function newWsMessage() {
  return { id: generateUuid(), alerts: 0, notify: false, stopAlert: false }
}

function logWs(level, message, detail) {
  const prefix = '[WS]'
  if (detail !== undefined) {
    console[level](prefix, message, detail)
  } else {
    console[level](prefix, message)
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout)
    heartbeatTimeout = null
  }
  awaitingPong = false
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

export const useWSStore = defineStore('ws', {
  state: () => ({
    wsStatus: WebSocket.CLOSED,
    wsMessage: newWsMessage(),
    ws: null,
    lastClose: null,
    reconnectAttempt: 0,
    connectedAt: null,
  }),
  getters: {
    isOffline() {
      return this.wsStatus === WebSocket.CLOSED
    },
    isConnecting() {
      return this.wsStatus === WebSocket.CONNECTING
    },
    isOnline() {
      return this.wsStatus === WebSocket.OPEN
    },
  },
  actions: {
    _startHeartbeat() {
      const $store = this
      clearHeartbeat()

      heartbeatTimer = setInterval(() => {
        if ($store.wsStatus !== WebSocket.OPEN || !$store.ws) {
          return
        }

        // Outbound traffic resets many proxy/LB idle timers even without a pong.
        try {
          $store.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
        } catch (err) {
          logWs('error', 'heartbeat ping failed', err)
          $store._handleDeadConnection('ping_send_failed')
          return
        }

        awaitingPong = true
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout)
        }
        heartbeatTimeout = setTimeout(() => {
          if (awaitingPong) {
            // Soft warning only: server may not implement pong; ping still keeps proxies awake.
            logWs('warn', 'heartbeat pong not received (server may not support pong)')
            awaitingPong = false
          }
        }, HEARTBEAT_TIMEOUT_MS)
      }, HEARTBEAT_INTERVAL_MS)
    },

    _handleDeadConnection(reason) {
      logWs('warn', 'treating connection as dead', reason)
      clearHeartbeat()
      const socket = this.ws
      this.ws = null
      this.wsStatus = WebSocket.CLOSED
      if (socket) {
        try {
          socket.onopen = null
          socket.onclose = null
          socket.onmessage = null
          socket.onerror = null
          socket.close()
        } catch {
          /* ignore */
        }
      }
      if (!intentionalDisconnect) {
        this._scheduleReconnect()
      }
    },

    _scheduleReconnect() {
      const $store = this
      if (intentionalDisconnect || reconnectTimer) {
        return
      }

      const attempt = $store.reconnectAttempt
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
      $store.reconnectAttempt = attempt + 1

      logWs('log', `scheduling reconnect in ${delay}ms (attempt ${$store.reconnectAttempt})`)

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        logWs('log', 'reconnecting...')
        $store.connect()
      }, delay)
    },

    _applyAlertPayload(response) {
      const $store = this
      if (typeof response.alerts === 'number') {
        $store.wsMessage.alerts = response.alerts
        $store.wsMessage.notify = Boolean(response.notify)
        $store.wsMessage.id = generateUuid()
        $store.wsMessage.stopAlert = false
      }
    },

    _onMessage(event) {
      const $store = this
      let response
      try {
        response = JSON.parse(event.data)
      } catch (err) {
        logWs('error', 'invalid JSON message', err)
        return
      }

      // Any inbound frame proves liveness.
      awaitingPong = false
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout)
        heartbeatTimeout = null
      }

      const type = Object.hasOwnProperty.call(response, 'type') ? response.type : null

      if (type === 'ping') {
        // Server may echo our ping or send its own; reply with pong.
        if ($store.wsStatus === WebSocket.OPEN && $store.ws) {
          try {
            $store.ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
          } catch {
            /* ignore */
          }
        }
        return
      }

      if (type === 'pong') {
        return
      }

      if (type === 'stop_alerts') {
        logWs('log', 'stop_alerts received')
        $store.wsMessage.stopAlert = true
        $store.wsMessage.notify = false
        return
      }

      // Snapshot / sync / alert payloads (with or without type)
      if (type === 'sync' || type === 'status' || type === null) {
        if (typeof response.alerts === 'number') {
          logWs('log', 'alert payload', { alerts: response.alerts, notify: response.notify, type })
        }
        $store._applyAlertPayload(response)
        return
      }

      if (typeof response.alerts === 'number') {
        logWs('log', 'alert payload', { alerts: response.alerts, notify: response.notify, type })
        $store._applyAlertPayload(response)
      }
    },

    requestSync() {
      const $store = this
      if ($store.wsStatus === WebSocket.OPEN && $store.ws) {
        try {
          $store.ws.send(JSON.stringify({ type: 'sync' }))
          logWs('log', 'sync requested')
        } catch (err) {
          logWs('error', 'sync request failed', err)
        }
      }
    },

    disconnect() {
      const $store = this
      intentionalDisconnect = true
      clearHeartbeat()
      clearReconnectTimer()
      $store.reconnectAttempt = 0

      if ($store.ws) {
        try {
          $store.ws.onopen = null
          $store.ws.onclose = null
          $store.ws.onmessage = null
          $store.ws.onerror = null
          $store.ws.close(1000, 'client_disconnect')
        } catch {
          /* ignore */
        }
        $store.ws = null
      }
      $store.wsStatus = WebSocket.CLOSED
      $store.connectedAt = null
    },

    /**
     * Force a clean reconnect (sleep/resume, network online).
     */
    forceReconnect(reason = 'force') {
      logWs('log', 'force reconnect', reason)
      intentionalDisconnect = false
      clearHeartbeat()
      clearReconnectTimer()

      const socket = this.ws
      this.ws = null
      this.wsStatus = WebSocket.CLOSED
      this.connectedAt = null

      if (socket) {
        try {
          socket.onopen = null
          socket.onclose = null
          socket.onmessage = null
          socket.onerror = null
          socket.close(4000, reason)
        } catch {
          /* ignore */
        }
      }

      this.reconnectAttempt = 0
      this.connect()
    },

    sendStopAlertMessage() {
      const $store = this

      if ($store.wsStatus === WebSocket.OPEN && $store.ws) {
        logWs('log', 'sending stop_alerts')
        $store.ws.send(JSON.stringify({ type: 'stop_alerts' }))
      }
    },

    connect() {
      const $store = this

      if ($store.wsStatus === WebSocket.OPEN || $store.wsStatus === WebSocket.CONNECTING) {
        return
      }

      intentionalDisconnect = false
      clearReconnectTimer()
      $store.wsStatus = WebSocket.CONNECTING

      if ($store.ws) {
        try {
          $store.ws.onopen = null
          $store.ws.onclose = null
          $store.ws.onmessage = null
          $store.ws.onerror = null
          $store.ws.close()
        } catch {
          /* ignore */
        }
        $store.ws = null
      }

      let ws
      try {
        ws = new WebSocket(URL)
      } catch (err) {
        logWs('error', 'WebSocket constructor failed', err)
        $store.wsStatus = WebSocket.CLOSED
        $store._scheduleReconnect()
        return
      }

      $store.ws = ws
      logWs('log', 'connecting', URL)

      ws.onopen = function (event) {
        const openedAt = Date.now()
        $store.connectedAt = openedAt
        $store.wsStatus = event.target.readyState
        $store.reconnectAttempt = 0
        logWs('log', 'connection established', { url: URL, at: openedAt })
        $store._startHeartbeat()
        $store.requestSync()
      }

      ws.onclose = function (event) {
        const closedAt = Date.now()
        const durationMs = $store.connectedAt ? closedAt - $store.connectedAt : null
        const info = {
          code: event.code,
          reason: event.reason || '',
          wasClean: event.wasClean,
          at: closedAt,
          durationMs,
        }
        $store.lastClose = info
        logWs('warn', 'connection closed', info)

        clearHeartbeat()
        if ($store.ws === ws) {
          $store.ws = null
        }
        $store.wsStatus = WebSocket.CLOSED
        $store.connectedAt = null

        if (!intentionalDisconnect) {
          $store._scheduleReconnect()
        }
      }

      ws.onmessage = function (event) {
        $store._onMessage(event)
      }

      ws.onerror = function () {
        logWs('error', 'socket error (see following close event for code/reason)')
      }
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWSStore, import.meta.hot))
}

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
