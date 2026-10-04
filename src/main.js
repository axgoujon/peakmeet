import { Viewer } from './viewer.js';
import { loadHeightfield } from './terrain.js';
import { decodeImage } from './decode.js';
import { loadImagery, IMAGERY_SOURCE } from './imagery.js';
import { buildTerrain, terrainZoomFor, profileLine, radialRange, correctSummits, restoreSummits, toLocal } from './mesh.js';
import { ProfileChart, compass } from './profile.js';
import { fillDepressions, fillVoids } from './repair.js';
import { MOUNTAINS, PAIRS, findMountain } from './mountains.js';
import { attachSearch } from './search.js';
import { RANGES, SIZES, findRange } from './ranges.js';
import { VERSION } from './version.js';
import { metersPerPixel, lonToTileX, latToTileY, TERRAIN_SOURCE, EARTH_CIRCUMFERENCE } from './tiles.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const onPhone = matchMedia('(max-width: 820px)').matches;
const KEYS = ['a', 'b'];

const state = {
  box: 10000,
  exaggeration: 1,
  shiftB: 0,
  // 'sea' | 'summits' | 'bases' | 'custom': a mode, so it stays true when places change
  shiftMode: 'sea',
  layout: 'side',
  split: { follow: true, bearing: 0 },
  style: { a: 'satellite', b: 'satellite' },
  opacity: { a: 1, b: 1 },
  visible: { a: true, b: true },
  profile: { on: false, bearing: 70 },
  correct: true,
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
    box: SIZES.includes(num('box', 0, 1e9)) ? num('box', 0, 1e9) : null,
    shiftB: num('dz', -5000, 5000), exaggeration: num('ex', 1, 3),
    shiftMode: ['summits', 'bases'].includes(p.get('dz')) ? p.get('dz') : null,
    layout: ['overlay', 'side', 'split'].includes(p.get('view')) ? p.get('view') : null,
    cut: num('cut', 0, 359),
    profile: p.get('prof') === '1',
    bearing: num('brg', 0, 359),
    correct: p.get('fix') !== '0',
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
    parts.push(`box=${state.box}`, `dz=${['summits', 'bases'].includes(state.shiftMode) ? state.shiftMode : Math.round(state.shiftB)}`, `ex=${state.exaggeration}`, `view=${state.layout}`);
    if (state.layout === 'split' && !state.split.follow) parts.push(`cut=${Math.round(state.split.bearing)}`);
    if (state.profile.on) parts.push('prof=1', `brg=${state.profile.bearing}`);
    if (!state.correct) parts.push('fix=0');
    history.replaceState(null, '', `#${parts.join('&')}`);
  }, 300);
}

// ------------------------------------------------------------------ viewer

