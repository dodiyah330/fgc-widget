import { acceptHMRUpdate, defineStore } from 'pinia'

export const useMyStore = defineStore('myStore', {
  state: () => ({
    duration: 0,
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
      $store.duration = duration
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMyStore, import.meta.hot))
}
