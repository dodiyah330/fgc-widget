import { acceptHMRUpdate, defineStore } from 'pinia'

/** Selectable alert-sound durations in minutes; 0 means "Off". */
export const DURATION_OPTIONS = [0, 1, 3]

/**
 * First-run default. A missed sound is reported as a missed alert, so the
 * widget must be audible before anyone touches the selector.
 */
export const DEFAULT_DURATION = 1

const STORAGE_KEY = 'fgc-widget.alert-duration'

function isValidDuration(value) {
  return DURATION_OPTIONS.includes(value)
}

/**
 * The operator's choice has to survive an app restart: until this was
 * persisted, every relaunch silently reset the widget to "Off" and no alert
 * could produce sound until someone re-selected a duration by hand.
 */
function loadDuration() {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_DURATION
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === null) {
      return DEFAULT_DURATION
    }

    const parsed = Number(stored)
    // An explicit "Off" is honoured; anything unrecognised falls back audible.
    return isValidDuration(parsed) ? parsed : DEFAULT_DURATION
  } catch (err) {
    console.error('[duration] could not read stored alert duration', err)
    return DEFAULT_DURATION
  }
}

function saveDuration(duration) {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    localStorage.setItem(STORAGE_KEY, String(duration))
  } catch (err) {
    console.error('[duration] could not persist alert duration', err)
  }
}

export const useMyStore = defineStore('myStore', {
  state: () => ({
    duration: loadDuration(),
  }),
  getters: {
    durationInMinutes() {
      return this.duration
    },
    durationInMilliseconds() {
      return this.duration * 60000
    },
  },
  actions: {
    changeDuration(duration) {
      const $store = this

      if (!isValidDuration(duration)) {
        return
      }

      $store.duration = duration
      saveDuration(duration)
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMyStore, import.meta.hot))
}
