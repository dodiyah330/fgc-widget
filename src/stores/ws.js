import { acceptHMRUpdate, defineStore } from 'pinia'

// const URL = 'ws://localhost:5901/numbers'
//const URL = 'ws://incivisme-alertes.informagedevelop.com:6018'
//const URL = 'ws://dev-fgc-incivisme.iboomobile.com:6018'
const URL = 'ws://incivisme.fgc.cat:8080'

const CONNECT_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 30_000

/** Module-scoped timers (not Pinia state). */
let reconnectTimer = null
let connectTimeout = null
let intentionalDisconnect = false
let hasConnectedOnce = false
let awaitingRecoverySnapshot = false

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

function clearConnectTimeout() {
  if (connectTimeout) {
    clearTimeout(connectTimeout)
    connectTimeout = null
  }
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
        const recoveredMissedAlerts =
          awaitingRecoverySnapshot && response.alerts > $store.wsMessage.alerts
        awaitingRecoverySnapshot = false

        $store.wsMessage.alerts = response.alerts
        $store.wsMessage.notify = Boolean(response.notify) || recoveredMissedAlerts
        $store.wsMessage.id = generateUuid()
        $store.wsMessage.stopAlert = false

        if (recoveredMissedAlerts) {
          logWs('warn', 'higher count recovered after reconnect', { alerts: response.alerts })
        }
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

      const type = Object.hasOwnProperty.call(response, 'type') ? response.type : null

      if (type === 'ping') {
        // Optional application-level compatibility. Ratchet protocol ping/pong
        // frames are handled automatically by Chromium and are not exposed here.
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

    disconnect() {
      const $store = this
      intentionalDisconnect = true
      hasConnectedOnce = false
      awaitingRecoverySnapshot = false
      clearConnectTimeout()
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
      clearConnectTimeout()
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

      connectTimeout = setTimeout(() => {
        if ($store.ws === ws && $store.wsStatus === WebSocket.CONNECTING) {
          logWs('warn', `connection attempt timed out after ${CONNECT_TIMEOUT_MS}ms`)
          try {
            ws.close()
          } catch (err) {
            logWs('error', 'failed to abort timed-out connection', err)
            $store.ws = null
            $store.wsStatus = WebSocket.CLOSED
            $store._scheduleReconnect()
          }
        }
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = function (event) {
        clearConnectTimeout()
        const openedAt = Date.now()
        awaitingRecoverySnapshot = hasConnectedOnce
        hasConnectedOnce = true
        $store.connectedAt = openedAt
        $store.wsStatus = event.target.readyState
        $store.reconnectAttempt = 0
        logWs('log', 'connection established', { url: URL, at: openedAt })
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

        clearConnectTimeout()
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
