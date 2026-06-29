/**
 * Resource Pack Builder  —  Paradox HUD
 * ─────────────────────────────────────────────────────────────────────────
 * Builds the Droopy-style HUD resource pack:
 *
 *   • WATERMARK  – static label anchored top-right (read from config).
 *   • ARRAYLIST  – label bound to #hud_actionbar_text_string. The proxy
 *                  feeds it the live module list (see modules/arraylist.js).
 *
 * Hard rules followed (so the client never refuses the pack):
 *   • Pack only ADDS elements. We never override any vanilla element.
 *   • Manifest matches the format_version 2 spec exactly.
 *   • ZIP is built dependency-free with forward-slash entry paths.
 *
 * Every build generates fresh UUIDs and a time-bumped version, so the
 * client treats it as a new pack and re-downloads.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { writeZip } = require('./zip-writer')

const ROOT = path.join(__dirname, '..')
const PACK_DIR = path.join(ROOT, 'resource_pack')
const UI_DIR = path.join(PACK_DIR, 'ui')
const OUTPUT_PATH = path.join(ROOT, 'paradox_pack.zip')
const CONFIG_PATH = path.join(ROOT, 'config.json')

console.log('Building Paradox HUD resource pack...')

// Only regenerate ESP glyphs when explicitly bundling them into the pack zip.
if (process.env.METEOR_PACK_ESP === '1' || process.env.METEOR_PACK_ESP === 'true') {
  const glyphScript = path.join(__dirname, 'gen-esp-glyph.js')
  if (fs.existsSync(glyphScript)) {
    try {
      require('child_process').execSync(`node "${glyphScript}"`, { cwd: ROOT, stdio: 'inherit' })
    } catch (e) {
      console.warn('[build] gen-esp-glyph.js failed:', e.message)
    }
  }
}

// ── Load config ───────────────────────────────────────────────────────────
let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (e) {
  console.warn('[build] config.json not readable, using defaults:', e.message)
}
const wm = (cfg.theme && cfg.theme.watermark) || {}
const brand = (cfg.theme && cfg.theme.brand) || 'Paradox Network'

// Single bold dark-blue title — top right (§1 = darkest blue).
const primary = (cfg.theme && cfg.theme.primary) || '§1'
const watermarkText = `${primary}§lPARADOX NETWORK`

// ── Ensure pack directories exist ────────────────────────────────────────
fs.mkdirSync(UI_DIR, { recursive: true })

// ── Pack UUIDs (stable per schema, rotate when pack shape changes) ────────
// Client caches packs by UUID. After StorageESP added font/glyphs under the
// old UUID, clients kept that blob and reject the new minimal zip as
// "incompatible". Bump PACK_SCHEMA to force fresh UUIDs + full re-download.
const PACK_SCHEMA = 'lifeboat-boost-v23-darkgray-hud'
const PACK_IDS_PATH = path.join(ROOT, '.pack-ids.json')
let headerUUID
let moduleUUID
let ids = {}
try { ids = JSON.parse(fs.readFileSync(PACK_IDS_PATH, 'utf8')) } catch (e) { /* first build */ }
if (ids.schema === PACK_SCHEMA && ids.headerUUID && ids.moduleUUID) {
  headerUUID = ids.headerUUID
  moduleUUID = ids.moduleUUID
} else {
  headerUUID = crypto.randomUUID()
  moduleUUID = crypto.randomUUID()
  fs.writeFileSync(PACK_IDS_PATH, JSON.stringify({
    schema: PACK_SCHEMA,
    headerUUID,
    moduleUUID
  }, null, 2))
  console.log(`  ✓ rotated pack UUIDs (${PACK_SCHEMA}) — clients must re-download`)
}
// Bump the patch on each build, but keep it small enough that the client
// always treats it as "newer" without weirdness. Stored to disk so we can
// monotonically increase across runs.
const versionStatePath = path.join(ROOT, '.pack-version')
let nextPatch = 1
try {
  if (fs.existsSync(versionStatePath)) {
    nextPatch = (parseInt(fs.readFileSync(versionStatePath, 'utf8'), 10) || 0) + 1
  }
} catch (e) { /* ignore */ }
fs.writeFileSync(versionStatePath, String(nextPatch))
const version = [3, 0, nextPatch]

const manifest = {
  format_version: 2,
  header: {
    name: `${brand} HUD`,
    description: `${brand} Proxy client HUD`,
    uuid: headerUUID,
    version,
    min_engine_version: [1, 19, 0]
  },
  modules: [
    {
      type: 'resources',
      uuid: moduleUUID,
      version
    }
  ]
}

fs.writeFileSync(
  path.join(PACK_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2)
)

