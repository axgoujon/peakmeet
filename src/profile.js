const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const niceStep = (span, target = 6) => {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
};
const km = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`);

/**
 * Both profiles in one chart, aligned on their summits (x = 0). By default
 * in true proportions, a metre up as long as a metre across, so slopes look
 * as steep as they are: the plot narrows when the profile is short, and
 * shows the part around the summit when it is too long to fit. `trueScale`
 * off fits the whole profile to the width and says how much heights are
 * stretched, so steepness is never silently changed.
 */
export class ProfileChart {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.readout = readout;
    this.series = [];
    this.hover = null;
    this.trueScale = true;
    const move = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      this.hover = x;
      this.draw();
    };
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('touchmove', move, { passive: true });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setData(series, { length, bearing }) {
    this.series = series;
    this.length = length;
    this.bearing = bearing;
    this.draw();
  }

  draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const live = this.series.filter((s) => s.visible);
    if (!live.length) { this.readout.textContent = ''; return; }

    // The all-directions band bounds every possible cut, so taking the range
    // from it keeps the axes still while the view (and the cut) turns.
    let lo = Infinity, hi = -Infinity;
    for (const s of live) {
      const values = s.band ? [...s.band.min, ...s.band.max] : s.heights;
      for (const h of values) if (Number.isFinite(h)) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    }
    const pad = Math.max(50, (hi - lo) * 0.08);
    lo -= pad; hi += pad;

    const left = 44, right = 10, top = 8, bottom = 18;
    const pw = W - left - right, ph = H - top - bottom;
    // Shown span of distance, and the plot width it takes.
    const mppY = (hi - lo) / ph;
    let span = this.length, width = pw;
    if (this.trueScale) {
      span = Math.min(this.length, pw * mppY);
      width = span / mppY;
    }
    const half = span / 2, x0 = left + (pw - width) / 2;
    const x = (d) => x0 + ((d + half) / span) * width;
    const y = (h) => top + (1 - (h - lo) / (hi - lo)) * ph;
    // metres per pixel along each axis: their ratio is the vertical stretch
    this.stretch = (span / width) / mppY;
    this.cropped = span < this.length - 1;

    g.font = '10px system-ui, sans-serif';
    g.strokeStyle = '#eceef1'; g.fillStyle = '#9aa0a8'; g.lineWidth = 1;
    const ys = niceStep(hi - lo, 4);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
      g.beginPath(); g.moveTo(x0, y(v)); g.lineTo(x0 + width, y(v)); g.stroke();
      g.fillText(`${Math.round(v)}`, x0 - 5, y(v));
    }
    const xs = niceStep(span, Math.max(2, Math.min(6, Math.floor(width / 70))));
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    for (let d = Math.ceil(-half / xs) * xs; d <= half; d += xs) {
      g.beginPath(); g.moveTo(x(d), top); g.lineTo(x(d), top + ph); g.stroke();
      if (Math.abs(x(d) - x(-half)) > 28 && Math.abs(x(d) - x(half)) > 28) g.fillText(d === 0 ? 'summit' : km(Math.abs(d)), x(d), H - 4);
    }
    g.fillStyle = '#16181d'; g.font = '600 10px system-ui, sans-serif';
    g.textAlign = 'left'; g.fillText(compass(this.bearing + 180), x0 + 2, H - 4);
    g.textAlign = 'right'; g.fillText(compass(this.bearing), x0 + width - 2, H - 4);

    // Lines and bands stay inside the shown span.
    g.save();
    g.beginPath(); g.rect(x0, 0, width, H); g.clip();

    // Bands first, so both mountains' current cuts sit on top of them.
    for (const s of live) {
      if (!s.band) continue;
      const { radii, min, max } = s.band, n = radii.length;
      const edge = [];
      for (let i = n - 1; i >= 0; i--) if (Number.isFinite(max[i])) edge.push([-radii[i], max[i]]);
      for (let i = 0; i < n; i++) if (Number.isFinite(max[i])) edge.push([radii[i], max[i]]);
      for (let i = n - 1; i >= 0; i--) if (Number.isFinite(min[i])) edge.push([radii[i], min[i]]);
      for (let i = 0; i < n; i++) if (Number.isFinite(min[i])) edge.push([-radii[i], min[i]]);
      g.beginPath();
      edge.forEach(([d, h], i) => (i ? g.lineTo(x(d), y(h)) : g.moveTo(x(d), y(h))));
      g.closePath();
      g.fillStyle = s.fill;
      g.fill();
    }
    for (const s of live) {
      g.beginPath();
      let open = false;
      s.distances.forEach((d, i) => {
        const h = s.heights[i];
        if (!Number.isFinite(h)) { open = false; return; }
        if (open) g.lineTo(x(d), y(h)); else { g.moveTo(x(d), y(h)); open = true; }
      });
      g.strokeStyle = s.colour; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    }
    g.restore();

    // Above 1 slopes look steeper than they are, below 1 flatter.
    const stretchNote = Math.abs(this.stretch - 1) < 0.1
      ? `true proportions${this.cropped ? ` · central ${km(span)} of ${km(this.length)}` : ''}`
      : `heights ×${this.stretch.toFixed(1)} vs distances`;
    if (this.hover !== null && this.hover >= x0 && this.hover <= x0 + width) {
      const d = ((this.hover - x0) / width) * span - half;
      g.strokeStyle = '#16181d'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.hover, top); g.lineTo(this.hover, top + ph); g.stroke();
      const parts = live.map((s) => {
        const i = Math.round(((d + this.length / 2) / this.length) * (s.distances.length - 1));
        const h = s.heights[i];
        if (Number.isFinite(h)) { g.fillStyle = s.colour; g.beginPath(); g.arc(this.hover, y(h), 3.5, 0, 7); g.fill(); }
        // The line is drawn shifted so shapes align; the number is the true height.
        return `${s.label} ${Number.isFinite(h) ? `${Math.round(h - (s.shift || 0))} m` : '–'}`;
      });
      const side = Math.abs(d) < this.length / 200 ? 'summit' : `${km(Math.abs(d))} ${compass(d > 0 ? this.bearing : this.bearing + 180)}`;
      this.readout.textContent = `${side} · ${parts.join(' · ')}`;
    } else {
      this.readout.textContent = stretchNote;
    }
  }
}
