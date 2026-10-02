import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillVoids } from '../src/repair.js';

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
