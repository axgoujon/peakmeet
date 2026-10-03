import { TILE_SIZE, lonToTileX, latToTileY, tileXToLon, tileYToLat, metersPerPixel } from './tiles.js';
import { sampleBilinear } from './terrain.js';

/**
 * Terrain mesh for a square box centred on lat/lon, in true metres.
 *
 * Web Mercator inflates sizes by 1/cos(latitude), so two places drawn at the
 * same map zoom are not at the same scale. Positions here are metres from
 * the centre (x east, y up, z south), so mountains at any latitude compare
 * directly. Within a box of a few tens of km the local scale barely varies.
 *
 * UVs run 0..1 west to east and north to south, matching an image of the box
 * drawn with north up (texture flipY off).
 */
export function buildTerrain(hf, { lat, lon, boxMetres, segments = 256, marker = null, snapRadius = 600 }) {
  const z = hf.z;
  const mpp = metersPerPixel(lat, z);
  const cx = lonToTileX(lon, z) * TILE_SIZE - hf.originX * TILE_SIZE;
  const cy = latToTileY(lat, z) * TILE_SIZE - hf.originY * TILE_SIZE;
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const half = boxMetres / 2;

  let min = Infinity, max = -Infinity, summitIndex = 0;
  for (let j = 0; j < n; j++) {
    const north = half - (boxMetres * j) / segments;
    for (let i = 0; i < n; i++) {
      const east = -half + (boxMetres * i) / segments;
      // Mosaic coordinates put texel centres at i + 0.5; sampleBilinear
      // indexes texel centres directly.
      const h = sampleBilinear(hf, cx + east / mpp - 0.5, cy - north / mpp - 0.5);
      const k = j * n + i;
      positions[k * 3] = east;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = -north;
      uvs[k * 2] = i / segments;
      uvs[k * 2 + 1] = j / segments;
      if (h < min) min = h;
      if (h > max) { max = h; summitIndex = k; }
    }
  }

  const indices = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.set([a, c, b, b, c, d], t);
      t += 6;
    }
  }

  // A named mountain may not be the highest point in its box (the Eiger's
  // box also holds the Mönch), so its own summit is located separately.
  let markerPoint = null;
  if (marker) {
    const east = (lonToTileX(marker.lon, z) - lonToTileX(lon, z)) * TILE_SIZE * mpp;
    const north = -(latToTileY(marker.lat, z) - latToTileY(lat, z)) * TILE_SIZE * mpp;
    if (Math.abs(east) <= half && Math.abs(north) <= half) {
      // Snap to the highest ground within reach: on a steep peak, a point a
      // few pixels off the data's summit reads tens of metres low.
      markerPoint = { east, north, elevation: -Infinity };
      for (let k = 0; k < n * n; k++) {
        const dx = positions[k * 3] - east, dn = -positions[k * 3 + 2] - north;
        if (dx * dx + dn * dn > snapRadius * snapRadius) continue;
        if (positions[k * 3 + 1] > markerPoint.elevation) {
          markerPoint = { east: positions[k * 3], north: -positions[k * 3 + 2], elevation: positions[k * 3 + 1] };
        }
      }
      if (markerPoint.elevation === -Infinity) {
        markerPoint = { east, north, elevation: sampleBilinear(hf, cx + east / mpp - 0.5, cy - north / mpp - 0.5) };
      }
    }
  }

  const sx = positions[summitIndex * 3], sNorth = -positions[summitIndex * 3 + 2];
  const summitPx = lonToTileX(lon, z) * TILE_SIZE + sx / mpp;
  const summitPy = latToTileY(lat, z) * TILE_SIZE - sNorth / mpp;
  return {
    positions, uvs, indices, segments, boxMetres,
    min, max,
    marker: markerPoint,
    summit: {
      east: sx, north: sNorth, elevation: max,
      lat: tileYToLat(summitPy / TILE_SIZE, z), lon: tileXToLon(summitPx / TILE_SIZE, z),
    },
  };
}

/** Terrain zoom whose pixels resolve the box with about `samples` per side. */
export function terrainZoomFor(lat, boxMetres, samples = 512, maxZoom = 13) {
  for (let z = maxZoom; z >= 0; z--) {
    if (boxMetres / metersPerPixel(lat, z) <= samples * 1.5) return z;
  }
  return 0;
}

/** Height at a point of the box (metres from its centre), from the mesh grid. */
export function sampleTerrain(terrain, east, north) {
  const { positions, segments, boxMetres } = terrain;
  const half = boxMetres / 2;
  const fi = ((east + half) / boxMetres) * segments;
  const fj = ((half - north) / boxMetres) * segments;
  if (fi < 0 || fj < 0 || fi > segments || fj > segments) return NaN;
  const i = Math.min(segments - 1, Math.floor(fi)), j = Math.min(segments - 1, Math.floor(fj));
  const u = fi - i, v = fj - j, n = segments + 1;
  const h = (ii, jj) => positions[(jj * n + ii) * 3 + 1];
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}

/**
 * Elevation profile through the summit (the named mountain's when known),
 * along a compass bearing: distance runs from -length/2 (the side opposite
 * the bearing) to +length/2. Points outside the box are NaN.
 */
export function profileLine(terrain, { bearing, length = terrain.boxMetres, samples = 240 }) {
  const centre = terrain.marker ?? terrain.summit;
  const rad = (bearing * Math.PI) / 180;
  const dirEast = Math.sin(rad), dirNorth = Math.cos(rad);
  const distances = new Float32Array(samples + 1);
  const heights = new Float32Array(samples + 1);
  const points = [];
  for (let s = 0; s <= samples; s++) {
    const d = -length / 2 + (length * s) / samples;
    const east = centre.east + dirEast * d, north = centre.north + dirNorth * d;
    distances[s] = d;
    heights[s] = sampleTerrain(terrain, east, north);
    points.push({ east, north });
  }
  return { distances, heights, points, centre, bearing };
}

