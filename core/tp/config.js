'use strict'

/**
 * Tunable teleport constants — single source of truth.
 */
module.exports = {
  /** Max upstream step per auth packet (blocks/server tick budget). */
  BURST_STEP: 3.5,
  BURST_MAX_STEPS: 256,
  ARRIVE_EPS: 0.1,

  /** Brief server+client alignment after snap. */
  SYNC_MS: 2000,
  SYNC_REFRESH_MS: 350,

  /** Rubber-band protection after sync ends. */
  GUARD_MS: 12000,
  SETBACK_EPS: 1.5,

  /** Real server teleports (dimension/admin) pass through above this delta. */
  BIG_TP_BLOCKS: 200,

  /** Hard fail if TP never leaves active state. */
  TIMEOUT_MS: 15000,

  REINFORCE_COOLDOWN_MS: 400,

  /** Relay anchor field on player object during sync only. */
  RELAY_ANCHOR_KEY: '_meteorTp'
}