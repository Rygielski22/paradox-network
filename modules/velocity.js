'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

module.exports = {
  name: 'Velocity',
  description: 'Anti-knockback',

  onPlayer (player, relay) {
    if (player._antikbEnabled === undefined) player._antikbEnabled = false
    if (player._antikbPercent === undefined) player._antikbPercent = 0

    player.on('clientbound', (data, des) => {
      if (data.name === 'start_game' && data.params) player._runtimeId = data.params.runtime_entity_id
      if (!player._antikbEnabled) return
      if (data.name === 'set_entity_motion' && data.params) {
        const rid = data.params.runtime_entity_id
        if (rid != null && player._runtimeId != null && String(rid) === String(player._runtimeId)) {
          if (player._antikbPercent === 0) { des.canceled = true }
          else { const s = player._antikbPercent / 100; data.params.velocity.x *= s; data.params.velocity.y *= s; data.params.velocity.z *= s }
        }
      }
    })
  },

  onEnable (relay) {
    registerCommand('velocity', 'Anti-knockback (?velocity on/off/percent <n>)', (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') { player._antikbEnabled = true; sendMessage(player, theme.toggle('Velocity', true, `(${player._antikbPercent}% KB)`)) }
      else if (arg === 'off') { player._antikbEnabled = false; sendMessage(player, theme.toggle('Velocity', false)) }
      else if (arg === 'percent') {
        const val = parseInt(args[1]); if (isNaN(val) || val < 0 || val > 100) { sendMessage(player, theme.error('?velocity percent <0-100>')); return }
        player._antikbPercent = val; sendMessage(player, theme.line('Velocity', `§f${val}% KB`))
      } else sendMessage(player, theme.line('Velocity', `is ${theme.status(player._antikbEnabled)}`))
    })
  }
}


