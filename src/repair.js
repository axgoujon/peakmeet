/**
 * Fills data voids in a heightfield, in place.
 *
 * Gaps in the radar source were patched with coarser data, and in steep
 * mountains a few of those patches came out as deep pits: Machapuchare's
 * box holds 64 cells falling to -423 m inside 1500 m terrain, a 750 m drop
 * between neighbouring 27 m pixels. Drawn in 3D, that is a hole.
 *
 * A cell is a candidate when it lies far below the typical height of the
 * ~650 m around it; candidates form a void only as a small connected patch,
 * which keeps real low ground (fjords, lakes, sea) intact because those are
 * large. Voids are filled inward from their edges.
 */
export function fillVoids(hf, { drop = 500, block = 8, maxArea = 600 } = {}) {
  const { data, width: w, height: h } = hf;
  const bw = Math.ceil(w / block), bh = Math.ceil(h / block);

  // Median of each block, then of the 3x3 blocks around: a robust local level.
  const blockMedian = new Float32Array(bw * bh);
  const buf = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    buf.length = 0;
    for (let y = by * block; y < Math.min(h, (by + 1) * block); y++)
      for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) buf.push(data[y * w + x]);
    buf.sort((a, b) => a - b);
    blockMedian[by * bw + bx] = buf[buf.length >> 1];
  }
  const context = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    buf.length = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = bx + dx, y = by + dy;
      if (x >= 0 && y >= 0 && x < bw && y < bh) buf.push(blockMedian[y * bw + x]);
    }
    buf.sort((a, b) => a - b);
    context[by * bw + bx] = buf[buf.length >> 1];
  }

  const candidate = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (data[i] < context[Math.floor(y / block) * bw + Math.floor(x / block)] - drop) candidate[i] = 1;
  }

  // Keep only small connected patches as voids.
  const isVoid = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const stack = [], patch = [];
  let filledCells = 0, patches = 0;
  for (let start = 0; start < w * h; start++) {
    if (!candidate[start] || seen[start]) continue;
    patch.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      patch.push(i);
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && candidate[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (patch.length <= maxArea) {
      for (const i of patch) isVoid[i] = 1;
      filledCells += patch.length;
      patches++;
    }
  }

  // Fill from the edges inward: each pass sets void cells touching valid
  // ground to the mean of their valid neighbours.
  let frontier = [];
  for (let i = 0; i < w * h; i++) if (isVoid[i]) frontier.push(i);
  while (frontier.length) {
    const next = [], updates = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      let sum = 0, n = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !isVoid[j]) { sum += data[j]; n++; }
      }
      if (n) updates.push([i, sum / n]); else next.push(i);
    }
    if (!updates.length) break;
    for (const [i, v] of updates) { data[i] = v; isVoid[i] = 0; }
    frontier = next;
  }
  return { filledCells, patches };
}
