'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { isInstantTpFlying } = require('../core/tp-prep')

module.exports = {
  name: 'NoFall',
  description: 'No fall damage — Y-spoof method',

  onPlayer (player, relay) {
    if (player._nofallEnabled === undefined) player._nofallEnabled = false
    player._nofallToggle = false
    player._nofallLastY = 0

    player.on('serverbound', (data) => {
      if (!player._nofallEnabled || isInstantTpFlying(player) ||
          data.name !== 'player_auth_input' || !data.params) return
      player._nofallToggle = !player._nofallToggle
      if (player._nofallToggle) {
        player._nofallLastY = data.params.position?.y || 0
      } else {
        if (data.params.position) data.params.position.y = player._nofallLastY + 0.1
        if (data.params.delta) { data.params.delta.x = 0; data.params.delta.y = 0; data.params.delta.z = 0 }
      }
    })
  },

  onEnable (relay) {
    registerCommand('nofall', 'No fall damage (?nofall on/off)', (player, args) => {
      const arg = (args[0] || '').toLowerCase()
      if (arg === 'on') { player._nofallEnabled = true; player._nofallToggle = false; sendMessage(player, theme.toggle('NoFall', true)) }
      else if (arg === 'off') { player._nofallEnabled = false; sendMessage(player, theme.toggle('NoFall', false)) }
      else sendMessage(player, theme.line('NoFall', `is ${theme.status(player._nofallEnabled)}`))
    })
  }
}