const viewer = new Viewer($('#scene'), $('#labels'));
const syncViewer = () => {
  viewer.setOptions({
    exaggeration: state.exaggeration, shiftB: state.shiftB, layout: state.layout, split: state.split,
    style: state.style, opacity: state.opacity, visible: state.visible,
  });
  $('#splitRow').hidden = $('#splitButtons').hidden = state.layout !== 'split';
  $('.view-buttons .lock-cut').hidden = state.layout !== 'split';
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

// What the place shows: a range when the map sits on one's centre, else the
// listed mountain nearest the centre of the circle, if any is near it.
function namedPlace(lat, lon) {
  const metresPerDegLat = 111320, metresPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const away = (m) => Math.hypot((m.lon - lon) * metresPerDegLon, (m.lat - lat) * metresPerDegLat);
  const range = RANGES.find((r) => away(r) < Math.max(800, r.size * 0.03));
  if (range) return range;
  let best = null, bestD = Infinity;
  for (const m of MOUNTAINS) {
    const d = away(m);
    if (d < bestD) { best = m; bestD = d; }
  }
  return best && bestD < state.box * 0.25 ? best : null;
}

const isRange = (place) => place?.kind === 'range';

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
    const bowls = fillDepressions(hf);
    const repaired = fillVoids(hf);
    if (bowls.filledCells || repaired.filledCells) {
      console.info(`${key}: filled ${bowls.filledCells} cells in ${bowls.bowls} void bowls, ${repaired.filledCells} in ${repaired.patches} pits`);
    }
    const named = namedPlace(lat, lon);
    // A range has no single summit: its profile runs through its highest point.
    const terrain = buildTerrain(hf, { lat, lon, boxMetres: box, segments: onPhone ? 160 : 256, marker: isRange(named) ? null : named });
    // A hand-set shift belonged to the previous pair: once a place becomes a
    // different mountain, it would silently misstate heights, so it resets.
    const moved = !!place.centre && ((named?.name ?? null) !== (place.named?.name ?? null))
      || (!!place.centre && Math.hypot((lat - place.centre.lat) * 111320, (lon - place.centre.lon) * 111320 * Math.cos((lat * Math.PI) / 180)) > box / 2);
    place.peaks = listedPeaksIn(lat, lon, box);
    if (state.correct) correctSummits(terrain, place.peaks);
    place.terrain = terrain;
    place.band = radialRange(terrain);
    place.centre = { lat, lon };
    place.named = named;
    const search = $('.search', place.root);
    if (named && document.activeElement !== search) search.value = named.name;
    const label = { name: named ? named.name : `${Math.round(terrain.max)} m` };
    viewer.setPlace(key, terrain, imagery.canvas, label);
    updateLabels();
    updateStats(key);
    if (state.shiftMode === 'custom' && moved) {
      setShift(0, 'sea');
      say('Height shift reset: it was set for the previous mountain');
    } else applyShiftMode();
    updateProfiles();
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
  if (isRange(named)) {
    text = `<b>${named.name}</b> · highest point ${Math.round(terrain.max)} m · relief ${relief}`;
  } else if (named) {
    // Radar-derived terrain under-reads steep towers; say so, and whether the
    // peak was lifted to its official height.
    const raised = (terrain.corrections ?? []).filter((c) => c.to - c.from >= 30);
    const fix = raised.find((c) => c.name === named.name);
    const others = raised.length - (fix ? 1 : 0);
    const dem = terrain.dataMarker ? Math.round(terrain.dataMarker.elevation) : null;
    let note = '';
    if (fix) note = ` · data ${Math.round(fix.from)} m, raised +${Math.round(fix.to - fix.from)} m`;
    else if (dem != null && named.elevation - dem > 60) note = ` · terrain data ${dem} m`;
    if (others > 0) note += ` · ${others} other summit${others > 1 ? 's' : ''} raised`;
    text = `<b>${named.name}</b> ${named.elevation} m${note} · relief ${relief}`;
  } else {
    text = `Highest point <b>${Math.round(terrain.max)} m</b> · relief ${relief} · ${where}`;
  }
  $('.stats', root).innerHTML = text;
}

// Listed mountains inside a box, in its local metres, for summit correction.
function listedPeaksIn(lat, lon, box) {
  return MOUNTAINS.map((m) => ({ name: m.name, elevation: m.elevation, ...toLocal(lat, lon, m.lat, m.lon) }))
    .filter((p) => Math.abs(p.east) <= box / 2 && Math.abs(p.north) <= box / 2);
}

function applyCorrection() {
  for (const k of KEYS) {
    const place = state.places[k];
    if (!place.terrain) continue;
    restoreSummits(place.terrain);
    if (state.correct) correctSummits(place.terrain, place.peaks);
    place.band = radialRange(place.terrain);
    viewer.refreshGeometry(k);
    updateStats(k);
  }
  applyShiftMode();
  updateLabels();
  updateProfiles();
  writeHash();
}

// ---------------------------------------------------------------- controls

function segmented(group, onPick) {
  $$('button', group).forEach((b) => b.addEventListener('click', () => {
    $$('button', group).forEach((x) => x.classList.toggle('active', x === b));
    onPick(b.dataset.value);
  }));
}
const activate = (group, value) => $$('button', group).forEach((b) => b.classList.toggle('active', b.dataset.value === String(value)));

segmented($('#layout'), (v) => { state.layout = v; syncViewer(); viewer.frame(); syncCut(); });

