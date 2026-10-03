import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrain, terrainZoomFor } from '../src/mesh.js';
import { boxWindow, imageryZoomFor } from '../src/imagery.js';
import { metersPerPixel, lonToTileX, latToTileY } from '../src/tiles.js';
import { MOUNTAINS, PAIRS, findMountain } from '../src/mountains.js';

// A synthetic heightfield whose elevation is a known function of distance
// from a chosen point, laid out exactly like a real terrain mosaic.
function syntheticField(lat, lon, z, size, f) {
  const originX = Math.floor(lonToTileX(lon, z)) - size / 512;
  const originY = Math.floor(latToTileY(lat, z)) - size / 512;
  const cx = lonToTileX(lon, z) * 256 - originX * 256, cy = latToTileY(lat, z) * 256 - originY * 256;
  const mpp = metersPerPixel(lat, z);
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const east = (x + 0.5 - cx) * mpp, north = -(y + 0.5 - cy) * mpp;
    data[y * size + x] = f(east, north);
  }
  return { data, width: size, height: size, z, originX, originY, metresPerPixel: mpp };
}

test('mesh is centred, square and in true metres at any latitude', () => {
  for (const lat of [0, 45.9, 63]) {
    const hf = syntheticField(lat, 7, 12, 1024, () => 1000);
    const m = buildTerrain(hf, { lat, lon: 7, boxMetres: 10000, segments: 64 });
    const xs = [], zs = [];
    for (let i = 0; i < m.positions.length; i += 3) { xs.push(m.positions[i]); zs.push(m.positions[i + 2]); }
    assert.equal(Math.min(...xs), -5000); assert.equal(Math.max(...xs), 5000);
    assert.equal(Math.min(...zs), -5000); assert.equal(Math.max(...zs), 5000);
    assert.ok(Math.abs(m.min - 1000) < 1e-3 && Math.abs(m.max - 1000) < 1e-3);
  }
});

test('a cone peak lands at the centre with the right height and shape', () => {
  const lat = 45.98, lon = 7.66;
  const cone = (e, n) => 4000 - Math.hypot(e, n) * 0.5;
  const hf = syntheticField(lat, lon, 12, 1024, cone);
  const m = buildTerrain(hf, { lat, lon, boxMetres: 8000, segments: 80 });
  assert.ok(Math.abs(m.summit.elevation - 4000) < 15, `summit ${m.summit.elevation}`);
  assert.ok(Math.hypot(m.summit.east, m.summit.north) < 150, 'summit at the centre');
  assert.ok(Math.abs(m.summit.lat - lat) < 0.002 && Math.abs(m.summit.lon - lon) < 0.002);
  // a vertex 2 km east should sit 1000 m lower
  const n = 81, i = 60, j = 40;           // i: 60/80 * 8000 - 4000 = +2000 m east; j: centre row
  const k = j * n + i;
  assert.ok(Math.abs(m.positions[k * 3] - 2000) < 1e-6);
  assert.ok(Math.abs(m.positions[k * 3 + 1] - 3000) < 15, `got ${m.positions[k * 3 + 1]}`);
});

test('mesh orientation: north is -z, east is +x, uv runs west-east and north-south', () => {
  const lat = 45, lon = 7;
  const tilted = (e, n) => 1000 + e * 0.1 + n * 0.2;        // rises to the north-east
  const hf = syntheticField(lat, lon, 12, 1024, tilted);
  const m = buildTerrain(hf, { lat, lon, boxMetres: 4000, segments: 4 });
  const at = (i, j) => { const k = j * 5 + i; return { x: m.positions[k * 3], h: m.positions[k * 3 + 1], z: m.positions[k * 3 + 2], u: m.uvs[k * 2], v: m.uvs[k * 2 + 1] }; };
  const nw = at(0, 0), se = at(4, 4);
  assert.ok(nw.z < 0 && nw.x < 0 && se.z > 0 && se.x > 0);
  assert.ok(Math.abs(nw.h - (1000 - 200 + 400)) < 5, `north-west ${nw.h}`);
  assert.ok(Math.abs(se.h - (1000 + 200 - 400)) < 5, `south-east ${se.h}`);
  assert.deepEqual([nw.u, nw.v, se.u, se.v], [0, 0, 1, 1]);
  assert.equal(m.indices.length, 4 * 4 * 6);
});

test('zoom choices resolve the box without over-fetching', () => {
  assert.equal(terrainZoomFor(45.9, 10000, 300), 12);
  assert.ok(terrainZoomFor(45.9, 40000, 300) < terrainZoomFor(45.9, 10000, 300));
  for (const box of [5000, 10000, 20000, 40000]) {
    const z = imageryZoomFor(45.9, box, 2048);
    assert.ok(box / metersPerPixel(45.9, z) <= 2048 * 1.2);
    assert.ok(z === 15 || box / metersPerPixel(45.9, z + 1) > 2048 * 1.2, 'finest zoom that fits');
  }
});

