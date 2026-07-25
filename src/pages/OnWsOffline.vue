<template>
  <div class="main-box text-center q-electron-drag q-pa-xs">
    <div class="q-ma-xs">
      <q-icon name="wifi_off" size="xl" color="white" />
    </div>
    <div class="issue-text q-pt-xs">
      <span class=" q-pl-xs text-white">
      DESCONECTADO
    </span>
    </div>

    <!-- buttons-->
    <div class="info-trying q-pa-xs">
      <span class="q-pl-xs">
        RECONECTANDO
{{ myGlobalProperty}}
      </span>
      </div>
  </div>

</template>
<style lang="scss" scoped>
.main-box {
  background-color: $danger;

  .issue-text{
    line-height: 16px;
    margin: 10px;
    font-weight: bold;
  }
  .info-trying{
    color:white;
    opacity: 0.7;
    font-style: italic;
  }
}
</style>

<script setup>



import { getCurrentInstance } from 'vue';

const { appContext } = getCurrentInstance();
const myGlobalProperty = appContext.config.globalProperties.$wss
</script>
