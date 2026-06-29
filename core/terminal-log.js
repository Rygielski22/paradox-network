'use strict'

/**
 * Clean terminal output for pm2 / local console.
 * - Session banner on each proxy start
 * - Ore-scan lines tagged [Ore]
 * - Relay parse errors rate-limited and summarized (no spam)
 */

const fs = require('fs')
const path = require('path')

const SESSION_ID = Date.now().toString(36)
const WARN_COOLDOWN_MS = 8000
const warnLast = new Map()

let sessionBannerPrinted = false

function stamp () {
  const d = new Date()
  return d.toISOString().replace('T', ' ').substring(11, 19)
}

function line (tag, color, msg) {
  console.log(`\x1b[90m${stamp()}\x1b[0m ${color}[${tag}]\x1b[0m ${msg}`)
}

function beginSession (meta = {}) {
  if (sessionBannerPrinted) return
  sessionBannerPrinted = true
  console.log('')
  console.log('\x1b[35m══════════════════════════════════════════════════════════════\x1b[0m')
  console.log(`\x1b[35m  METEOR SESSION ${SESSION_ID}\x1b[0m  \x1b[90m${new Date().toISOString()}\x1b[0m`)
  if (meta.version) console.log(`\x1b[90m  protocol ${meta.version}\x1b[0m`)
  if (meta.listen) console.log(`\x1b[90m  listen ${meta.listen}\x1b[0m`)
  console.log('\x1b[90m  Logs below are from THIS session only (pm2 flush on deploy).\x1b[0m')
  console.log('\x1b[90m  Ore tracking: watch for [Ore] lines after join.\x1b[0m')
  console.log('\x1b[35m══════════════════════════════════════════════════════════════\x1b[0m')
  console.log('')
}

function flushPm2Logs () {
  try {
    const home = process.env.HOME || process.env.USERPROFILE
    if (!home) return
    const pm2Dir = path.join(home, '.pm2', 'logs')
    if (!fs.existsSync(pm2Dir)) return
    for (const f of fs.readdirSync(pm2Dir)) {
      if (!f.endsWith('.log')) continue
      if (f.includes('meteor-proxy') || f.includes('meteor-bot')) {
        try { fs.writeFileSync(path.join(pm2Dir, f), '') } catch (_) {}
      }
    }
  } catch (_) {}
}

function ore (msg) {
  line('Ore', '\x1b[36m', msg)
}

function rid (msg) {
  line('RID', '\x1b[95m', msg)
}

function info (msg) {
  line('Info', '\x1b[37m', msg)
}

function warn (key, msg) {
  const now = Date.now()
  const prev = warnLast.get(key) || 0
  if (now - prev < WARN_COOLDOWN_MS) return
  warnLast.set(key, now)
  line('Warn', '\x1b[33m', msg)
}

function error (key, msg) {
  const now = Date.now()
  const prev = warnLast.get(key) || 0
  if (now - prev < WARN_COOLDOWN_MS) return
  warnLast.set(key, now)
  line('Error', '\x1b[31m', msg)
}

function relayParseFail (direction, message) {
  warn(`relay-parse-${direction}`, `relay ${direction} parse fail (rate-limited): ${message}`)
}

module.exports = {
  SESSION_ID,
  beginSession,
  flushPm2Logs,
  ore,
  rid,
  info,
  warn,
  error,
  relayParseFail
}