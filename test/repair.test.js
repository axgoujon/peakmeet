import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillVoids, fillDepressions } from '../src/repair.js';

const field = (w, h, f) => {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { data, width: w, height: h };
};

test('a pit inside mountains is filled to the surrounding level', () => {
  const hf = field(120, 120, (x, y) => 1500 + 3 * x);
  for (let y = 50; y < 58; y++) for (let x = 60; x < 68; x++) hf.data[y * 120 + x] = -400 + (x + y);
  const r = fillVoids(hf);
  assert.equal(r.filledCells, 64);
  for (let y = 50; y < 58; y++) for (let x = 60; x < 68; x++) {
    const v = hf.data[y * 120 + x], expected = 1500 + 3 * x;
    assert.ok(Math.abs(v - expected) < 30, `cell ${x},${y}: ${v} vs ${expected}`);
  }
});

test('a fjord is real low ground and stays', () => {
  // 1200 m walls with a 40-cell-wide channel at sea level running the full length
  const hf = field(160, 160, (x) => (x >= 60 && x < 100 ? -40 : 1200));
  const before = Float32Array.from(hf.data);
  const r = fillVoids(hf);
  assert.equal(r.filledCells, 0);
  assert.deepEqual(hf.data, before);
});

test('a deep valley and a summit are left alone', () => {
  const hf = field(200, 200, (x, y) => 1000 + 2400 * Math.min(1, Math.abs(x - 100) / 60) + 600 * Math.exp(-((x - 30) ** 2 + (y - 30) ** 2) / 50));
  const before = Float32Array.from(hf.data);
  assert.equal(fillVoids(hf).filledCells, 0);
  assert.deepEqual(hf.data, before);
});

test('a deep closed bowl on a mountainside is filled smoothly, without a wall', () => {
  // a 4000-5000 m slope with a 40-cell void falling to -400 m
  const slope = (x) => 4000 + 10 * x;
  const hf = field(120, 120, (x, y) => {
    const r = Math.hypot(x - 60, y - 60);
    return r < 20 ? -400 + 30 * r : slope(x);
  });
  hf.metresPerPixel = 34;
  const r = fillDepressions(hf);
  assert.equal(r.bowls, 1);
  let step = 0;
  for (let y = 30; y < 90; y++) for (let x = 30; x < 90; x++) {
    const i = y * 120 + x;
    step = Math.max(step, Math.abs(hf.data[i] - hf.data[i + 1]), Math.abs(hf.data[i] - hf.data[i + 120]));
  }
  assert.ok(step < 40, `largest step ${step}`);
  assert.ok(Math.abs(hf.data[60 * 120 + 60] - slope(60)) < 150, `centre ${hf.data[60 * 120 + 60]}`);
});

test('craters and sea-level water with depth soundings stay', () => {
  // a 250 m deep summit crater, and a 600 m deep fjord behind a sill at sea level
  const crater = field(100, 100, (x, y) => { const r = Math.hypot(x - 50, y - 50); return r < 8 ? 3526 + 30 * r : 3776 - 20 * (r - 8); });
  crater.metresPerPixel = 34;
  assert.equal(fillDepressions(crater).bowls, 0);
  const fjord = field(100, 100, (x, y) => (x > 20 && x < 80 && y > 20 && y < 80 ? -600 : x <= 20 && y === 50 ? 0 : 900));
  fjord.metresPerPixel = 34;
  const before = Float32Array.from(fjord.data);
  assert.equal(fillDepressions(fjord).bowls, 0);
  assert.deepEqual(fjord.data, before);
});
