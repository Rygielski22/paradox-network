'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')

module.exports = {
  name: 'JoinAlerts',
  description: 'Alerts when players join or leave the server using player list',
  category: 'Utility',
  visible: true,

  onEnable (relay) {
    const handler = (player, args) => {
      if (player._joinAlertEnabled === undefined) {
        player._joinAlertEnabled = true
      }
      player._joinAlertEnabled = !player._joinAlertEnabled
      sendMessage(player, theme.toggle('JoinAlerts', player._joinAlertEnabled))
    }
    registerCommand('joinalerts', 'A cheat that displays who joins and leaves', handler)
  },

  onPlayer (player, relay) {
    if (player._joinAlertEnabled === undefined) {
      player._joinAlertEnabled = false
    }
    if (!player._lastPlayerList) {
      player._lastPlayerList = new Map()
    }

    player.on('clientbound', (data) => {
      if (data.name !== 'player_list' || !data.params?.records) return
      const type = data.params.type || data.params.records.type
      const records = data.params.records.records || []

      if (type === 'add' || type === 0) {
        for (const record of records) {
          if (!record.username) continue
          const id = record.uuid || record.username
          const name = record.username
          if (!player._lastPlayerList.has(id)) {
            player._lastPlayerList.set(id, { name: name, uuid: record.uuid })
            if (player._joinAlertEnabled) {
              sendMessage(player, `§a[+] §f${name} §7joined the server.`)
            }
          }
        }
      } else if (type === 'remove' || type === 1) {
        for (const record of records) {
          const id = record.uuid || record.username
          let name = record.username
          if (!name && record.uuid && player._lastPlayerList.has(record.uuid)) {
            name = player._lastPlayerList.get(record.uuid).name
          }
          if (id && player._lastPlayerList.has(id)) {
            const cached = player._lastPlayerList.get(id)
            name = name || cached.name
            player._lastPlayerList.delete(id)
          }
          if (name && player._joinAlertEnabled) {
            sendMessage(player, `§c[-] §f${name} §7left the server.`)
          }
        }
      }
    })
  }
}


