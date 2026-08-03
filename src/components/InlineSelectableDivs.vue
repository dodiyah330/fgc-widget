<template>
  <div class="selectable-group">
    <div v-for="(value, index) in values" :key="index" class="selectable-container q-pa-xss">
      <div
        class="radio-box q-ma-xss"
        :class="{ selected: duration === value }"
        @click="selectDiv(value)"
      >
        <div class="inner-circle"></div>
      </div>
      <div class="selectable-value q-ma-xss">{{ printValue(value) }}</div>
    </div>
  </div>
</template>

<script>
import { storeToRefs } from 'pinia'
import { DURATION_OPTIONS, useMyStore } from 'stores/duration.js'

export default {
  name: 'InlineSelectableDivs',
  setup() {
    const store = useMyStore()
    const { duration } = storeToRefs(store) // state and getters need "storeToRefs"

    const printValue = (value) => {
      if (value === 0) {
        return 'Off'
      }
      return value + '’'
    }

    return {
      printValue,
      values: DURATION_OPTIONS,
      duration,
      selectDiv: (value) => store.changeDuration(value),
    }
  },
}
</script>

<style scoped lang="scss">
.selectable-group {
  display: inline-flex;
  //position: absolute;
  //top: 0;
  //left: 0;
  gap: 3.86px;
  //width: 81px;

  .selectable-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-width: 55px;
    //height: 12.62px;
    background: #f2f2f266;
    border-radius: 15px;

    .selectable-value {
      font-weight: 500;
      line-height: 18.02px;
      font-size: 1.1em;
      padding-right: 3.9px;
      color: $dark;
    }
  }
}
</style>
