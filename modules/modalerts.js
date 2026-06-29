'use strict'

const { registerCommand, sendMessage } = require('./chat-commands')
const theme = require('../core/theme')
const { isStaffMod, normalizeName } = require('../core/mod-roster')
const { bindKaEntityTracking } = require('../core/ka-entities')

const MOD_TAG_RE = /\[(mod|admin|staff|helper|owner|builder)\]/i

function isStaff (name) {
  if (!name) return false
  if (isStaffMod(name)) return true
  return MOD_TAG_RE.test(name)
}

function sendHub (player) {
  if (!player.upstream) return
  const msg = '/hub'
  try {
    player.upstream.queue('command_request', {
      command: msg,
      version: 52,
      origin: { type: 'player', uuid: '', request_id: '' }
    })
  } catch (e) {
    try {
      player.upstream.queue('text', {
        type: 'chat',
        needs_translation: false,
        source_name: player.profile?.name || '',
        message: msg,
        xuid: player.profile?.xuid || '',
        platform_chat_id: '',
        filtered_message: ''
      })
    } catch (__) {}
  }
}

function sendTitle (player, title, subtitle) {
  player.queue('set_title', {
    type: 'title', text: title,
    fade_in_time: 5, stay_time: 60, fade_out_time: 20,
    xuid: '', platform_online_id: '', filtered_message: ''
  })
  player.queue('set_title', {
    type: 'subtitle', text: subtitle,
    fade_in_time: 5, stay_time: 60, fade_out_time: 20,
    xuid: '', platform_online_id: '', filtered_message: ''
  })
}

module.exports = {
  name: 'ModAlerts',
  description: 'Alerts when Lifeboat staff join or spectate',

  onPlayer (player) {
    player._modAlertsEnabled = player._modAlertsEnabled || false
    player._modAlertsAutohub = player._modAlertsAutohub || false
    player._maKnownStaff = new Set()
    player._maNearbyAlerted = new Set()
    player._maPlayerList = new Map()
    player._maSpectatorMap = new Set()
    bindKaEntityTracking(player)

    player.on('clientbound', (data) => {
      if (!data?.params) return

      if (data.name === 'player_list') {
        const records = data.params.records?.records || data.params.records || []
        const type = data.params.type ?? data.params.records?.type

        if (type === 'add' || type === 0) {
          for (const record of records) {
            if (!record?.username) continue
            const id = record.uuid || normalizeName(record.username)
            player._maPlayerList.set(id, record.username)
            if (!player._modAlertsEnabled || player._maKnownStaff.has(id)) continue
            if (!isStaff(record.username)) continue

            player._maKnownStaff.add(id)
            sendMessage(player, `§4[!] §cStaff Online §4[!] §f${record.username}`)
            sendTitle(player, '§cStaff Online', `§f${record.username}`)
            if (player._modAlertsAutohub) setTimeout(() => sendHub(player), 500)
          }
        } else if (type === 'remove' || type === 1) {
          for (const record of records) {
            const id = record?.uuid || record?.username
            if (!id) continue
            if (player._maKnownStaff.has(id) && player._modAlertsEnabled) {
              const name = player._maPlayerList.get(id) || record.username || id
              sendMessage(player, `§f${name} §7(staff) left the server`)
            }
            player._maKnownStaff.delete(id)
            player._maNearbyAlerted.delete(id)
            player._maPlayerList.delete(id)
          }
        }
        return
      }

      if (!player._modAlertsEnabled) return

      if (data.name === 'add_player') {
        const name = data.params.username || data.params.name || ''
        const rid = String(data.params.runtime_id ?? '')
        if (!isStaff(name) || player._maNearbyAlerted.has(rid)) return
        player._maNearbyAlerted.add(rid)
        sendMessage(player, `§4[!] §cStaff Nearby §4[!] §f${name}`)
        sendTitle(player, '§cStaff Nearby', `§f${name}`)
        if (player._modAlertsAutohub) setTimeout(() => sendHub(player), 500)
        return
      }

      if (data.name === 'set_entity_data') {
        const rid = String(data.params.runtime_entity_id ?? '')
        if (!rid) return
        for (const entry of (data.params.metadata || [])) {
          if (!entry || (entry.key !== 'player_game_mode' && entry.key !== 46)) continue
          const isSpec = entry.value === 6 || entry.value === 'spectator'
          if (!isSpec) {
            player._maSpectatorMap.delete(rid)
            continue
          }
          if (player._maSpectatorMap.has(rid)) continue
          player._maSpectatorMap.add(rid)

          let name = ''
          for (const [k, ent] of player._kaEntities || []) {
            if (String(k) === rid) { name = ent.name || ''; break }
          }

          sendMessage(player, `§4[!] §cSpectator Detected §4[!]${name ? ` §f${name}` : ''}`)
          sendTitle(player, '§cSpectator Detected', name ? `§f${name}` : '§7unknown')
          if (player._modAlertsAutohub) setTimeout(() => sendHub(player), 500)
        }
        return
      }

      if (data.name === 'remove_entity') {
        const rid = String(data.params.entity_id_self ?? data.params.entity_id ?? '')
        if (rid) {
          player._maNearbyAlerted.delete(rid)
          player._maSpectatorMap.delete(rid)
        }
      }
    })
  },

  onEnable () {
    registerCommand('modalerts', 'Staff join/spectator alerts (?modalerts on/off/autohub)', (player, args) => {
      const cmd = (args[0] || '').toLowerCase()
      if (cmd === 'autohub') {
        player._modAlertsAutohub = !player._modAlertsAutohub
        sendMessage(player, theme.line('ModAlerts', `autohub §f${player._modAlertsAutohub ? 'ON' : 'OFF'}`))
      } else if (cmd === 'on') {
        player._modAlertsEnabled = true
        sendMessage(player, theme.toggle('ModAlerts', true))
      } else if (cmd === 'off') {
        player._modAlertsEnabled = false
        sendMessage(player, theme.toggle('ModAlerts', false))
      } else {
        player._modAlertsEnabled = !player._modAlertsEnabled
        sendMessage(player, theme.toggle('ModAlerts', player._modAlertsEnabled))
      }
    })
  }
}