/**
 * Range of elevation at each distance from the summit, over every direction:
 * the band any profile through the summit stays within, whatever its angle.
 * Two mountains facing different ways compare fairly this way, and the band
 * also bounds the chart so its axes stay put while the view turns.
 */
export function radialRange(terrain, { length = terrain.boxMetres, samples = 120, directions = 72 } = {}) {
  const centre = terrain.marker ?? terrain.summit;
  const radii = new Float32Array(samples + 1);
  const min = new Float32Array(samples + 1).fill(Infinity);
  const max = new Float32Array(samples + 1).fill(-Infinity);
  for (let a = 0; a < directions; a++) {
    const rad = (a * 2 * Math.PI) / directions;
    const dirEast = Math.sin(rad), dirNorth = Math.cos(rad);
    for (let s = 0; s <= samples; s++) {
      const r = ((length / 2) * s) / samples;
      radii[s] = r;
      const h = sampleTerrain(terrain, centre.east + dirEast * r, centre.north + dirNorth * r);
      if (!Number.isFinite(h)) continue;
      if (h < min[s]) min[s] = h;
      if (h > max[s]) max[s] = h;
    }
  }
  for (let s = 0; s <= samples; s++) if (min[s] === Infinity) { min[s] = NaN; max[s] = NaN; }
  return { radii, min, max };
}

/** Metres east/north of (lat0, lon0) to (lat, lon), in the box's local frame. */
export function toLocal(lat0, lon0, lat, lon) {
  const z = 20, mpp = metersPerPixel(lat0, z);
  return {
    east: (lonToTileX(lon, z) - lonToTileX(lon0, z)) * TILE_SIZE * mpp,
    north: -(latToTileY(lat, z) - latToTileY(lat0, z)) * TILE_SIZE * mpp,
  };
}

/**
 * Raises under-read summits to their official heights, in place.
 *
 * Radar-derived terrain smooths steep towers away (Fitz Roy reads 539 m
 * low). Each peak's top is lifted by the missing height, fading out over
 * `radius`, and weighted by how high each point sits between the local base
 * and the summit: the upper walls the radar missed steepen, valleys and
 * glaciers stay where they are. This restores the height, not the true
 * shape of the tip, so callers should say so. The original heights are kept
 * on the terrain so the correction can be switched off.
 */
export function correctSummits(terrain, peaks, { radius = 1200, snap = 600, minGap = 30, maxGap = 700 } = {}) {
  const { positions, segments } = terrain;
  const n = segments + 1, count = n * n;
  if (!terrain.originalHeights) {
    terrain.originalHeights = new Float32Array(count);
    for (let k = 0; k < count; k++) terrain.originalHeights[k] = positions[k * 3 + 1];
  }
  const corrections = [];
  for (const peak of peaks) {
    // The data's own version of this summit: its highest point nearby.
    let top = -1, topH = -Infinity;
    for (let k = 0; k < count; k++) {
      const de = positions[k * 3] - peak.east, dn = -positions[k * 3 + 2] - peak.north;
      if (de * de + dn * dn <= snap * snap && positions[k * 3 + 1] > topH) { topH = positions[k * 3 + 1]; top = k; }
    }
    if (top < 0) continue;
    const gap = peak.elevation - topH;
    // The worst real under-read in the list is Fitz Roy's 539 m. A bigger gap
    // means no summit is there in the data, and lifting would invent one.
    if (gap < minGap || gap > maxGap) continue;
    const ce = positions[top * 3], cn = -positions[top * 3 + 2];

    let base = Infinity;
    for (let k = 0; k < count; k++) {
      const de = positions[k * 3] - ce, dn = -positions[k * 3 + 2] - cn;
      if (de * de + dn * dn <= radius * radius) base = Math.min(base, positions[k * 3 + 1]);
    }
    const span = Math.max(1, topH - base);
    for (let k = 0; k < count; k++) {
      const r = Math.hypot(positions[k * 3] - ce, -positions[k * 3 + 2] - cn);
      if (r >= radius) continue;
      const fade = 0.5 * (1 + Math.cos((Math.PI * r) / radius));
      const height = Math.min(1, Math.max(0, (positions[k * 3 + 1] - base) / span));
      positions[k * 3 + 1] += gap * fade * height;
    }
    corrections.push({ name: peak.name, from: topH, to: peak.elevation, east: ce, north: cn });
  }
  refreshExtent(terrain);
  terrain.corrections = corrections;
  return corrections;
}

/** Puts the original terrain heights back. */
export function restoreSummits(terrain) {
  if (!terrain.originalHeights) return;
  const { positions, originalHeights } = terrain;
  for (let k = 0; k < originalHeights.length; k++) positions[k * 3 + 1] = originalHeights[k];
  refreshExtent(terrain);
  terrain.corrections = [];
}

// Min, max, box summit and the named summit's height after heights change.
function refreshExtent(terrain) {
  const { positions } = terrain;
  let min = Infinity, max = -Infinity, at = 0;
  for (let k = 0; k < positions.length / 3; k++) {
    const h = positions[k * 3 + 1];
    if (h < min) min = h;
    if (h > max) { max = h; at = k; }
  }
  terrain.min = min;
  terrain.max = max;
  terrain.summit = { ...terrain.summit, east: positions[at * 3], north: -positions[at * 3 + 2], elevation: max };
  if (terrain.marker) {
    terrain.marker = { ...terrain.marker, elevation: sampleTerrain(terrain, terrain.marker.east, terrain.marker.north) };
  }
}