// Split view: the cut either follows the camera (A left, B right on screen)
// or stays at a compass bearing set here, with the camera free to turn.
function syncCut() {
  const bearing = Math.round(viewer.splitBearing()) % 360;
  $('#cut').value = bearing;
  $('#cutValue').textContent = bearingLabel(bearing);
  $$('.lock-cut').forEach((b) => b.setAttribute('aria-pressed', String(!state.split.follow)));
}
$('#cut').addEventListener('input', (e) => {
  state.split = { follow: false, bearing: Number(e.target.value) };
  syncViewer();
  syncCut();
});
// Locking keeps the cut where it is on the ground; unlocking makes it turn
// with the view again. One button in the card, one by Rotate.
$$('.lock-cut').forEach((b) => b.addEventListener('click', () => {
  state.split = { ...state.split, follow: !state.split.follow, bearing: Math.round(viewer.splitBearing()) };
  syncViewer();
  syncCut();
}));
const sizeLabel = (m) => `Ø ${m / 1000} km`;
function setBox(metres) {
  if (metres === state.box) return;
  state.box = metres;
  $('#box').value = SIZES.indexOf(metres);
  $('#boxValue').textContent = sizeLabel(metres);
  for (const k of KEYS) { const p = state.places[k]; jump(k, p.map.getCenter().lat, p.map.getCenter().lng); }
  viewer.framed = false;
  writeHash();
}
// The label follows the slider; the (heavy) reload waits for its release.
$('#box').addEventListener('input', (e) => { $('#boxValue').textContent = sizeLabel(SIZES[Number(e.target.value)]); });
$('#box').addEventListener('change', (e) => setBox(SIZES[Number(e.target.value)]));

function setShift(metres, mode = 'custom') {
  state.shiftB = Math.max(-5000, Math.min(5000, Math.round(metres)));
  state.shiftMode = mode;
  $('#shift').value = state.shiftB;
  $('#shiftValue').textContent = `${state.shiftB > 0 ? '+' : ''}${state.shiftB} m`;
  $$('#shiftModes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  syncViewer();
  updateLabels();
  updateProfiles();
}

// The labelled summit (or the box's highest point) is what people compare.
const summitOf = (k) => state.places[k].terrain?.marker?.elevation ?? state.places[k].terrain?.max;

function applyShiftMode() {
  const { a, b } = state.places;
  if (state.shiftMode === 'sea') setShift(0, 'sea');
  if (!a.terrain || !b.terrain) return;
  if (state.shiftMode === 'summits') setShift(summitOf('a') - summitOf('b'), 'summits');
  if (state.shiftMode === 'bases') setShift(a.terrain.min - b.terrain.min, 'bases');
}

$('#shift').addEventListener('input', (e) => setShift(Number(e.target.value), 'custom'));
$$('#shiftModes button').forEach((b) => b.addEventListener('click', () => {
  state.shiftMode = b.dataset.mode;
  applyShiftMode();
}));

const shiftText = () => (state.shiftB ? `shifted ${state.shiftB > 0 ? '+' : ''}${state.shiftB} m` : '');

// B's 3D label carries its shift, so a moved surface is never read as true height.
function updateLabels() {
  for (const k of KEYS) {
    const { named, terrain } = state.places[k];
    if (!terrain) continue;
    const name = named ? named.name : `${Math.round(terrain.max)} m`;
    const note = k === 'b' && state.shiftB ? `${state.shiftB > 0 ? '+' : ''}${state.shiftB} m shift` : '';
    viewer.setLabel(k, { name, note });
  }
}

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
    updateProfiles();
  });
}

// Full screen: hide the maps so the 3D view fills the window, and ask the
// browser for real full screen where it allows it (not on iPhone).
function setFocus(on) {
  document.body.classList.toggle('focus', on);
  $('#fullscreen').setAttribute('aria-pressed', String(on));
  $('#fullscreen').textContent = on ? 'Exit full screen' : 'Full screen';
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
$('#fullscreen').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
// Leaving the browser's full screen (Esc) also brings the maps back.
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setFocus(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('focus') && !document.fullscreenElement) setFocus(false);
});

$('#reframe').addEventListener('click', () => viewer.frame());
$('#correct').addEventListener('change', (e) => { state.correct = e.target.checked; applyCorrection(); });

viewer.onAutoRotate = (on) => {
  $('#rotate').setAttribute('aria-pressed', String(on));
  $('#rotate span').textContent = on ? 'Pause' : 'Rotate';
};
$('#rotate').addEventListener('click', () => viewer.setAutoRotate(!viewer.controls.autoRotate));
// No point turning a view nobody can see.
document.addEventListener('visibilitychange', () => { if (document.hidden) viewer.setAutoRotate(false); });

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

