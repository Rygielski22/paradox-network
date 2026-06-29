'use strict'

const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

function ensurePatches () {
  const kxScript    = path.join(__dirname, '..', 'scripts', 'patch-keyexchange.js')
  const loginScript = path.join(__dirname, '..', 'scripts', 'patch-loginverify.js')
  const ccScript    = path.join(__dirname, '..', 'scripts', 'patch-clientcount.js')
  const kxTarget    = path.join(__dirname, '..', 'node_modules', 'bedrock-protocol', 'src', 'handshake', 'keyExchange.js')

  console.log('[Patches] Applying auth/login patches from silver-proxy (to fix server authentication errors)')

  try { execFileSync(process.execPath, [loginScript], { stdio: 'inherit' }) }
  catch (e) { console.error('[Patches] loginVerify failed:', e.message) }

  try { execFileSync(process.execPath, [ccScript], { stdio: 'inherit' }) }
  catch (e) { console.error('[Patches] clientcount failed:', e.message) }

  try {
    if (fs.existsSync(kxTarget)) {
      const src = fs.readFileSync(kxTarget, 'utf8')
      if (src.includes('meteor-null-key-guard')) {
        console.log('[Patches] keyExchange guard already present.')
      } else {
        execFileSync(process.execPath, [kxScript], { stdio: 'inherit' })
      }
    } else {
      execFileSync(process.execPath, [kxScript], { stdio: 'inherit' })
    }
  } catch (e) {
    console.error('[Patches] keyExchange failed:', e.message)
  }

  const relayScript = path.join(__dirname, '..', 'scripts', 'patch-relay.js')
  const relayTarget = path.join(__dirname, '..', 'node_modules', 'bedrock-protocol', 'src', 'relay.js')
  try {
    if (fs.existsSync(relayTarget)) {
      const relaySrc = fs.readFileSync(relayTarget, 'utf8')
      if (relaySrc.includes('meteor-relay-parse-guard')) {
        console.log('[Patches] relay encode guard already present.')
      } else {
        execFileSync(process.execPath, [relayScript], { stdio: 'inherit' })
      }
    } else {
      execFileSync(process.execPath, [relayScript], { stdio: 'inherit' })
    }
  } catch (e) {
    console.error('[Patches] relay failed:', e.message)
  }
}

ensurePatches()

module.exports = { ensurePatches }
