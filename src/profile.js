const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const niceStep = (span, target = 6) => {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
};
const km = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`);

/**
 * Both profiles in one chart, aligned on their summits (x = 0). The plot
 * fills its height, and says how much heights are stretched relative to
 * distances, so steepness is never silently exaggerated.
 */
export class ProfileChart {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.readout = readout;
    this.series = [];
    this.hover = null;
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

    let lo = Infinity, hi = -Infinity;
    for (const s of live) for (const h of s.heights) if (Number.isFinite(h)) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const pad = Math.max(50, (hi - lo) * 0.08);
    lo -= pad; hi += pad;

    const left = 44, right = 10, top = 8, bottom = 18;
    const pw = W - left - right, ph = H - top - bottom;
    const half = this.length / 2;
    const x = (d) => left + ((d + half) / this.length) * pw;
    const y = (h) => top + (1 - (h - lo) / (hi - lo)) * ph;
    // metres per pixel along each axis: their ratio is the vertical stretch
    this.stretch = (this.length / pw) / ((hi - lo) / ph);

    g.font = '10px system-ui, sans-serif';
    g.strokeStyle = '#eceef1'; g.fillStyle = '#9aa0a8'; g.lineWidth = 1;
    const ys = niceStep(hi - lo, 4);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
      g.beginPath(); g.moveTo(left, y(v)); g.lineTo(W - right, y(v)); g.stroke();
      g.fillText(`${Math.round(v)}`, left - 5, y(v));
    }
    const xs = niceStep(this.length, 6);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    for (let d = Math.ceil(-half / xs) * xs; d <= half; d += xs) {
      g.beginPath(); g.moveTo(x(d), top); g.lineTo(x(d), top + ph); g.stroke();
      if (Math.abs(x(d) - x(-half)) > 28 && Math.abs(x(d) - x(half)) > 28) g.fillText(d === 0 ? 'summit' : km(Math.abs(d)), x(d), H - 4);
    }
    g.fillStyle = '#16181d'; g.font = '600 10px system-ui, sans-serif';
    g.textAlign = 'left'; g.fillText(compass(this.bearing + 180), left + 2, H - 4);
    g.textAlign = 'right'; g.fillText(compass(this.bearing), W - right - 2, H - 4);

    for (const s of live) {
      const path = () => {
        g.beginPath();
        let open = false;
        s.distances.forEach((d, i) => {
          const h = s.heights[i];
          if (!Number.isFinite(h)) { open = false; return; }
          if (open) g.lineTo(x(d), y(h)); else { g.moveTo(x(d), y(h)); open = true; }
        });
      };
      // a light fill under the line, closed against the bottom of the plot
      g.beginPath();
      let first = null, last = null;
      s.distances.forEach((d, i) => {
        const h = s.heights[i];
        if (!Number.isFinite(h)) return;
        if (first === null) { g.moveTo(x(d), top + ph); first = d; }
        g.lineTo(x(d), y(h)); last = d;
      });
      if (first !== null) { g.lineTo(x(last), top + ph); g.closePath(); g.fillStyle = s.fill; g.fill(); }
      path();
      g.strokeStyle = s.colour; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    }

    // Above 1 slopes look steeper than they are, below 1 flatter.
    const stretchNote = Math.abs(this.stretch - 1) < 0.1 ? 'true proportions' : `heights ×${this.stretch.toFixed(1)} vs distances`;
    if (this.hover !== null && this.hover >= left && this.hover <= W - right) {
      const d = ((this.hover - left) / pw) * this.length - half;
      g.strokeStyle = '#16181d'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.hover, top); g.lineTo(this.hover, top + ph); g.stroke();
      const parts = live.map((s) => {
        const i = Math.round(((d + half) / this.length) * (s.distances.length - 1));
        const h = s.heights[i];
        if (Number.isFinite(h)) { g.fillStyle = s.colour; g.beginPath(); g.arc(this.hover, y(h), 3.5, 0, 7); g.fill(); }
        return `${s.label} ${Number.isFinite(h) ? `${Math.round(h)} m` : '–'}`;
      });
      const side = Math.abs(d) < this.length / 200 ? 'summit' : `${km(Math.abs(d))} ${compass(d > 0 ? this.bearing : this.bearing + 180)}`;
      this.readout.textContent = `${side} · ${parts.join(' · ')}`;
    } else {
      this.readout.textContent = stretchNote;
    }
  }
}
