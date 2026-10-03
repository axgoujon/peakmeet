import { Viewer } from './viewer.js';
import { loadHeightfield } from './terrain.js';
import { decodeImage } from './decode.js';
import { loadImagery, IMAGERY_SOURCE } from './imagery.js';
import { buildTerrain, terrainZoomFor } from './mesh.js';
import { fillVoids } from './repair.js';
import { MOUNTAINS, PAIRS, findMountain } from './mountains.js';
import { metersPerPixel, lonToTileX, latToTileY, TERRAIN_SOURCE, EARTH_CIRCUMFERENCE } from './tiles.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const onPhone = matchMedia('(max-width: 820px)').matches;
const KEYS = ['a', 'b'];

const state = {
  box: 10000,
  exaggeration: 1,
  shiftB: 0,
  layout: 'overlay',
  style: { a: 'satellite', b: 'contours' },
  opacity: { a: 1, b: 1 },
  visible: { a: true, b: true },
  places: { a: {}, b: {} },
};

// ------------------------------------------------------------------ status

let statusTimer;
function say(text) {
  const s = $('#status');
  s.textContent = text;
  s.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => s.classList.remove('show'), 3200);
}

// ------------------------------------------------------------- URL state

// The whole comparison lives in the URL, so it can be shared as a link.
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const point = (v) => {
    const [lat, lon] = (v || '').split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  };
  const num = (k, lo, hi) => { const v = Number(p.get(k)); return Number.isFinite(v) && p.has(k) ? Math.min(hi, Math.max(lo, v)) : null; };
  return {
    a: point(p.get('a')), b: point(p.get('b')),
    box: [5000, 10000, 20000, 40000].includes(num('box', 0, 1e9)) ? num('box', 0, 1e9) : null,
    shiftB: num('dz', -5000, 5000), exaggeration: num('ex', 1, 3),
    layout: ['overlay', 'side'].includes(p.get('view')) ? p.get('view') : null,
  };
}

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const f = (x) => x.toFixed(5);
    const parts = KEYS.map((k) => {
      const c = state.places[k].map?.getCenter();
      return c ? `${k}=${f(c.lat)},${f(c.lng)}` : null;
    }).filter(Boolean);
    parts.push(`box=${state.box}`, `dz=${Math.round(state.shiftB)}`, `ex=${state.exaggeration}`, `view=${state.layout}`);
    history.replaceState(null, '', `#${parts.join('&')}`);
  }, 300);
}

// ------------------------------------------------------------------ viewer

const viewer = new Viewer($('#scene'), $('#labels'));
const syncViewer = () => {
  viewer.setOptions({
    exaggeration: state.exaggeration, shiftB: state.shiftB, layout: state.layout,
    style: state.style, opacity: state.opacity, visible: state.visible,
  });
  writeHash();
};

// -------------------------------------------------------------------- maps

const TOPO_STYLE = {
  version: 8,
  sources: {
    topo: {
      type: 'raster', tileSize: 256, maxzoom: 17,
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      attribution: 'Map: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), © OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'topo', type: 'raster', source: 'topo' }],
};

// MapLibre draws 512 px tiles: a screen pixel at zoom z spans what a 256 px
// tile pixel spans at z + 1.
const metresPerScreenPx = (map) => metersPerPixel(map.getCenter().lat, map.getZoom() + 1);

function zoomToFit(container, lat) {
  const fit = 0.6 * Math.min(container.clientWidth || 300, container.clientHeight || 300);
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * (state.box / fit)));
}

function updateFrame(key) {
  const { map, frame } = state.places[key];
  const px = state.box / metresPerScreenPx(map);
  frame.style.width = frame.style.height = `${px}px`;
}

function createMap(key, start) {
  const place = state.places[key];
  const root = $(`.place[data-place=${key}]`);
  const container = $('.map', root);
  place.root = root;
  place.frame = $('.frame', container);
  place.spinner = $('.spinner', container);
  place.map = new maplibregl.Map({
    container, style: TOPO_STYLE,
    center: [start.lon, start.lat], zoom: zoomToFit(container, start.lat),
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
  });
  place.map.touchZoomRotate.disableRotation();
  place.map.on('move', () => updateFrame(key));
  place.map.on('resize', () => updateFrame(key));
  let timer;
  place.map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadPlace(key), 450);
    writeHash();
  });
  updateFrame(key);
}

function jump(key, lat, lon) {
  const { map } = state.places[key];
  map.jumpTo({ center: [lon, lat], zoom: zoomToFit(map.getContainer(), lat) });
}

// ----------------------------------------------------------------- loading

