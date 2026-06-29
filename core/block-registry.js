'use strict'

/**
 * Dragonfly-style block state registry (df-mc/dragonfly server/world/block_states.nbt).
 * Used to validate block names from per-chunk NBT palettes — NOT for Lifeboat runtime IDs.
 * Session RIDs always come from item_registry via chunk-scan ingestItemRegistry().
 */

const fs = require('fs')
const path = require('path')
const tlog = require('./terminal-log')

const ORE_BASE_NAMES = new Set([
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'lapis_ore',
  'redstone_ore', 'lit_redstone_ore', 'copper_ore', 'deepslate_coal_ore',
  'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_diamond_ore',
  'deepslate_emerald_ore', 'deepslate_lapis_ore', 'deepslate_redstone_ore',
  'lit_deepslate_redstone_ore', 'deepslate_copper_ore', 'nether_gold_ore',
  'quartz_ore', 'ancient_debris'
])

let KNOWN_NAMES = null
let KNOWN_STATES = null
let ORE_STATE_NAMES = null

function loadRegistry () {
  if (KNOWN_NAMES) return
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dragonfly-block-states.json'), 'utf8'))
    KNOWN_NAMES = new Set(data.names || [])
    KNOWN_STATES = new Set(data.states || [])
    ORE_STATE_NAMES = new Set()
    for (const state of KNOWN_STATES) {
      const base = baseName(state)
      if (base && ORE_BASE_NAMES.has(base)) ORE_STATE_NAMES.add(state)
    }
    tlog.ore(`Dragonfly registry: ${KNOWN_NAMES.size} block names, ${ORE_STATE_NAMES.size} ore types`)
  } catch (e) {
    tlog.error('block-registry', `dragonfly-block-states.json missing: ${e.message}`)
    KNOWN_NAMES = new Set()
    KNOWN_STATES = new Set()
    ORE_STATE_NAMES = new Set()
  }
}

function baseName (fullName) {
  if (!fullName || typeof fullName !== 'string') return null
  const n = fullName.startsWith('minecraft:') ? fullName.slice(10) : fullName
  return n || null
}

function normalizeName (name) {
  if (!name || typeof name !== 'string') return null
  if (name.startsWith('minecraft:')) return name
  if (name.includes(':')) return name
  return `minecraft:${name}`
}

function isKnownBlockName (name) {
  loadRegistry()
  const n = normalizeName(name)
  if (!n) return false
  return KNOWN_NAMES.has(n) || KNOWN_STATES.has(n)
}

/** Vanilla ore states from Dragonfly registry — rejects Lifeboat generators. */
function isVanillaOreName (name) {
  const n = normalizeName(name)
  if (!n || !n.startsWith('minecraft:')) return false
  if (n.includes('generator')) return false
  loadRegistry()
  if (ORE_STATE_NAMES.size > 0) return ORE_STATE_NAMES.has(n)
  return ORE_BASE_NAMES.has(baseName(n))
}

function allOreStateNames () {
  loadRegistry()
  return ORE_STATE_NAMES
}

let ALL_BASE_NAMES = null

/** Unique base block ids (no minecraft: prefix) for command tab-complete. */
function allBlockBaseNames () {
  loadRegistry()
  if (ALL_BASE_NAMES) return ALL_BASE_NAMES
  const seen = new Set()
  const names = []
  const add = (full) => {
    const base = baseName(full)
    if (!base || seen.has(base)) return
    seen.add(base)
    names.push(base)
  }
  if (KNOWN_STATES) {
    for (const state of KNOWN_STATES) add(state)
  }
  if (KNOWN_NAMES) {
    for (const name of KNOWN_NAMES) add(name)
  }
  names.sort()
  ALL_BASE_NAMES = names
  return names
}

loadRegistry()

module.exports = {
  normalizeName,
  isKnownBlockName,
  isVanillaOreName,
  allOreStateNames,
  allBlockBaseNames,
  loadRegistry
}