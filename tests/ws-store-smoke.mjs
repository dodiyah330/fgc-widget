import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({ target: this })
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

globalThis.WebSocket = FakeWebSocket
setActivePinia(createPinia())

const { useWSStore } = await import('../src/stores/ws.js')
const store = useWSStore()

store.connect()
assert.equal(FakeWebSocket.instances.length, 1)
assert.equal(store.isConnecting, true)

const first = FakeWebSocket.instances[0]
first.open()
assert.equal(store.isOnline, true)
assert.deepEqual(first.sent, [], 'Widget must not send JSON ping/sync on open.')

first.message({ alerts: 7, notify: false })
assert.equal(store.wsMessage.alerts, 7)
assert.equal(store.wsMessage.notify, false, 'Initial snapshot must not notify.')

store.forceReconnect('test')
assert.equal(FakeWebSocket.instances.length, 2)
assert.equal(first.readyState, FakeWebSocket.CLOSED)

const second = FakeWebSocket.instances[1]
second.open()
second.message({ alerts: 8, notify: false })
assert.equal(store.wsMessage.alerts, 8)
assert.equal(store.wsMessage.notify, true, 'Higher count recovered after reconnect must notify.')

store.disconnect()
assert.equal(store.isOffline, true)

console.log('WebSocket store smoke tests passed.')
