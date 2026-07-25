import { defineBoot } from '#q-app/wrappers'
import { useWSStore } from 'stores/ws.js'

// more info on params: https://v2.quasar.dev/quasar-cli-vite/boot-files
export default defineBoot(() => {
  const wsStore = useWSStore()
  wsStore.connect()
})