// The named mountain nearest the centre of the box, if any is inside it.
function namedMountain(lat, lon) {
  const metresPerDegLat = 111320, metresPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = Infinity;
  for (const m of MOUNTAINS) {
    const dx = (m.lon - lon) * metresPerDegLon, dy = (m.lat - lat) * metresPerDegLat;
    if (Math.abs(dx) > state.box / 2 || Math.abs(dy) > state.box / 2) continue;
    const d = Math.hypot(dx, dy);
    if (d < bestD) { best = m; bestD = d; }
  }
  return best && bestD < state.box * 0.25 ? best : null;
}

async function loadPlace(key) {
  const place = state.places[key];
  const c = place.map.getCenter();
  const lat = c.lat, lon = c.lng, box = state.box;
  place.ctrl?.abort(new DOMException('superseded', 'AbortError'));
  const ctrl = (place.ctrl = new AbortController());
  place.spinner.hidden = false;
  const zoom = terrainZoomFor(lat, box, 300);
  const size = Math.ceil(box / metersPerPixel(lat, zoom)) + 8;
  try {
    const [hf, imagery] = await Promise.all([
      loadHeightfield({ lat, lon, zoom, size, decode: decodeImage, concurrency: 16, signal: ctrl.signal }),
      loadImagery({ lat, lon, boxMetres: box, size: onPhone ? 1024 : 2048, signal: ctrl.signal }),
    ]);
    if (ctrl.signal.aborted) return;
    const repaired = fillVoids(hf);
    if (repaired.filledCells) console.info(`${key}: filled ${repaired.filledCells} void cells in ${repaired.patches} patches`);
    const named = namedMountain(lat, lon);
    const terrain = buildTerrain(hf, { lat, lon, boxMetres: box, segments: onPhone ? 160 : 256, marker: named });
    place.terrain = terrain;
    place.named = named;
    const search = $('.search', place.root);
    if (named && document.activeElement !== search) search.value = named.name;
    const label = named ? `${key.toUpperCase()} · ${named.name}` : `${key.toUpperCase()} · ${Math.round(terrain.max)} m`;
    viewer.setPlace(key, terrain, imagery.canvas, label);
    updateStats(key);
    if (imagery.missing) say(`${imagery.missing} satellite tiles missing for ${key.toUpperCase()}`);
  } catch (err) {
    if (ctrl.signal.aborted) return;
    console.error(err);
    say(`Could not load ${key.toUpperCase()}: check the connection, then move the map to retry.`);
  } finally {
    if (place.ctrl === ctrl) { place.ctrl = null; place.spinner.hidden = true; }
  }
}

const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

function updateStats(key) {
  const { terrain, named, root, map } = state.places[key];
  if (!terrain) return;
  const relief = km(terrain.max - terrain.min);
  const c = map.getCenter();
  const where = `${Math.abs(c.lat).toFixed(3)}°${c.lat >= 0 ? 'N' : 'S'} ${Math.abs(c.lng).toFixed(3)}°${c.lng >= 0 ? 'E' : 'W'}`;
  let text;
  if (named) {
    const dem = terrain.marker ? Math.round(terrain.marker.elevation) : null;
    // Radar-derived terrain under-reads steep towers; say so rather than hide it.
    const gap = dem != null && named.elevation - dem > 60 ? ` · terrain data ${dem} m` : '';
    text = `<b>${named.name}</b> ${named.elevation} m${gap} · relief ${relief}`;
  } else {
    text = `Highest point <b>${Math.round(terrain.max)} m</b> · relief ${relief} · ${where}`;
  }
  $('.stats', root).innerHTML = text;
}

// ---------------------------------------------------------------- controls

function segmented(group, onPick) {
  $$('button', group).forEach((b) => b.addEventListener('click', () => {
    $$('button', group).forEach((x) => x.classList.toggle('active', x === b));
    onPick(b.dataset.value);
  }));
}
const activate = (group, value) => $$('button', group).forEach((b) => b.classList.toggle('active', b.dataset.value === String(value)));

segmented($('#layout'), (v) => { state.layout = v; syncViewer(); viewer.frame(); });
segmented($('#box'), (v) => {
  state.box = Number(v);
  for (const k of KEYS) { const p = state.places[k]; jump(k, p.map.getCenter().lat, p.map.getCenter().lng); }
  viewer.framed = false;
  writeHash();
});

