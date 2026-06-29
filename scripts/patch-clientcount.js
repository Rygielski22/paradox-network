'use strict'

const fs = require('fs')
const path = require('path')

const filePath = path.join(__dirname, '..', 'node_modules', 'bedrock-protocol', 'src', 'server.js')

console.log('[Patch] Checking bedrock-protocol server.js (client count)...')

if (!fs.existsSync(filePath)) {
  console.error('[Patch] ✗ server.js not found:', filePath)
  process.exit(0)
}

let src = fs.readFileSync(filePath, 'utf8')

if (src.includes('meteor-clientcount-guard')) {
  console.log('[Patch] ✓ server.js client-count guard already present.')
  process.exit(0)
}

const oldBlock = `this.clients[conn.address]?.close()
    delete this.clients[conn.address]
    this.clientCount--`

const newBlock = `/* meteor-clientcount-guard */
    if (this.clients[conn.address] !== undefined) {
      this.clients[conn.address]?.close()
      delete this.clients[conn.address]
      this.clientCount--
      if (this.clientCount < 0) this.clientCount = 0
    }`

if (!src.includes(oldBlock)) {
  console.error('[Patch] ✗ Could not find the clientCount block — bedrock-protocol layout changed. Skipping (no crash).')
  process.exit(0)
}

src = src.replace(oldBlock, newBlock)
fs.writeFileSync(filePath, src)
console.log('[Patch] ✓ Applied client-count guard — player count can no longer go negative.')
