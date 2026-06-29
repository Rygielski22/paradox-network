'use strict'

/** Shared ESP / HUD refresh rate — 4 auth ticks ≈ 5 Hz at 20 TPS, 10 Hz at 40 TPS. */
const ESP_UPDATE_TICKS = 4

function shouldEspTick (counter, interval = ESP_UPDATE_TICKS) {
  return counter % interval === 0
}

module.exports = { ESP_UPDATE_TICKS, shouldEspTick }