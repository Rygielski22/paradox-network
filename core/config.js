'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  proxy: {
    version: '1.26.30',
    host: '0.0.0.0',
    port: 19132,
    motd: '§1§lParadox Network',
    levelName: '§1§lParadox §8| §fproxy',
    maxPlayers: 100
  },
  destination: {
    host: 'play.lbsg.net',
    port: 19132,
    offline: false
  },
  theme: {
    brand: 'Paradox Network',
    primary: '§1',
    secondary: '§1',
    prefix: '?'
  },
  security: {
    bannedIPs: []
  },
  features: {
    enableModules: true,
    enablePackInjection: true
  }
}

class Config {
  constructor(file = 'config.json') {
    this.file = file
    this.data = { ...DEFAULTS }
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.data = this._merge(DEFAULTS, raw)
      } else {
        this.save()
      }
    } catch (e) {
      console.warn('[Config] Failed to load, using defaults')
    }
  }

  _merge(base, override) {
    const out = { ...base }
    for (const k in override) {
      if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k])) {
        out[k] = this._merge(base[k] || {}, override[k])
      } else {
        out[k] = override[k]
      }
    }
    return out
  }

  get(key, fallback) {
    const parts = key.split('.')
    let cur = this.data
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
      else return fallback
    }
    return cur ?? fallback
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch (e) {}
  }
}

module.exports = { Config, DEFAULTS }
