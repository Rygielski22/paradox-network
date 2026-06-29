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

const packInjector = require('./core/pack-injector')
const {
  playerNeedsPackForPlayer,
  markPlayerHasPackForPlayer,
  attachPackStack,
  getPlayerPackKey
} = packInjector
const { createHandlePackDownload } = require('./core/pack-download')
const { createLogger } = require('./core/logger')
const packLogger = createLogger('Paradox')

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

const handlePackDownload = createHandlePackDownload({
  packInjector,
  markPlayerHasPackForPlayer,
  config,
  logger: packLogger,
  theme
})

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
