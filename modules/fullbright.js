'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { queueClientMobEffect } = require('../core/protocol')

const NIGHT_VISION_ID = 16

module.exports = {
  name: 'Fullbright',
  description: 'See in the dark',

  onPlayer (player, relay) {
    if (player._fbEnabled === undefined) player._fbEnabled = false
    player._fbTick = 0

    player.on('clientbound', (data) => {
      if (data.name === 'start_game' && data.params) player._runtimeId = data.params.runtime_entity_id
    })

    player.on('serverbound', (data) => {
      if (!player._fbEnabled || data.name !== 'player_auth_input' || !player._runtimeId) return
      player._fbTick++
      if (player._fbTick % 20 !== 0) return
      queueClientMobEffect(player, { runtime_entity_id: player._runtimeId, event_id: 'add', effect_id: NIGHT_VISION_ID, amplifier: 0, particles: false, duration: 360000, tick: 0 })
    })
  },

  onEnable (relay) {
    registerCommand('fullbright', 'Night vision (?fullbright on/off)', (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') { player._fbEnabled = true; player._fbTick = 19; sendMessage(player, theme.toggle('Fullbright', true)) }
      else if (arg === 'off') {
        player._fbEnabled = false
        if (player._runtimeId) queueClientMobEffect(player, { runtime_entity_id: player._runtimeId, event_id: 'remove', effect_id: NIGHT_VISION_ID, amplifier: 0, particles: false, duration: 0, tick: 0 })
        sendMessage(player, theme.toggle('Fullbright', false))
      } else sendMessage(player, theme.line('Fullbright', `is ${theme.status(player._fbEnabled)}`))
    })
  }
}


