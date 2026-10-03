import { TILE_SIZE, lonToTileX, latToTileY, metersPerPixel } from './tiles.js';
import { fetchBuffer, pooled } from './net.js';

// Sentinel-2 cloudless by EOX: an openly licensed (CC BY-NC-SA 4.0), CORS-open,
// key-free global mosaic at 10 m, a good match for whole-mountain views.
export const IMAGERY_SOURCE = {
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
  maxZoom: 15,
  attribution: 'Imagery: <a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX (contains modified Copernicus Sentinel data 2020)',
};

const tileUrl = (z, x, y) => IMAGERY_SOURCE.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** Imagery zoom giving roughly `pixels` across the box, capped at the source's detail. */
export function imageryZoomFor(lat, boxMetres, pixels = 2048) {
  for (let z = IMAGERY_SOURCE.maxZoom; z >= 0; z--) {
    if (boxMetres / metersPerPixel(lat, z) <= pixels * 1.2) return z;
  }
  return 0;
}

/** Tile range and crop for the box, in Mercator pixels at `zoom`. */
export function boxWindow(lat, lon, boxMetres, zoom) {
  const half = boxMetres / 2 / metersPerPixel(lat, zoom);
  const cx = lonToTileX(lon, zoom) * TILE_SIZE;
  const cy = latToTileY(lat, zoom) * TILE_SIZE;
  const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
  const n = 2 ** zoom;
  const tiles = [];
  for (let ty = Math.floor(y0 / TILE_SIZE); ty <= Math.floor(y1 / TILE_SIZE); ty++) {
    for (let tx = Math.floor(x0 / TILE_SIZE); tx <= Math.floor(x1 / TILE_SIZE); tx++) {
      if (ty < 0 || ty >= n) continue;
      tiles.push({ x: ((tx % n) + n) % n, y: ty, left: tx * TILE_SIZE - x0, top: ty * TILE_SIZE - y0 });
    }
  }
  return { tiles, span: 2 * half };
}

/**
 * Satellite image of exactly the box, north up, `size` pixels square. A tile
 * that fails stays blank rather than failing the whole place: imagery is
 * a texture, not data.
 */
export async function loadImagery({ lat, lon, boxMetres, size = 2048, signal, concurrency = 16 }) {
  const zoom = imageryZoomFor(lat, boxMetres, size);
  const { tiles, span } = boxWindow(lat, lon, boxMetres, zoom);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9aa29a';
  ctx.fillRect(0, 0, size, size);
  const scale = size / span;
  let missing = 0;

  await pooled(tiles, concurrency, async (t) => {
    try {
      const buffer = await fetchBuffer(tileUrl(zoom, t.x, t.y), { signal });
      const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
      ctx.drawImage(bitmap, t.left * scale, t.top * scale, TILE_SIZE * scale + 0.5, TILE_SIZE * scale + 0.5);
      bitmap.close();
    } catch (err) {
      if (signal?.aborted) throw err;
      missing++;
    }
  });
  softenHighlights(ctx, size);
  return { canvas, zoom, missing, tiles: tiles.length };
}

/**
 * The imagery clips snow to white, which leaves the 3D shading nothing to
 * darken or brighten. Pixels brighter than `knee` are compressed towards it
 * (white ends at about 0.86) with their hue kept; rock, forest and grass
 * below the knee are untouched.
 */
export function softenHighlights(ctx, size, { knee = 0.72, slope = 0.5 } = {}) {
  const image = ctx.getImageData(0, 0, size, size);
  softenPixels(image.data, { knee, slope });
  ctx.putImageData(image, 0, 0);
}

export function softenPixels(d, { knee = 0.72, slope = 0.5 } = {}) {
  const k = knee * 255;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.max(d[i], d[i + 1], d[i + 2]);
    if (m <= k) continue;
    const f = (k + (m - k) * slope) / m;
    d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
  }
}
