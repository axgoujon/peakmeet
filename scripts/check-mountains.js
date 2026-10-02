// Checked 2026-10: every flagged entry was compared with OpenStreetMap's
// summit node and the listed coordinate confirmed. The remaining flags are
// the terrain data itself: radar-derived DEMs smear vertical walls, so
// cliff-bound summits (Fitz Roy, Cerro Torre, Mont Aiguille) read hundreds
// of metres low, and Mont Aiguille's nearest match is the Vercors plateau.
//
// Verifies every listed summit against the terrain data: the highest ground
// near the listed point should be close to the official height, and nothing
// much higher should sit a little further away (which means the coordinate
// is off). Prints a table and, with --fix, the snapped coordinates.
import { MOUNTAINS } from '../src/mountains.js';
import { loadHeightfield, sampleBilinear, pixelOf } from '../src/terrain.js';
import { decodePng } from '../test/png.js';
import { metersPerPixel, tileXToLon, tileYToLat, TILE_SIZE } from '../src/tiles.js';

const ZOOM = 12;
const NEAR = 600;     // metres: the listed point should be on or next to the summit
const FAR = 3000;     // metres: search for a higher point the coordinate may have missed

function highest(hf, cx, cy, radiusPx) {
  let best = { h: -Infinity, x: cx, y: cy };
  for (let y = Math.floor(cy - radiusPx); y <= Math.ceil(cy + radiusPx); y++) {
    for (let x = Math.floor(cx - radiusPx); x <= Math.ceil(cx + radiusPx); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radiusPx ** 2) continue;
      const h = sampleBilinear(hf, x, y);
      if (h > best.h) best = { h, x, y };
    }
  }
  return best;
}

const rows = [];
for (const m of MOUNTAINS) {
  const mpp = metersPerPixel(m.lat, ZOOM);
  const hf = await loadHeightfield({ lat: m.lat, lon: m.lon, zoom: ZOOM, size: Math.ceil((2.4 * FAR) / mpp), decode: decodePng, concurrency: 12 });
  const p = pixelOf(hf, m.lat, m.lon);
  const near = highest(hf, p.x, p.y, NEAR / mpp);
  const far = highest(hf, p.x, p.y, FAR / mpp);
  const offset = Math.hypot(far.x - p.x, far.y - p.y) * mpp;
  const toLatLon = (b) => ({
    lat: tileYToLat((hf.originY * TILE_SIZE + b.y + 0.5) / TILE_SIZE, ZOOM),
    lon: tileXToLon((hf.originX * TILE_SIZE + b.x + 0.5) / TILE_SIZE, ZOOM),
  });
  // A higher neighbour alone is normal (Lhotse sits 3 km from Everest); it
  // only suggests a wrong coordinate if it is also closer to the official height.
  const heightGap = Math.round(near.h - m.elevation);
  const wrongPlace = far.h - near.h > 60 && offset > NEAR
    && Math.abs(far.h - m.elevation) < Math.abs(near.h - m.elevation) - 50;
  rows.push({ name: m.name, listed: m.elevation, demNear: Math.round(near.h), gap: heightGap,
              higherWithin3km: Math.round(far.h), offsetM: Math.round(offset),
              verdict: wrongPlace ? 'check coordinate' : heightGap < -250 ? 'terrain data low' : 'ok',
              summit: toLatLon(wrongPlace ? far : near) });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('mountain', 26), pad('listed', 7), pad('DEM', 6), pad('gap', 6), pad('max3km', 7), pad('off m', 6), 'verdict');
for (const r of rows) console.log(pad(r.name, 26), pad(r.listed, 7), pad(r.demNear, 6), pad(r.gap, 6), pad(r.higherWithin3km, 7), pad(r.offsetM, 6), r.verdict);
const bad = rows.filter((r) => r.verdict !== 'ok');
console.log(`\n${rows.length - bad.length}/${rows.length} ok, ${bad.length} flagged`);
if (process.argv.includes('--fix')) console.log(JSON.stringify(rows.map((r) => ({ name: r.name, ...r.summit, verdict: r.verdict }))));
