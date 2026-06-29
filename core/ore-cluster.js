'use strict'

/** Group ore blocks into veins/clusters (stashfinder-style targets). */

const DEFAULT_LINK_DIST = 8

function dist3 (a, b) {
  const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function summarizeCluster (blocks) {
  let sx = 0; let sy = 0; let sz = 0
  const counts = {}
  for (const b of blocks) {
    sx += b.x; sy += b.y; sz += b.z
    counts[b.name] = (counts[b.name] || 0) + 1
  }
  const n = blocks.length
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
  const cx = Math.round(sx / n)
  const cy = Math.round(sy / n)
  const cz = Math.round(sz / n)
  return {
    id: `${cx},${cy},${cz}`,
    x: cx,
    y: cy,
    z: cz,
    count: n,
    dominant,
    counts,
    blocks
  }
}

/**
 * Merge ore hits into clusters within maxDist blocks of each other.
 */
function clusterOres (ores, maxDist = DEFAULT_LINK_DIST) {
  if (!ores?.length) return []
  const used = new Set()
  const clusters = []

  for (let i = 0; i < ores.length; i++) {
    if (used.has(i)) continue
    const group = [ores[i]]
    used.add(i)
    let expanded = true
    while (expanded) {
      expanded = false
      for (let j = 0; j < ores.length; j++) {
        if (used.has(j)) continue
        for (const g of group) {
          if (dist3(ores[j], g) <= maxDist) {
            group.push(ores[j])
            used.add(j)
            expanded = true
            break
          }
        }
      }
    }
    if (group.length >= 1) clusters.push(summarizeCluster(group))
  }
  return clusters
}

function mergeClustersIntoMap (clusterMap, clusters, maxSize = 500) {
  for (const c of clusters) {
    const key = c.id
    const prev = clusterMap.get(key)
    if (!prev || c.count > prev.count) clusterMap.set(key, c)
    if (clusterMap.size > maxSize) clusterMap.delete(clusterMap.keys().next().value)
  }
}

module.exports = {
  DEFAULT_LINK_DIST,
  clusterOres,
  mergeClustersIntoMap,
  summarizeCluster
}