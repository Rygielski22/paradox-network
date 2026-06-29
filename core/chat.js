'use strict'

const TAG = '§1[Paradox]§r'

function softenGray (text) {
  return String(text)
    .replace(/[━»⚔✓☠🎲✦→]/g, '')
    .replace(/§([0-9a-f])/gi, (match, hex) => {
      if (hex === '1') return match
      return '§8'
    })
}

function formatSystemText (text) {
  if (text == null) return ''
  if (typeof text !== 'string') text = String(text)
  if (text.includes('[Paradox]')) return softenGray(text)

  const lines = text.split('\n')
  return lines.map((line) => {
    if (!line.trim()) return line
    return `${TAG} ${softenGray(line)}`
  }).join('\n')
}

function sendSystemChat (player, text) {
  if (!player || typeof player.queue !== 'function') return
  player.queue('text', {
    type: 'system',
    needs_translation: false,
    category: 0,
    message: formatSystemText(text),
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: false
  })
}

module.exports = { sendSystemChat, formatSystemText, TAG }