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
 *
 * Sizes were tuned on 34 m pixels: 8-pixel blocks, 600-cell patches. The
 * voids have a fixed ground size, so at a finer zoom the same hole spans
 * four times the cells and needs a wider window to stand out (Machapuchare's
 * 5 km box kept pits to -285 m). Finer pixels scale both up to the same
 * ground size; coarser ones keep the pixel values, which fill the downsampled
 * voids there.
 */
export function fillVoids(hf, { drop = 500, block: minBlock = 8, maxArea: minArea = 600, tunedMetres = 34 } = {}) {
  const { data, width: w, height: h } = hf;
  const scale = hf.metresPerPixel ? Math.max(1, tunedMetres / hf.metresPerPixel) : 1;
  const block = Math.round(minBlock * scale);
  const maxArea = Math.round(minArea * scale * scale);
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

/**
 * Fills closed depressions deeper than `depth`, in place.
 *
 * In mountains water always finds a way out: a closed bowl hundreds of
 * metres deep is a void in the source, not terrain. Machapuchare's 10 km box
 * holds one 1.5 km wide falling to -423 m inside 4000-5000 m slopes, too big
 * for the local test in fillVoids to see. Real craters stay: Fuji's is about
 * 250 m deep. The data also holds depth soundings for seas, fjords and
 * lakes, so bowls whose water would spill below `lowland` stay as they are.
 * Each bowl is found by priority-flood (water levels rising from the edges)
 * and filled smoothly from its rim, which leaves no pit.
 */
export function fillDepressions(hf, { depth = 500, lowland = 500 } = {}) {
  const { data, width: w, height: h } = hf;
  const n = w * h;
  const level = new Float32Array(n), done = new Uint8Array(n);
  // Binary min-heap on (level, cell); every cell enters once.
  const keys = new Float32Array(n), cells = new Int32Array(n);
  let size = 0;
  const push = (v, i) => {
    let k = size++;
    while (k) {
      const p = (k - 1) >> 1;
      if (keys[p] <= v) break;
      keys[k] = keys[p]; cells[k] = cells[p]; k = p;
    }
    keys[k] = v; cells[k] = i;
  };
  const pop = () => {
    const top = cells[0], v = keys[--size], c = cells[size];
    let k = 0;
    for (;;) {
      let m = 2 * k + 1;
      if (m >= size) break;
      if (m + 1 < size && keys[m + 1] < keys[m]) m++;
      if (keys[m] >= v) break;
      keys[k] = keys[m]; cells[k] = cells[m]; k = m;
    }
    keys[k] = v; cells[k] = c;
    return top;
  };
  const seed = (i) => { if (!done[i]) { done[i] = 1; level[i] = data[i]; push(data[i], i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  const around = (i, f) => {
    const x = i % w;
    if (x > 0) f(i - 1);
    if (x < w - 1) f(i + 1);
    if (i >= w) f(i - w);
    if (i < n - w) f(i + w);
  };
  while (size) {
    const i = pop(), v = level[i];
    around(i, (j) => {
      if (done[j]) return;
      done[j] = 1;
      level[j] = Math.max(v, data[j]);
      push(level[j], j);
    });
  }

  // Connected flooded cells form a bowl; keep the deep ones.
  const inBowl = new Uint8Array(n), seen = new Uint8Array(n);
  const stack = [], bowl = [];
  let filledCells = 0, bowls = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s] || level[s] - data[s] < 0.5) continue;
    bowl.length = 0;
    let deepest = 0, surface = -Infinity;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      bowl.push(i);
      deepest = Math.max(deepest, level[i] - data[i]);
      surface = Math.max(surface, level[i]);
      around(i, (j) => { if (!seen[j] && level[j] - data[j] >= 0.5) { seen[j] = 1; stack.push(j); } });
    }
    if (deepest < depth || surface < lowland) continue;
    for (const i of bowl) { inBowl[i] = 1; data[i] = level[i]; }
    filledCells += bowl.length;
    bowls++;
  }
  if (!bowls) return { filledCells, bowls };

  // The void's walls continue a little above the water line (Machapuchare's
  // keep a 1 km step between neighbouring cells), so a ~100 m band around
  // each bowl is smoothed with it.
  const band = Math.max(2, Math.round(100 / (hf.metresPerPixel || 34)));
  for (let pass = 0; pass < band; pass++) {
    const edge = [];
    for (let i = 0; i < n; i++) if (inBowl[i]) around(i, (j) => { if (!inBowl[j]) edge.push(j); });
    for (const j of edge) inBowl[j] = 1;
  }
  // Smooth the flat water surfaces into the rim around them: relaxation
  // towards the mean of the neighbours (a harmonic surface has no pits).
  const cellsIn = [];
  for (let i = 0; i < n; i++) if (inBowl[i] && i % w > 0 && i % w < w - 1 && i >= w && i < n - w) cellsIn.push(i);
  for (let iter = 0; iter < 400; iter++) {
    let change = 0;
    for (const i of cellsIn) {
      let sum = 0, k = 0;
      around(i, (j) => { sum += data[j]; k++; });
      const next = data[i] + 1.9 * (sum / k - data[i]);
      change = Math.max(change, Math.abs(next - data[i]));
      data[i] = next;
    }
    if (change < 0.5) break;
  }
  return { filledCells, bowls };
}