// ---------------------------------------------------------------- profile

const chart = new ProfileChart($('#profileChart'), $('#profileReadout'));
$('#profileScale').addEventListener('click', (e) => {
  chart.trueScale = !chart.trueScale;
  e.currentTarget.setAttribute('aria-pressed', String(chart.trueScale));
  chart.draw();
});
const FILL = { a: 'rgba(232,145,45,.2)', b: 'rgba(59,130,246,.17)' };
const STROKE = { a: '#e8912d', b: '#3b82f6' };
const bearingLabel = (b) => `${compass(b + 180)}–${compass(b)}`;

// Metres east/north of the box centre to coordinates, close enough for a
// line drawn on a map within a box of a few tens of km.
const offsetToLngLat = (centre, east, north) => [
  centre.lon + east / (111320 * Math.cos((centre.lat * Math.PI) / 180)),
  centre.lat + north / 111320,
];

function setMapLine(key, coordinates) {
  const { map } = state.places[key];
  if (!map.isStyleLoaded()) { map.once('idle', () => setMapLine(key, coordinates)); return; }
  const data = coordinates.length > 1
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }
    : { type: 'FeatureCollection', features: [] };
  if (map.getSource('profile')) map.getSource('profile').setData(data);
  else {
    map.addSource('profile', { type: 'geojson', data });
    map.addLayer({ id: 'profile-halo', type: 'line', source: 'profile', paint: { 'line-color': '#fff', 'line-width': 5, 'line-opacity': 0.8 } });
    map.addLayer({ id: 'profile', type: 'line', source: 'profile', paint: { 'line-color': STROKE[key], 'line-width': 2.5 } });
  }
}

// The maps redraw their line at most every 150 ms, with the latest cut last.
const mapLineTimers = {}, mapLinePending = {}, mapLineLast = {};
function setMapLineSoon(key, coordinates) {
  mapLinePending[key] = coordinates;
  if (mapLineTimers[key]) return;
  const wait = Math.max(0, 150 - (performance.now() - (mapLineLast[key] || 0)));
  mapLineTimers[key] = setTimeout(() => {
    mapLineTimers[key] = 0;
    mapLineLast[key] = performance.now();
    setMapLine(key, mapLinePending[key]);
  }, wait);
}

function updateProfiles() {
  const on = state.profile.on;
  $('#profileCard').hidden = !on;
  $('.viewer').classList.toggle('with-profile', on);
  $('#profileToggle').setAttribute('aria-pressed', String(on));
  $('#profileToggle').textContent = on ? 'Hide' : 'Show';
  $('#bearingValue').textContent = bearingLabel(state.profile.bearing);
  const series = [];
  for (const k of KEYS) {
    const place = state.places[k];
    if (!place.terrain) continue;
    if (!on) { viewer.setProfileLine(k, null); setMapLine(k, []); continue; }
    const prof = profileLine(place.terrain, { bearing: state.profile.bearing });
    viewer.setProfileLine(k, prof);
    const coords = prof.points.filter((_, i) => Number.isFinite(prof.heights[i])).map((q) => offsetToLngLat(place.centre, q.east, q.north));
    setMapLineSoon(k, coords);
    const shift = k === 'b' ? state.shiftB : 0;
    const name = place.named?.name ?? k.toUpperCase();
    series.push({
      key: k, visible: state.visible[k], colour: STROKE[k], fill: FILL[k], shift,
      band: { radii: place.band.radii, min: place.band.min.map((h) => h + shift), max: place.band.max.map((h) => h + shift) },
      label: name,
      distances: prof.distances, heights: prof.heights.map((h) => h + shift),
    });
  }
  if (on) {
    chart.setData(series, { length: state.box, bearing: state.profile.bearing });
    $('#profileLegend').innerHTML = KEYS.filter((k) => state.places[k].terrain && state.visible[k]).map((k) => {
      const name = state.places[k].named?.name ?? k.toUpperCase();
      const shift = k === 'b' && state.shiftB ? ` <em>${shiftText()}</em>` : '';
      return `<span><i style="background:${STROKE[k]}"></i>${name}${shift}</span>`;
    }).join('') + '<span class="hint">line: this view · shading: all directions</span>';
  }
  writeHash();
}

