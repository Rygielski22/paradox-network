'use strict'

// Status panel binds to #tip_text via text/tip packets (Lifeboat-safe).
// ModStatus module clears the panel when the pulse expires.

const PANEL_MARKER = 'Paradox'
const TIP_SHOW_TOKEN = 'Paradox ·'
const TIP_HIDE_TEXT = '§r§f'
const PULSE_MS = 3500
const KILLAURA_PULSE_MS = 1200

function formatHudText (line) {
  if (!line) return null
  return `§1§l${PANEL_MARKER}§r\n§1${line}`
}

function sanitizePopupLine (line) {
  if (!line) return null
  let s = String(line).replace(/§./g, '').trim()
  s = s.replace(/\s*@\s*\d+(\.\d+)?m\s*$/i, '').trim()
  s = s.replace(/\s*->\s*-?\d+(\s+-?\d+){0,2}\s*$/i, '').trim()
  if (!s || /coord/i.test(s)) return null
  if (/^-?\d+(\s+-?\d+){2}$/.test(s)) return null
  if (/^\d+$/.test(s)) return null
  return s
}

function formatTipText (line) {
  const clean = sanitizePopupLine(line)
  if (!clean) return null
  return `§1§l${TIP_SHOW_TOKEN}§r §1${clean}`
}

function schedulePulseExpiry (player) {
  if (player._msClearTimer) clearTimeout(player._msClearTimer)
  const until = player._msPulseUntil
  const delay = Math.max(50, until - Date.now())
  player._msClearTimer = setTimeout(() => {
    if (!player || player._msPulseUntil !== until) return
    player._msPulseUntil = 0
    player._msPulseLine = null
    player._msActive = false
    player._msLastText = null
    clearHudTip(player)
  }, delay)
}

function triggerStatusPulse (player, line, durationMs = PULSE_MS) {
  if (!player || !line) return
  player._msPulseUntil = Date.now() + durationMs
  player._msPulseLine = line
  const text = formatTipText(line)
  player._msLastText = text
  player._msActive = true
  sendHudTip(player, text)
  schedulePulseExpiry(player)
  try { player.emit('meteor_hud_pulse') } catch (e) {}
}

function pulseLineForModule (player, module, extra) {
  switch (module) {
    case 'automine':
      return `${player._amCluster?.length || 0} ores in cluster`
    case 'tpmine':
      return `${player._tpminePulseCount || 0} ores in cluster`
    case 'chest':
      return 'teleporting to chest'
    case 'camtp':
      return 'teleporting'
    case 'smscan':
      return extra || 'teleporting'
    case 'surface':
      return 'surfacing'
    case 'killaura':
      return sanitizePopupLine(extra) || 'attacking'
    case 'playercoords':
      return extra || 'Finding Players...'
    default:
      return extra || 'teleporting'
  }
}

function triggerModuleTpPulse (player, module, extra, durationMs) {
  const line = pulseLineForModule(player, module, extra)
  const ms = durationMs ?? (module === 'killaura' ? KILLAURA_PULSE_MS : PULSE_MS)
  triggerStatusPulse(player, line, ms)
}

function buildHudText (player) {
  if (!player._msPulseUntil || Date.now() > player._msPulseUntil) return null
  return formatTipText(player._msPulseLine)
}

function isOurHudMessage (msg) {
  return typeof msg === 'string' && (
    msg.includes(TIP_SHOW_TOKEN) ||
    msg.includes(PANEL_MARKER) ||
    msg.includes('ores in cluster') ||
    msg.includes('teleporting') ||
    msg.includes('surfacing') ||
    msg.includes('tp to ') ||
    msg.includes('reach hit') ||
    msg.includes('attacking') ||
    msg.includes('Finding Players') ||
    msg.includes('Syncing position') ||
    msg.includes(' @ ')
  )
}

function shouldBlockServerHud (data, player) {
  if (!player?._msActive) return false
  if (!data?.name) return false

  if (data.name === 'text') {
    const p = data.params
    if (!p || p.type !== 'tip') return false
    if (isOurHudMessage(p.message)) return false
    return true
  }

  return false
}

function sendHudTip (player, text) {
  if (!player || typeof player.queue !== 'function') return
  try {
    player.queue('text', {
      type: 'tip',
      needs_translation: false,
      category: 0,
      message: text || TIP_HIDE_TEXT,
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })
  } catch (e) {}
}

function clearHudTip (player) {
  if (player._msClearTimer) {
    clearTimeout(player._msClearTimer)
    player._msClearTimer = null
  }
  sendHudTip(player, TIP_HIDE_TEXT)
  setImmediate(() => sendHudTip(player, TIP_HIDE_TEXT))
}

module.exports = {
  PANEL_MARKER,
  TIP_SHOW_TOKEN,
  PULSE_MS,
  KILLAURA_PULSE_MS,
  triggerStatusPulse,
  triggerModuleTpPulse,
  buildHudText,
  shouldBlockServerHud,
  sendHudTip,
  clearHudTip,
  formatHudText,
  formatTipText,
  sanitizePopupLine
}