test('imagery window covers exactly the box', () => {
  const w = boxWindow(45.98, 7.66, 10000, 14);
  assert.ok(Math.abs(w.span - 10000 / metersPerPixel(45.98, 14)) < 1e-6);
  const left = Math.min(...w.tiles.map((t) => t.left)), top = Math.min(...w.tiles.map((t) => t.top));
  assert.ok(left <= 0 && left > -256 && top <= 0 && top > -256, 'first tile starts at or before the box edge');
  const right = Math.max(...w.tiles.map((t) => t.left + 256)), bottom = Math.max(...w.tiles.map((t) => t.top + 256));
  assert.ok(right >= w.span && bottom >= w.span, 'last tile reaches past the far edge');
});

test('mountain list is well formed', () => {
  const names = new Set();
  for (const m of MOUNTAINS) {
    assert.ok(m.lat >= -90 && m.lat <= 90 && m.lon >= -180 && m.lon <= 180, m.name);
    assert.ok(m.elevation > 0 && m.elevation < 8900, m.name);
    assert.ok(!names.has(m.name), `duplicate ${m.name}`);
    names.add(m.name);
  }
  for (const [a, b] of PAIRS) assert.ok(findMountain(a) && findMountain(b), `${a} / ${b}`);
});

test('a named summit is located even when it is not the highest point in the box', () => {
  const lat = 46.57, lon = 8.0;
  // two cones: the "named" one 2 km west (3970 m), a higher one 1.5 km east (4100 m)
  const f = (e, n) => Math.max(3970 - Math.hypot(e + 2000, n) * 0.6, 4100 - Math.hypot(e - 1500, n) * 0.6, 1000);
  const hf = syntheticField(lat, lon, 12, 1024, f);
  const metresPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const named = { lat, lon: lon - 2000 / metresPerDegLon };
  const m = buildTerrain(hf, { lat, lon, boxMetres: 10000, segments: 100, marker: named });
  assert.ok(Math.abs(m.summit.elevation - 4100) < 20, 'box summit is the higher neighbour');
  assert.ok(Math.abs(m.marker.east + 2000) < 60, `marker east ${m.marker.east}`);
  assert.ok(Math.abs(m.marker.north) < 60);
  assert.ok(Math.abs(m.marker.elevation - 3970) < 20, `marker height ${m.marker.elevation}`);
  const outside = buildTerrain(hf, { lat, lon, boxMetres: 2000, segments: 10, marker: named });
  assert.equal(outside.marker, null, 'a marker outside the box is dropped');
});

test('the label snaps to the data summit a little off the listed point', () => {
  const lat = 45.98, lon = 7.66;
  const peak = (e, n) => 4300 - Math.hypot(e - 150, n + 100) * 0.9;     // data summit 180 m from the listed point
  const hf = syntheticField(lat, lon, 12, 1024, peak);
  const m = buildTerrain(hf, { lat, lon, boxMetres: 8000, segments: 160, marker: { lat, lon } });
  assert.ok(Math.abs(m.marker.elevation - 4300) < 25, `snapped to ${m.marker.elevation}`);
  assert.ok(Math.hypot(m.marker.east - 150, m.marker.north + 100) < 60);
});

import { sampleTerrain, profileLine } from '../src/mesh.js';

test('terrain sampling interpolates the mesh and stops at the box edge', () => {
  const lat = 45, lon = 7;
  const hf = syntheticField(lat, lon, 12, 1024, (e, n) => 1000 + e * 0.1 + n * 0.2);
  const m = buildTerrain(hf, { lat, lon, boxMetres: 4000, segments: 40 });
  assert.ok(Math.abs(sampleTerrain(m, 0, 0) - 1000) < 3);
  assert.ok(Math.abs(sampleTerrain(m, 1234, -567) - (1000 + 123.4 - 113.4)) < 3);
  assert.ok(Number.isNaN(sampleTerrain(m, 2100, 0)));
});

test('a profile runs through the summit, along the bearing, at true distances', () => {
  const lat = 45.98, lon = 7.66;
  const cone = (e, n) => 4000 - Math.hypot(e - 500, n) * 0.5;      // summit 500 m east of centre
  const hf = syntheticField(lat, lon, 12, 1024, cone);
  const m = buildTerrain(hf, { lat, lon, boxMetres: 8000, segments: 160, marker: { lat, lon } });
  const p = profileLine(m, { bearing: 90, samples: 80 });
  const mid = 40;
  assert.ok(Math.abs(p.distances[mid]) < 1e-6);
  assert.ok(Math.abs(p.heights[mid] - 4000) < 30, `summit ${p.heights[mid]}`);
  // 2 km either side along W-E: 1000 m lower, symmetric
  const at = (d) => p.heights[mid + Math.round((d / 4000) * 40)];
  assert.ok(Math.abs(at(2000) - 3000) < 30 && Math.abs(at(-2000) - 3000) < 30, `${at(-2000)} / ${at(2000)}`);
  // the line extends past the box on the east side, so its end is NaN
  assert.ok(Number.isNaN(p.heights[80]) && !Number.isNaN(p.heights[0]));
  // bearing 90 means the positive side is east
  assert.ok(p.points[80].east > p.points[0].east && Math.abs(p.points[80].north - p.points[0].north) < 1e-6);
});