function setShift(metres) {
  state.shiftB = Math.max(-5000, Math.min(5000, Math.round(metres)));
  $('#shift').value = state.shiftB;
  $('#shiftValue').textContent = `${state.shiftB > 0 ? '+' : ''}${state.shiftB} m`;
  syncViewer();
}
$('#shift').addEventListener('input', (e) => setShift(Number(e.target.value)));
$('#resetShift').addEventListener('click', () => setShift(0));
// The labelled summit (or the box's highest point) is what people compare.
const summitOf = (k) => state.places[k].terrain?.marker?.elevation ?? state.places[k].terrain?.max;
$('#alignSummits').addEventListener('click', () => {
  if (state.places.a.terrain && state.places.b.terrain) setShift(summitOf('a') - summitOf('b'));
});
$('#alignBases').addEventListener('click', () => {
  if (state.places.a.terrain && state.places.b.terrain) setShift(state.places.a.terrain.min - state.places.b.terrain.min);
});

$('#exaggeration').addEventListener('input', (e) => {
  state.exaggeration = Number(e.target.value);
  $('#exaggerationValue').textContent = `×${state.exaggeration.toFixed(1)}`;
  syncViewer();
});

for (const k of KEYS) {
  segmented($(`[data-style=${k}]`), (v) => { state.style[k] = v; syncViewer(); });
  $(`[data-opacity=${k}]`).addEventListener('input', (e) => { state.opacity[k] = Number(e.target.value); syncViewer(); });
  const eye = $(`[data-visible=${k}]`);
  eye.addEventListener('click', () => {
    state.visible[k] = !state.visible[k];
    eye.setAttribute('aria-pressed', String(state.visible[k]));
    syncViewer();
  });
}

$('#reframe').addEventListener('click', () => viewer.frame());

function syncInset() {
  const card = $('#controls');
  const open = !card.classList.contains('collapsed');
  // On a phone the card spans the full width, so shifting would not help.
  viewer.setLeftInset(open && !onPhone ? card.offsetLeft + card.offsetWidth : 0);
}
$('#controlsHead').addEventListener('click', () => {
  const card = $('#controls');
  card.classList.toggle('collapsed');
  $('#controlsHead').setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
  syncInset();
});
// Open, the card covers ~300 px of the 3D view: start collapsed unless there is room.
if ($('.viewer').clientWidth < 900) $('#controls').classList.add('collapsed');
syncInset();
addEventListener('resize', syncInset);

// -------------------------------------------------------------- mountains

$('#mountainList').innerHTML = MOUNTAINS
  .map((m) => `<option value="${m.name}">${m.region} · ${m.elevation} m</option>`).join('');

for (const k of KEYS) {
  const input = $(`.place[data-place=${k}] .search`);
  input.addEventListener('change', () => {
    const m = findMountain(input.value);
    if (m) { jump(k, m.lat, m.lon); input.blur(); return; }
    const [lat, lon] = input.value.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) { jump(k, lat, lon); return; }
    if (input.value.trim()) say(`No mountain called "${input.value}" in the list`);
  });
}

for (const [a, b] of PAIRS) {
  const btn = document.createElement('button');
  btn.textContent = `${a} vs ${b}`;
  btn.addEventListener('click', () => choosePair(a, b));
  $('#pairs').append(btn);
}

function choosePair(a, b) {
  const ma = findMountain(a), mb = findMountain(b);
  $('.place[data-place=a] .search').value = ma.name;
  $('.place[data-place=b] .search').value = mb.name;
  viewer.framed = false;
  setShift(0);
  jump('a', ma.lat, ma.lon);
  jump('b', mb.lat, mb.lon);
}

$('#credits').innerHTML = [
  TERRAIN_SOURCE.attribution, IMAGERY_SOURCE.attribution,
  'Maps: © OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
].join('<br>');

// ------------------------------------------------------------------ start

const fromUrl = readHash();
if (fromUrl.box) { state.box = fromUrl.box; activate($('#box'), state.box); }
if (fromUrl.layout) { state.layout = fromUrl.layout; activate($('#layout'), state.layout); }
if (fromUrl.exaggeration) {
  state.exaggeration = fromUrl.exaggeration;
  $('#exaggeration').value = state.exaggeration;
  $('#exaggerationValue').textContent = `×${state.exaggeration.toFixed(1)}`;
}
const [defaultA, defaultB] = PAIRS[0].map(findMountain);
const startA = fromUrl.a ?? defaultA, startB = fromUrl.b ?? defaultB;
if (!fromUrl.a) $('.place[data-place=a] .search').value = defaultA.name;
if (!fromUrl.b) $('.place[data-place=b] .search').value = defaultB.name;
createMap('a', startA);
createMap('b', startB);
setShift(fromUrl.shiftB ?? 0);
for (const k of KEYS) loadPlace(k);

window.__compare = { state, viewer, loadPlace, jump, choosePair };
