'use strict'

function createLogger (tag = 'Paradox') {
  return {
    info (msg) { console.log(`\x1b[34m[${tag}]\x1b[0m ${msg}`) },
    success (msg) { console.log(`\x1b[32m[${tag}]\x1b[0m ${msg}`) },
    warn (msg) { console.warn(`\x1b[33m[${tag}]\x1b[0m ${msg}`) },
    error (msg) { console.error(`\x1b[31m[${tag}]\x1b[0m ${msg}`) },
    command (player, cmd) { console.log(`\x1b[90m[${tag}] ${player} → ${cmd}\x1b[0m`) }
  }
}

module.exports = { createLogger }