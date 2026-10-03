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
