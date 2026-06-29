'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                           PARADOX NETWORK
 *                    Dark Blue • White • Polished • Animated
 * ═══════════════════════════════════════════════════════════════════════════
 */

process.env.DEBUG = ''
process.removeAllListeners('warning')

// Apply silver-proxy style auth patches (lenient loginVerify + guards)
// This prevents "Server authentication error" on client logins
require('./core/ensure-patches')

const { Relay } = require('bedrock-protocol')
const { Config } = require('./core/config')
const { printParadoxBanner } = require('./core/banner')
const { loadModules, runOnPlayer } = require('./modules/loader')

const path = require('path')
const fs = require('fs')

const config = new Config('./config.json')
const theme = require('./core/theme')
theme.init(config)

// ─── Pack injection (copied from Meteor for Lifeboat compatibility) ────────
const PACK_ZIP = path.join(__dirname, 'paradox_pack.zip')

function needsPackBuild () {
  if (process.env.PARADOX_REBUILD_PACK === '1') return true
  if (!fs.existsSync(PACK_ZIP)) return true
  return false
}

if (needsPackBuild()) {
  try {
    require('./scripts/build-pack')
  } catch (e) {
    console.warn('[Pack] auto-build failed (will use existing zip if present):', e.message)
  }
}

const {
  playerNeedsPackForPlayer,
  markPlayerHasPackForPlayer,
  attachPackStack,
  getPlayerPackKey
} = require('./core/pack-injector')

const relay = new Relay({
  version: config.get('proxy.version'),
  host: config.get('proxy.host'),
  port: config.get('proxy.port'),

  destination: {
    host: config.get('destination.host'),
    port: config.get('destination.port'),
    offline: config.get('destination.offline')
  },

  offline: true,

  // raknet-native caps connections at 3 by default — set maxPlayers so the
  // proxy doesn't report "full" at 3 players and allows up to 100 to join.
  // (Same as Meteor proxy)
  maxPlayers: config.get('proxy.maxPlayers') || 100,

  motd: {
    motd: config.get('proxy.motd'),
    levelName: config.get('proxy.levelName')
  },

  profilesFolder: './auth_tokens',

  onMsaCode (data, player) {
    if (player && player.disconnect) {
      player.disconnect(
        '§1Paradox Network — First-time login\n\n' +
        '§7Visit §fmicrosoft.com/link\n' +
        `§7Enter code §f${data.user_code}\n` +
        '§7Sign in, then reconnect to join.'
      )
    }
  }
})

// ─── Pack injection override (Meteor style for Lifeboat) ───────────────────
const originalOpenUpstream = relay.openUpstreamConnection.bind(relay)

relay.openUpstreamConnection = async function (player, clientAddr) {
  if (config.get('features.enablePackInjection') && playerNeedsPackForPlayer(player)) {
    const packKey = getPlayerPackKey(player)
    console.log(`[Pack] Phase 1 download for ${player.profile?.name || 'Unknown'} (${packKey || 'no-key'})`)
    handlePackDownload(player)
    return
  }

  if (config.get('features.enablePackInjection')) {
    console.log(`[Pack] Phase 2 play for ${player.profile?.name || 'Unknown'} — connecting upstream`)
  }

  return originalOpenUpstream(player, clientAddr)
}

