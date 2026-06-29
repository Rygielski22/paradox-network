'use strict'

const { sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

module.exports = {
  name: 'JoinMessage',
  description: 'Welcome message on join',

  onPlayer (player) {
    let welcomed = false

    player.on('clientbound', (data) => {
      if (data.name === 'play_status' && data.params?.status === 'player_spawn' && !welcomed) {
        welcomed = true
        try {
          player.queue('set_title', {
            type: 'title',
            text: '§1§lParadox Network',
            fade_in_time: 10,
            stay_time: 50,
            fade_out_time: 15,
            xuid: '',
            platform_online_id: '',
            filtered_message: ''
          })
        } catch (_) {}
        sendMessage(player, theme.heading('Welcome to Paradox Network'))
        sendMessage(player, `${theme.accent}Use ?help for commands`)
      }
    })
  }
}