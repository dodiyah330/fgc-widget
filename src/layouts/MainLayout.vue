<template>
  <div :class="cssClassColor" class="main-box text-center q-electron-drag q-pa-md">
    <div v-if="isOffline || isConnecting" title="CONNECTANT">
      <q-spinner-radio name="wifi_off" size="xs" class="offline-icon" color="warning" />
    </div>
    <div class="issue-num q-ma-xs">
      <span @click="openLink" class="cursor-pointer q-electron-drag--exception">
        {{ issues }}
      </span>
    </div>
    <div class="issue-text q-pt-xs">
      <span class="cursor-pointer q-electron-drag--exception" @click="openLink"> INCIDÈNCIES </span>
    </div>
    <div class="q-pa-xs q-electron-drag--exception">
      <inline-selectable-divs v-if="isOnline" />
      <div class="offline-text" v-else>
        <span class="d">DESCONECTAT</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.main-box {
  &.offline {
    background-color: $negative;
  }

  .btn-group {
    //width: 160.87px;
    //height: 24.62px;
    position: relative;
  }

  .offline-icon {
    position: absolute;
    top: 5px;
    right: 5vh;
    //display: none;
  }

  .offline-text {
    display: flex;
    flex-direction: column;
    justify-content: center;
    justify-items: center;
    align-items: center;

    .d {
      color: $warning;
      font-size: 15px;
      font-weight: 600;
    }
  }
}
</style>
<script setup>
import { computed, onBeforeUnmount, onUnmounted, ref, watch } from 'vue'
import InlineSelectableDivs from 'components/InlineSelectableDivs.vue'
import { storeToRefs } from 'pinia'
import { useWSStore } from 'stores/ws.js'
import { useMyStore } from 'stores/duration.js'

const myStore = useMyStore()
const wsStore = useWSStore()
const { isOffline, isOnline, isConnecting } = storeToRefs(wsStore)
const { durationInMinutes } = storeToRefs(myStore)

// Derive the visible count directly from the store so a fast initial server
// snapshot cannot arrive before the layout watcher is registered.
const issues = computed(() => wsStore.wsMessage.alerts)
const currentColorIndex = ref(0)
const playingAudio = ref(false)
const audio = new Audio(window.myAPI ? window.myAPI.audioFile : 'src/assets/audio/bells.wav')

const cssClassColor = computed(() => {
  return colors[currentColorIndex.value]
})
// New variables for background color handling
const colors = ['bg-alert-off', 'bg-alert-on'] // Add actual color classes or inline styles here

// Timeouts vars
let colorIntervalId = null
let audioTimeoutId = undefined
let disposeLifecycleListeners = null

//-----------------------------------------
//------------ FUNCTIONS ------------------
//-----------------------------------------
function playAudio() {
  audio.loop = true
  // play() rejects if the media cannot start; surface it in the log instead of
  // failing silently, because a missed sound is reported as a missed alert.
  const started = audio.play()
  if (started && typeof started.catch === 'function') {
    started.catch((err) => console.error('[WS] alert sound failed to play', err))
  }
  playingAudio.value = true
}

function stopAudio() {
  audio.pause()
  audio.currentTime = 0
  playingAudio.value = false
}

function openLink() {
  if (process.env.MODE === 'electron') {
    window.myAPI.openLink().then(() => {
      wsStore.sendStopAlertMessage()
    })
  }
}

// Start a background color switcher
function startColorSwitching() {
  colorIntervalId = setInterval(() => {
    currentColorIndex.value = (currentColorIndex.value + 1) % colors.length
  }, 500) // 0.5 seconds
}

// Stop the background color switcher
function stopColorSwitching() {
  clearInterval(colorIntervalId)
  colorIntervalId = null
  currentColorIndex.value = 0
}

function stopAlerts() {
  clearTimeout(audioTimeoutId)
  audioTimeoutId = undefined
  stopAudio()
  stopColorSwitching()

  // issues.value = 0
}

onBeforeUnmount(() => {
  stopColorSwitching()
  stopAudio()
  if (typeof disposeLifecycleListeners === 'function') {
    disposeLifecycleListeners()
    disposeLifecycleListeners = null
  }
})

onUnmounted(() => {
  wsStore.disconnect()
})

// Sleep/resume + network recovery (Electron); browser online as fallback
if (typeof window !== 'undefined') {
  const onOnline = () => {
    console.log('[WS] browser online — force reconnect')
    wsStore.forceReconnect('browser_online')
  }
  window.addEventListener('online', onOnline)

  const unsubs = []
  if (window.myAPI?.onPowerResume) {
    unsubs.push(window.myAPI.onPowerResume(() => wsStore.forceReconnect('power_resume')))
  }
  if (window.myAPI?.onNetworkChange) {
    unsubs.push(
      window.myAPI.onNetworkChange((status) => {
        if (status === 'online') {
          wsStore.forceReconnect('network_online')
        }
      }),
    )
  }

  disposeLifecycleListeners = () => {
    window.removeEventListener('online', onOnline)
    unsubs.forEach((u) => {
      if (typeof u === 'function') u()
    })
  }
}

watch(durationInMinutes, (newValue) => {
  clearTimeout(audioTimeoutId)

  if (newValue && wsStore.wsMessage.notify && colorIntervalId) {
    playAudio()
    audioTimeoutId = setTimeout(stopAudio, myStore.durationInMilliseconds)

    return
  }

  stopAudio()
})

watch(wsStore.wsMessage, (newValue) => {
  if (!newValue) {
    return
  }

  if (newValue.notify) {
    stopColorSwitching()
    startColorSwitching()

    if (durationInMinutes.value) {
      clearTimeout(audioTimeoutId)
      audioTimeoutId = undefined
      stopAudio()

      playAudio()
      audioTimeoutId = setTimeout(stopAudio, myStore.durationInMilliseconds)
    }
  } // nothing to do when notify is false, at least there is nothing from client opinion

  if (newValue.stopAlert === true) {
    stopAlerts()
  }
}, { immediate: true })

watch(isOffline, (offline) => {
  if (!offline && wsStore.wsStatus === WebSocket.OPEN) {
    if (wsStore.wsMessage && wsStore.wsMessage.notify) {
      startColorSwitching()

      if (myStore.durationInMinutes) {
        playAudio()
        audioTimeoutId = setTimeout(stopAudio, myStore.durationInMilliseconds)
      }
    }

    if (wsStore.wsMessage && wsStore.wsMessage.stopAlert) {
      stopAlerts()
    }
    return
  }

  if (offline || wsStore.wsStatus === WebSocket.CLOSED) {
    stopAlerts()
  }
  // Reconnect is owned by the WS store (backoff + heartbeat failure handling)
})
</script>