function handlePackDownload (player) {
  const playerName = () => player.profile?.name || 'Unknown'
  const gameVersion = config.get('proxy.version', '1.26.30')
  let installKickScheduled = false

  function scheduleInstallKick () {
    if (installKickScheduled) return
    installKickScheduled = true
    markPlayerHasPackForPlayer(player)
    console.log(`[Pack] ${playerName()} installed — reconnect to play`)
    setTimeout(() => {
      player.disconnect(
        '§1§lPack Installed!\n\n' +
        '§7Paradox HUD has been downloaded.\n' +
        '§7Please §f§lreconnect §7to start playing.'
      )
    }, 1200)
  }

  const packInjector = require('./core/pack-injector')
  if (!packInjector.packBuffer || packInjector.packSize === 0) {
    console.error('Pack buffer is null — cannot serve pack')
    player.disconnect('§cResource pack unavailable.\n§7Please contact server admin.')
    return
  }

  const CHUNK_SIZE = packInjector.CHUNK_SIZE || 1024 * 128
  const originalReadPacket = player.readPacket.bind(player)

  player.readPacket = function (packet) {
    let des
    try {
      des = player.server.deserializer.parsePacketBuffer(packet)
    } catch (e) {
      const head = packet && packet.length ? packet.slice(0, 8).toString('hex') : ''
      console.warn(`[Pack] ${playerName()} parse fail — forwarding (${e.message})${head ? ' buf=' + head : ''}`)
      originalReadPacket(packet)
      return
    }

    const name = des.data.name
    const params = des.data.params

    if (name === 'resource_pack_client_response') {
      const status = params.response_status
      console.log(`[Pack] ${playerName()} → ${status}`)

      if (status === 'refused') {
        player.disconnect('§cPack required.\n§7Enable resource packs in settings and reconnect.')
        return
      }

      if (status === 'send_packs') {
        const chunkCount = Math.ceil(packInjector.packSize / CHUNK_SIZE)
        console.log(`[Pack] ${playerName()} sending ${chunkCount} chunk(s) (${packInjector.packSize} bytes)`)
        player.queue('resource_pack_data_info', {
          pack_id: packInjector.PACK_ID,
          max_chunk_size: CHUNK_SIZE,
          chunk_count: chunkCount,
          size: BigInt(packInjector.packSize),
          hash: packInjector.packHash,
          is_premium: false,
          pack_type: 'resources'
        })
      }

      if (status === 'have_all_packs') {
        player.queue('resource_pack_stack', {
          must_accept: true,
          resource_packs: [{
            uuid: packInjector.PACK_UUID,
            version: packInjector.PACK_VERSION,
            name: packInjector.PACK_NAME || ''
          }],
          game_version: gameVersion,
          experiments: [],
          experiments_previously_used: false,
          has_editor_packs: false
        })
      }

      if (status === 'completed') {
        scheduleInstallKick()
      }

      return
    }

    if (name === 'resource_pack_chunk_request') {
      const offset = Number(params.chunk_index) * CHUNK_SIZE
      const buf = packInjector.packBuffer
      const chunk = buf.slice(offset, offset + CHUNK_SIZE)

      player.queue('resource_pack_chunk_data', {
        pack_id: packInjector.PACK_ID,
        chunk_index: params.chunk_index,
        progress: BigInt(offset),
        payload: chunk
      })
      return
    }

    originalReadPacket(packet)
  }

  const sendPackInfo = () => {
    console.log(`[Pack] Handshake ready for ${playerName()} — advertising ${packInjector.PACK_UUID}`)
    player.queue('resource_packs_info', {
      must_accept: true,
      has_addons: false,
      has_scripts: false,
      disable_vibrant_visuals: false,
      world_template: {
        uuid: '00000000-0000-0000-0000-000000000000',
        version: ''
      },
      texture_packs: [{
        uuid: packInjector.PACK_UUID,
        version: packInjector.PACK_VERSION,
        size: BigInt(packInjector.packSize),
        content_key: '',
        sub_pack_name: '',
        content_identity: '',
        has_scripts: false,
        addon_pack: false,
        rtx_enabled: false,
        cdn_url: ''
      }]
    })
  }

  // Wait for join so client is ready
  if (player.status >= 3) {
    sendPackInfo()
  } else {
    player.once('join', sendPackInfo)
  }
}

// Handle upstream auth / connection errors gracefully (e.g. Microsoft 429 rate limits)
relay.on('error', (err) => {
  const msg = (err && err.message) || String(err)
  if (msg.includes('429') || msg.includes('Too Many Requests')) {
    console.error('[Auth] Microsoft is rate-limiting auth requests (429).')
    console.error('       This usually happens with destination.offline=false + rapid connects or bad caches in auth_tokens/.')
    console.error('       For Lifeboat (premium), offline:false + valid auth_tokens/ is required. Wait or clear stale caches if rate limited.')
  } else {
    console.error('[Relay error]', msg)
  }
})

// Load modules early
loadModules(relay, config)

// Ensure accurate player counts in server list / MOTD.
// Use the real clients map (prevents phantom "3 online" or "full" when empty).
// Combined with maxPlayers this lets 100+ join cleanly (meteor-style).
const origGetAdvertisement = relay.getAdvertisement.bind(relay)
relay.getAdvertisement = function () {
  const ad = origGetAdvertisement()
  try {
    const realCount = Object.keys(this.clients || {}).length
    ad.playersOnline = realCount
    // also keep clientCount in sync
    this.clientCount = realCount
  } catch (_) {}
  return ad
}

relay.on('connect', (player) => {
  const ip = (player.connection?.address || '').split('/')[0] || 'unknown'

  const banned = config.get('security.bannedIPs', [])
  if (banned.includes(ip)) {
    player.disconnect('§cYou are banned from Paradox Network.')
    return
  }

  // Pack stack injection for returning players (Phase 2) — merge our HUD into Lifeboat packs
  if (config.get('features.enablePackInjection')) {
    attachPackStack(player)
  }

  // Run all module player hooks (fly, killaura, arraylist, clickgui...)
  if (config.get('features.enableModules')) {
    const { createLogger } = require('./core/logger')
    runOnPlayer(player, relay, config, createLogger('Paradox'))
  }

  // Keep MOTD / player count fresh in server list pings
  try { relay.raknet?.updateAdvertisement?.() } catch (_) {}
  player.on('close', () => {
    try { relay.raknet?.updateAdvertisement?.() } catch (_) {}
  })
})

relay.listen()

// Beautiful startup banner
printParadoxBanner({
  version: '1.0.0',
  protocol: config.get('proxy.version'),
  host: config.get('proxy.host'),
  port: config.get('proxy.port'),
  target: `${config.get('destination.host')}:${config.get('destination.port')}`,
  prefix: config.get('theme.prefix'),
  maxPlayers: config.get('proxy.maxPlayers')
})

console.log(`${'\x1b[34m'}▶${'\x1b[0m'} ${'\x1b[97m'}Paradox Network is online${'\x1b[0m'}`)
console.log(`${'\x1b[90m'}   Connect using 127.0.0.1:${config.get('proxy.port')}${' \x1b[0m'}\n`)
