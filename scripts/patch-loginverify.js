'use strict'

const fs = require('fs')
const path = require('path')

const filePath = path.join(__dirname, '..', 'node_modules', 'bedrock-protocol', 'src', 'handshake', 'loginVerify.js')
const patchPath = path.join(__dirname, '..', 'patches', 'loginVerify.js')

console.log('[Patch] Checking bedrock-protocol loginVerify.js...')

if (!fs.existsSync(filePath)) {
  console.log('[Patch] bedrock-protocol not installed yet, skipping patch')
  console.log('[Patch] Run this script again after: npm install')
  process.exit(0)
}

if (fs.existsSync(patchPath)) {
  try {
    fs.copyFileSync(patchPath, filePath)
    console.log('[Patch] ✓ Applied loginVerify.js patch successfully')
    console.log('[Patch] ✓ Microsoft authentication / offline logins will now work properly (no server auth errors)')
  } catch (err) {
    console.error('[Patch] ✗ Failed to apply patch:', err.message)
    process.exit(1)
  }
} else {
  console.error('[Patch] ✗ Patch file not found at patches/loginVerify.js')
  console.error('[Patch] Please ensure the patches folder exists with loginVerify.js')
  process.exit(1)
}