// ── HUD UI (Silver-proxy layout: watermark y=25, arraylist y=37) ─────────
const hudScreen = {
  namespace: 'hud',

  meteor_watermark: {
    type: 'label',
    text: watermarkText,
    anchor_from: 'top_right',
    anchor_to: 'top_right',
    offset: [-2, 25],
    shadow: true,
    layer: 102
  },

  // Top-right module list — proxy pads lines to equal pixel width before send.
  meteor_arraylist: {
    type: 'label',
    text: '#hud_actionbar_text_string',
    anchor_from: 'top_right',
    anchor_to: 'top_right',
    offset: [0, 37],
    color: [0.45, 0.45, 0.45, 1.0],
    shadow: true,
    layer: 101
  },

  // Reposition + hide vanilla action bar (stops bottom/hotbar duplicate on 1.26.x).
  hud_actionbar_text: {
    type: 'label',
    anchor_from: 'top_right',
    anchor_to: 'top_right',
    offset: [0, 37],
    color: [1.0, 1.0, 1.0, 1.0],
    shadow: true,
    alpha: 0.0,
    layer: 100
  },

  hud_actionbar_text_area: {
    type: 'panel',
    anchor_from: 'top_right',
    anchor_to: 'top_right',
    size: ['100%', '100%'],
    layer: 99
  },

  // Kill vanilla tip fade above hotbar — keep #tip_text binding for our panel only.
  anim_item_name_text_alpha: {
    anim_type: 'alpha',
    easing: 'linear',
    duration: 0,
    from: 0,
    to: 0
  },

  hud_tip_text: {
    type: 'panel',
    size: [0, 0],
    offset: [9999, 9999],
    alpha: 0,
    ignored: true,
    controls: []
  },

  // Bottom-right status popup (ModStatus feeds #tip_text via text/tip packets).
  meteor_status_panel: {
    type: 'panel',
    anchor_from: 'bottom_right',
    anchor_to: 'bottom_right',
    offset: [0, 0],
    size: [158, 38],
    layer: 110,
    bindings: [
      { binding_name: '#tip_text', binding_type: 'global' },
      {
        binding_type: 'view',
        source_property_name: "(not ((#tip_text - 'Paradox ·') = #tip_text))",
        target_property_name: '#visible'
      }
    ],
    controls: [
      {
        meteor_status_border_top: {
          type: 'image',
          texture: 'textures/ui/White',
          color: [0.62, 0.22, 0.95, 1.0],
          size: ['100%', '2px'],
          anchor_from: 'top_middle',
          anchor_to: 'top_middle',
          layer: 2
        }
      },
      {
        meteor_status_border_bottom: {
          type: 'image',
          texture: 'textures/ui/White',
          color: [0.62, 0.22, 0.95, 1.0],
          size: ['100%', '2px'],
          anchor_from: 'bottom_middle',
          anchor_to: 'bottom_middle',
          layer: 2
        }
      },
      {
        meteor_status_border_left: {
          type: 'image',
          texture: 'textures/ui/White',
          color: [0.62, 0.22, 0.95, 1.0],
          size: ['2px', '100%'],
          anchor_from: 'left_middle',
          anchor_to: 'left_middle',
          layer: 2
        }
      },
      {
        meteor_status_border_right: {
          type: 'image',
          texture: 'textures/ui/White',
          color: [0.62, 0.22, 0.95, 1.0],
          size: ['2px', '100%'],
          anchor_from: 'right_middle',
          anchor_to: 'right_middle',
          layer: 2
        }
      },
      {
        meteor_status_text: {
          type: 'label',
          text: '#tip_text',
          anchor_from: 'left_middle',
          anchor_to: 'left_middle',
          offset: [7, 0],
          color: [0.45, 0.45, 0.45, 1.0],
          shadow: true,
          layer: 3,
          bindings: [
            { binding_name: '#tip_text', binding_type: 'global' }
          ]
        }
      }
    ]
  },

  root_panel: {
    modifications: [
      {
        array_name: 'controls',
        operation: 'insert_front',
        value: [
          { 'meteor_watermark@hud.meteor_watermark': {} },
          { 'meteor_arraylist@hud.meteor_arraylist': {} },
          { 'meteor_status_panel@hud.meteor_status_panel': {} }
        ]
      }
    ]
  }
}

fs.writeFileSync(
  path.join(UI_DIR, 'hud_screen.json'),
  JSON.stringify(hudScreen, null, 2)
)

// ── Zip up the pack ──────────────────────────────────────────────────────
const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
const hudBuf = Buffer.from(JSON.stringify(hudScreen, null, 2), 'utf8')

// HUD-only by default — glyph_F8 caused Lifeboat "incompatible pack" / stale cache.
// Set METEOR_PACK_ESP=1 to bundle ESP glyphs (StorageESP needs them).
const entries = [
  { name: 'manifest.json', data: manifestBuf },
  { name: 'ui/hud_screen.json', data: hudBuf }
]

const globalVarsPath = path.join(PACK_DIR, 'ui', '_global_variables.json')
if (fs.existsSync(globalVarsPath)) {
  entries.push({ name: 'ui/_global_variables.json', data: fs.readFileSync(globalVarsPath) })
  console.log('  ✓ bundled ui/_global_variables.json')
}

const bundleEsp = process.env.METEOR_PACK_ESP === '1' || process.env.METEOR_PACK_ESP === 'true'
const espGlyphPath = path.join(PACK_DIR, 'font', 'glyph_F8.png')
if (bundleEsp && fs.existsSync(espGlyphPath)) {
  entries.push({ name: 'font/glyph_F8.png', data: fs.readFileSync(espGlyphPath) })
  console.log('  ✓ bundled font/glyph_F8.png (METEOR_PACK_ESP=1)')
} else if (bundleEsp) {
  console.warn('  ! METEOR_PACK_ESP=1 but glyph_F8.png missing — run node scripts/gen-esp-glyph.js')
} else {
  console.log('  ✓ HUD-only pack (no font — set METEOR_PACK_ESP=1 for StorageESP glyphs)')
}

// Force every player through pack download after a rebuild.
const PACK_CACHE_PATH = path.join(ROOT, 'pack-players.json')
try {
  fs.writeFileSync(PACK_CACHE_PATH, JSON.stringify({ signature: null, players: [] }, null, 2))
  console.log('  ✓ cleared pack-players.json')
} catch (e) {
  console.warn('  ! could not clear pack-players.json:', e.message)
}

const size = writeZip(OUTPUT_PATH, entries)

console.log(`✓ Pack built: ${OUTPUT_PATH} (${size} bytes)`)
console.log(`  header uuid: ${headerUUID}`)
console.log(`  module uuid: ${moduleUUID}`)
console.log(`  version:     ${version.join('.')}`)
console.log('  → HUD + tip status popup. Reconnect twice if prompted.')
