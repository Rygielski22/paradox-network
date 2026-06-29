'use strict'

const {
  buildHudText,
  sendHudTip,
  clearHudTip,
  shouldBlockServerHud
} = require('../core/mod-status')

const REFRESH_TICKS = 5

function pushStatus (player, force) {
  const text = buildHudText(player)
  const active = !!text
  const expired = player._msPulseUntil && Date.now() > player._msPulseUntil

  if (expired) {
    player._msPulseUntil = 0
    player._msPulseLine = null
    if (player._msActive || player._msLastText) {
      player._msLastText = null
      player._msActive = false
      clearHudTip(player)
    }
    return
  }

  if (!force && text === player._msLastText && active === player._msActive) return

  player._msLastText = text
  player._msActive = active

  if (text) sendHudTip(player, text)
  else clearHudTip(player)
}

module.exports = {
  name: 'ModStatus',
  description: 'Bottom-right status pulse — auto-clears after attack/TP events',

  onEnable () {},

  onPlayer (player) {
    player._msTick = 0
    player._msLastText = undefined
    player._msActive = false
    player._msPulseUntil = 0
    player._msPulseLine = null

    player.on('meteor_hud_pulse', () => pushStatus(player, true))

    player.on('clientbound', (data, des) => {
      if (!shouldBlockServerHud(data, player)) return
      if (des) des.canceled = true
      setImmediate(() => pushStatus(player, true))
    })

    player.on('clientbound', ({ name }) => {
      if (name === 'play_status' || name === 'set_local_player_as_initialized' || name === 'start_game') {
        setTimeout(() => pushStatus(player, true), 400)
      }
    })

    player.on('serverbound', (data) => {
      if (data.name !== 'player_auth_input') return
      player._msTick++
      if (player._msTick % REFRESH_TICKS !== 0) return
      pushStatus(player, player._msActive || player._msTick % (REFRESH_TICKS * 6) === 0)
    })
  }
}