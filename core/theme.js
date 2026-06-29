'use strict'

const { TAG } = require('./chat')

let cfg = null

const DEFAULTS = {
  brand: 'Paradox Network',
  primary: '§1',
  secondary: '§1',
  accent: '§8',
  highlight: '§8',
  enabledColor: '§8',
  disabledColor: '§8',
  bold: '§l',
  commands: { prefix: '?' },
  messages: { enabledSuffix: '§8ENABLED', disabledSuffix: '§8DISABLED' }
}

function init (config) {
  cfg = config
}

function t (key, fallback) {
  if (!cfg) return fallback
  const v = cfg.get('theme.' + key)
  return v === null || v === undefined ? fallback : v
}

const theme = {
  init,

  get brand () { return t('brand', DEFAULTS.brand) },
  get primary () { return t('primary', DEFAULTS.primary) },
  get secondary () { return t('secondary', DEFAULTS.secondary) },
  get accent () { return t('accent', DEFAULTS.accent) },
  get highlight () { return t('highlight', DEFAULTS.highlight) },
  get enabledColor () { return t('enabledColor', DEFAULTS.enabledColor) },
  get disabledColor () { return t('disabledColor', DEFAULTS.disabledColor) },
  get bold () { return t('bold', DEFAULTS.bold) },
  get prefix () { return t('commands.prefix', DEFAULTS.commands.prefix) },
  get tag () { return TAG },
  get label () { return TAG },

  heading (text) {
    return `${this.highlight}${this.bold}${text}`
  },

  toggle (moduleName, enabled, extra) {
    const state = enabled
      ? `${this.enabledColor}On`
      : `${this.disabledColor}Off`
    let line = `${this.highlight}${moduleName} ${this.accent}-> ${state}`
    if (extra) line += ` ${String(extra).trim()}`
    return line
  },

  line (moduleName, body) {
    if (!moduleName) return `${this.accent}${body}`
    return `${this.highlight}${moduleName} ${this.accent}${body}`
  },

  status (enabled) {
    return enabled
      ? `${this.enabledColor}on`
      : `${this.disabledColor}off`
  },

  error (text) {
    return `${this.disabledColor}${text}`
  },

  format (str, vars = {}) {
    if (typeof str !== 'string') return str
    return str
      .replace(/\{player\}/g, vars.player ?? 'Player')
      .replace(/\{prefix\}/g, this.prefix)
      .replace(/\{brand\}/g, this.brand)
      .replace(/\{count\}/g, vars.count ?? 0)
  }
}

module.exports = theme