$('#profileToggle').addEventListener('click', () => { state.profile.on = !state.profile.on; updateProfiles(); });
$('#closeProfile').addEventListener('click', () => { state.profile.on = false; updateProfiles(); });
// The cut runs left to right across the screen, so the chart reads like the
// 3D view: orbiting changes it, and the slider turns the camera.
const profileBearingFor = (view) => Math.round((view + 90) % 360);
let viewFrame = 0;
viewer.onViewChange = (view) => {
  if (state.layout === 'split' && state.split.follow) syncCut();
  const bearing = profileBearingFor(view);
  if (bearing === state.profile.bearing) return;
  state.profile.bearing = bearing;
  $('#bearing').value = bearing;
  $('#bearingValue').textContent = bearingLabel(bearing);
  if (!state.profile.on || viewFrame) return;
  viewFrame = requestAnimationFrame(() => { viewFrame = 0; updateProfiles(); });
};
$('#bearing').addEventListener('input', (e) => viewer.setViewBearing((Number(e.target.value) + 270) % 360));

// -------------------------------------------------------------- mountains

for (const k of KEYS) {
  attachSearch($(`.place[data-place=${k}] .search`), {
    mountains: [...MOUNTAINS, ...RANGES],
    onPick: (m) => {
      if (isRange(m)) setBox(m.size);
      jump(k, m.lat, m.lon);
    },
    onFreeText: (text) => {
      const [lat, lon] = text.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) jump(k, lat, lon);
      else say(`No mountain or range called "${text}" in the list`);
    },
  });
}

for (const [a, b] of PAIRS) {
  const btn = document.createElement('button');
  btn.textContent = `${a} vs ${b}`;
  btn.addEventListener('click', () => choosePair(a, b));
  $('#pairs').append(btn);
}

function choosePair(a, b) {
  const ma = findMountain(a) ?? findRange(a), mb = findMountain(b) ?? findRange(b);
  const sizes = [ma, mb].filter(isRange).map((r) => r.size);
  if (sizes.length) setBox(Math.max(...sizes));
  $('.place[data-place=a] .search').value = ma.name;
  $('.place[data-place=b] .search').value = mb.name;
  viewer.framed = false;
  setShift(0, 'sea');
  jump('a', ma.lat, ma.lon);
  jump('b', mb.lat, mb.lon);
}

$('#credits').innerHTML = [
  TERRAIN_SOURCE.attribution, IMAGERY_SOURCE.attribution,
  'Maps: © OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
  `Version ${VERSION}`,
].join('<br>');

// ------------------------------------------------------------------ start

const fromUrl = readHash();
if (fromUrl.box) { state.box = fromUrl.box; $('#box').value = SIZES.indexOf(state.box); $('#boxValue').textContent = sizeLabel(state.box); }
if (fromUrl.layout) { state.layout = fromUrl.layout; activate($('#layout'), state.layout); }
if (fromUrl.cut != null) state.split = { follow: false, bearing: fromUrl.cut };
if (fromUrl.exaggeration) {
  state.exaggeration = fromUrl.exaggeration;
  $('#exaggeration').value = state.exaggeration;
  $('#exaggerationValue').textContent = `×${state.exaggeration.toFixed(1)}`;
}
if (fromUrl.profile) state.profile.on = true;
state.correct = fromUrl.correct; $('#correct').checked = state.correct;
if (fromUrl.bearing != null) { state.profile.bearing = Math.round(fromUrl.bearing); $('#bearing').value = state.profile.bearing; }
const [defaultA, defaultB] = PAIRS[0].map(findMountain);
const startA = fromUrl.a ?? defaultA, startB = fromUrl.b ?? defaultB;
if (!fromUrl.a) $('.place[data-place=a] .search').value = defaultA.name;
if (!fromUrl.b) $('.place[data-place=b] .search').value = defaultB.name;
createMap('a', startA);
createMap('b', startB);
if (fromUrl.shiftMode) { state.shiftMode = fromUrl.shiftMode; setShift(0, fromUrl.shiftMode); }
else setShift(fromUrl.shiftB ?? 0, fromUrl.shiftB ? 'custom' : 'sea');
viewer.preferredBearing = (state.profile.bearing + 270) % 360;
for (const k of KEYS) loadPlace(k);
updateProfiles();
syncViewer();
syncCut();

window.__compare = { state, viewer, loadPlace, jump, choosePair };
