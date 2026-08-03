/**
 * Verifies that the alert-sound duration survives an app restart.
 *
 * Regression guard for the silent-widget incident: the duration used to live in
 * memory only and reset to 0 ("Off") on every relaunch, so no alert could make
 * a sound until an operator re-selected a duration by hand.
 *
 * Usage: node tests/duration-persistence.test.mjs
 */
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

function installFakeLocalStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
  return data
}

const STORAGE_KEY = 'fgc-widget.alert-duration'

// The module reads localStorage lazily (at store instantiation), so the stub
// only has to exist before the first useMyStore() call.
installFakeLocalStorage()
const { useMyStore, DEFAULT_DURATION, DURATION_OPTIONS } = await import('../src/stores/duration.js')

/** Each call models a fresh app launch against the given persisted storage. */
function launchApp(storage) {
  globalThis.localStorage = storage
  setActivePinia(createPinia())
  return useMyStore()
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`PASS  ${name}`)
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}

check('first ever run defaults to an audible duration', () => {
  installFakeLocalStorage()
  const store = launchApp(globalThis.localStorage)
  assert.equal(store.duration, DEFAULT_DURATION)
  assert.ok(DEFAULT_DURATION > 0, 'default must be audible, not Off')
})

check('operator choice is persisted and restored across a restart', () => {
  installFakeLocalStorage()
  const first = launchApp(globalThis.localStorage)
  first.changeDuration(3)
  assert.equal(first.duration, 3)

  const afterRestart = launchApp(globalThis.localStorage)
  assert.equal(afterRestart.duration, 3, 'duration reset on restart')
})

check('an explicit "Off" is respected across a restart', () => {
  installFakeLocalStorage()
  const first = launchApp(globalThis.localStorage)
  first.changeDuration(0)

  const afterRestart = launchApp(globalThis.localStorage)
  assert.equal(afterRestart.duration, 0, 'deliberate Off must not be overridden')
})

check('corrupt stored value falls back to the audible default', () => {
  installFakeLocalStorage({ [STORAGE_KEY]: 'not-a-number' })
  const store = launchApp(globalThis.localStorage)
  assert.equal(store.duration, DEFAULT_DURATION)
})

check('out-of-range stored value falls back to the audible default', () => {
  installFakeLocalStorage({ [STORAGE_KEY]: '99' })
  const store = launchApp(globalThis.localStorage)
  assert.equal(store.duration, DEFAULT_DURATION)
})

check('unsupported durations are rejected and not persisted', () => {
  const data = installFakeLocalStorage()
  const store = launchApp(globalThis.localStorage)
  store.changeDuration(7)
  assert.equal(store.duration, DEFAULT_DURATION, 'invalid value must be ignored')
  assert.equal(data.get(STORAGE_KEY), undefined, 'invalid value must not be written')
})

check('every selectable option round-trips', () => {
  for (const value of DURATION_OPTIONS) {
    installFakeLocalStorage()
    launchApp(globalThis.localStorage).changeDuration(value)
    assert.equal(launchApp(globalThis.localStorage).duration, value, `option ${value} did not persist`)
  }
})

check('unavailable localStorage degrades to the audible default', () => {
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('storage disabled')
    },
    setItem: () => {
      throw new Error('storage disabled')
    },
  }
  setActivePinia(createPinia())
  const store = useMyStore()
  assert.equal(store.duration, DEFAULT_DURATION)
  store.changeDuration(3)
  assert.equal(store.duration, 3, 'in-memory change must still work')
})

check('durationInMilliseconds derives from the restored value', () => {
  installFakeLocalStorage({ [STORAGE_KEY]: '3' })
  const store = launchApp(globalThis.localStorage)
  assert.equal(store.durationInMinutes, 3)
  assert.equal(store.durationInMilliseconds, 180000)
})

console.log(results.join('\n'))
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nAll checks passed.')
