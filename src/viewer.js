import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const PLACE_COLOURS = { a: '#e8912d', b: '#3b82f6' };

// Contour lines drawn from height, so one surface can float over another
// without hiding it. Lines follow the place's own heights in metres (a
// vertical shift moves them with the surface; it does not renumber them),
// with every fifth line drawn heavier.
function contourMaterial(colour) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColour: { value: new THREE.Color(colour) },
      uStep: { value: 100 },
      uShift: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: `
      varying float vHeight;
      uniform float uShift;
      void main() {
        vHeight = position.y + uShift;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying float vHeight;
      uniform vec3 uColour;
      uniform float uStep;
      uniform float uOpacity;
      float lineAt(float spacing, float width) {
        float d = abs(fract(vHeight / spacing + 0.5) - 0.5) * spacing;   // metres to the nearest line
        float w = fwidth(vHeight) * width;
        return 1.0 - smoothstep(w * 0.5, w * 1.5, d);
      }
      void main() {
        float line = max(lineAt(uStep, 1.0), lineAt(uStep * 5.0, 2.2));
        if (line < 0.02) discard;
        gl_FragColor = vec4(uColour, line * uOpacity);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const niceStep = (span) => {
  const raw = span / 8, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw);
};

/**
 * Both places share one scene in true metres. They sit in a group so that
 * vertical exaggeration applies equally; B's vertical shift is in metres in
 * that group, so it stays truthful at any exaggeration.
 */
export class Viewer {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true }));
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#e6ebf1');
    scene.add(new THREE.HemisphereLight('#ffffff', '#7d7466', 1.6));
    // Light from the north-west, the cartographic convention for reading relief.
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(-1, 1.1, -0.9);
    scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(35, 1, 10, 3e6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('change', () => { this.render(); this.onViewChange?.(this.viewBearing()); });

    this.group = new THREE.Group();
    scene.add(this.group);
    this.places = { a: null, b: null };
    this.options = {
      exaggeration: 1, shiftB: 0, layout: 'overlay',
      style: { a: 'satellite', b: 'contours' }, opacity: { a: 1, b: 1 }, visible: { a: true, b: true },
    };
    this.framed = false;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyOffset();
  }

  /**
   * Keeps the scene centred in the part of the view not covered on the left
   * by `px` of overlay (the controls card), by shifting the projection rather
   * than the camera, so orbiting still turns around the mountains.
   */
  setLeftInset(px) {
    this.leftInset = px;
    this.applyOffset();
  }

  applyOffset() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    const shift = Math.min(this.leftInset || 0, w * 0.45) / 2;
    if (shift > 0) this.camera.setViewOffset(w, h, -shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setPlace(key, terrain, image, label) {
    this.clearPlace(key);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(terrain.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(terrain.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(terrain.indices, 1));
    geometry.computeVertexNormals();

    const texture = new THREE.CanvasTexture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.anisotropy = this.maxAnisotropy;
    const materials = {
      satellite: new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 }),
      colour: new THREE.MeshStandardMaterial({ color: PLACE_COLOURS[key], roughness: 0.85, metalness: 0 }),
      contours: contourMaterial(PLACE_COLOURS[key]),
    };
    const mesh = new THREE.Mesh(geometry, materials.satellite);
    // B draws after A, so where it is translucent it blends over A, not under.
    mesh.renderOrder = key === 'a' ? 0 : 1;
    this.group.add(mesh);
    this.places[key] = { mesh, materials, texture, terrain, label };
    this.apply();
    if (!this.framed && this.places.a && this.places.b) this.frame();
  }

  /**
   * Draws the profile's path on the terrain. It is a child of the mesh, so it
   * follows the layout and B's shift. Raised a little to stay above the
   * surface it was sampled from.
   */
  setProfileLine(key, profile) {
    const p = this.places[key];
    if (!p) return;
    if (p.line) { p.mesh.remove(p.line); p.line.geometry.dispose(); p.line.material.dispose(); p.line = null; }
    if (profile) {
      const pts = [];
      profile.points.forEach((q, i) => {
        const h = profile.heights[i];
        if (Number.isFinite(h)) pts.push(new THREE.Vector3(q.east, h + 12, -q.north));
      });
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      p.line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: key === 'a' ? '#ff7a00' : '#1d4ed8' }));
      p.line.renderOrder = 2;
      p.mesh.add(p.line);
    }
    this.render();
  }

  setLabel(key, text) {
    if (!this.places[key]) return;
    this.places[key].label = text;
    this.placeLabels();
  }

  clearPlace(key) {
    const p = this.places[key];
    if (!p) return;
    if (p.line) { p.line.geometry.dispose(); p.line.material.dispose(); }
    this.group.remove(p.mesh);
    p.mesh.geometry.dispose();
    for (const m of Object.values(p.materials)) m.dispose();
    p.texture.dispose();
    this.places[key] = null;
  }

  setOptions(changes) {
    for (const [k, v] of Object.entries(changes)) {
      this.options[k] = typeof v === 'object' && !Array.isArray(v) ? { ...this.options[k], ...v } : v;
    }
    this.apply();
  }

  // Everything that depends on options or on both places at once.
  apply() {
    const o = this.options;
    this.group.scale.y = o.exaggeration;
    const box = Math.max(...['a', 'b'].map((k) => this.places[k]?.terrain.boxMetres ?? 0), 1);
    const gap = box * 0.08;
    for (const key of ['a', 'b']) {
      const p = this.places[key];
      if (!p) continue;
      const material = p.materials[o.style[key]];
      if (material.isShaderMaterial) {
        material.uniforms.uOpacity.value = o.opacity[key];
        material.uniforms.uStep.value = p.terrain.boxMetres > 20000 ? 250 : p.terrain.boxMetres > 10000 ? 200 : 100;
      } else {
        material.opacity = o.opacity[key];
        material.transparent = o.opacity[key] < 1;
      }
      p.mesh.material = material;
      p.mesh.visible = o.visible[key];
      p.mesh.position.x = o.layout === 'side' ? (key === 'a' ? -1 : 1) * (box + gap) / 2 : 0;
      p.mesh.position.y = key === 'b' ? o.shiftB : 0;
    }
    this.updateGrid(box, gap);
    this.render();
  }

  updateGrid(box, gap) {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const shown = ['a', 'b'].map((k) => this.places[k]).filter((p) => p && p.mesh.visible);
    if (!shown.length) { this.grid = null; return; }
    const width = this.options.layout === 'side' ? 2 * box + gap : box;
    const step = niceStep(box);
    const divisions = Math.max(1, Math.round(width / step));
    this.grid = new THREE.GridHelper(divisions * step, divisions, '#9aa3ad', '#c3c9d0');
    const floor = Math.min(...shown.map((p) => p.terrain.min + p.mesh.position.y));
    this.grid.position.y = floor * this.options.exaggeration - 2;
    this.gridStep = step;
    this.scene.add(this.grid);
  }

  /** Base and summit of each shown place, in metres after B's shift. */
  extents() {
    return ['a', 'b'].map((k) => this.places[k]).filter((p) => p && p.mesh.visible)
      .map((p) => ({ min: p.terrain.min + p.mesh.position.y, max: p.terrain.max + p.mesh.position.y }));
  }

  frame() {
    const e = this.extents();
    if (!e.length) return;
    const box = Math.max(...['a', 'b'].map((k) => this.places[k]?.terrain.boxMetres ?? 0));
    const width = this.options.layout === 'side' ? box * 2.1 : box;
    const lo = Math.min(...e.map((x) => x.min)) * this.options.exaggeration;
    const hi = Math.max(...e.map((x) => x.max)) * this.options.exaggeration;
    const target = new THREE.Vector3(0, (lo + hi) / 2, 0);
    const depth = box;
    const radius = 0.5 * Math.hypot(width, depth, hi - lo);
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const w = this.canvas.parentElement.clientWidth || 1;
    const visibleAspect = this.camera.aspect * (1 - Math.min(this.leftInset || 0, w * 0.45) / w);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * visibleAspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.95;
    // Keep the direction the user has orbited to; otherwise use the preferred
    // one. Seen from about 33 degrees above the horizon.
    const bearing = ((this.framed ? this.viewBearing() : this.preferredBearing ?? 340) * Math.PI) / 180;
    const up = THREE.MathUtils.degToRad(33);
    const dir = new THREE.Vector3(-Math.sin(bearing) * Math.cos(up), Math.sin(up), Math.cos(bearing) * Math.cos(up));
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.controls.target.copy(target);
    this.controls.update();
    this.framed = true;
    this.render();
  }

  /** Compass bearing the camera looks towards (x is east, -z is north). */
  viewBearing() {
    const o = this.camera.position.clone().sub(this.controls.target);
    const b = (Math.atan2(-o.x, o.z) * 180) / Math.PI;
    return ((b % 360) + 360) % 360;
  }

  /** Orbits to look towards `bearing`, keeping distance and height. */
  setViewBearing(bearing) {
    const t = this.controls.target, o = this.camera.position.clone().sub(t);
    const horizontal = Math.hypot(o.x, o.z), r = (bearing * Math.PI) / 180;
    this.camera.position.set(t.x - horizontal * Math.sin(r), this.camera.position.y, t.z + horizontal * Math.cos(r));
    this.controls.update();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  // Summit labels follow the 3D summits on screen.
  placeLabels() {
    if (!this.labelLayer) return;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    const placed = {};
    for (const key of ['a', 'b']) {
      const el = this.labelLayer.querySelector(`[data-place=${key}]`);
      const p = this.places[key];
      if (!el) continue;
      if (!p || !p.mesh.visible) { el.hidden = true; continue; }
      const s = p.terrain.marker ?? p.terrain.summit;
      const v = new THREE.Vector3(s.east, s.elevation, -s.north);
      p.mesh.localToWorld(v);
      v.project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.hidden = !visible;
      el.textContent = p.label;
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      // In overlay with aligned summits both labels land on the same spot;
      // then B's label goes below its summit instead of above.
      const a = placed.a;
      const clash = key === 'b' && a && Math.abs(a.y - y) < 30 && Math.abs(a.x - x) < (a.width + el.offsetWidth) / 2;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${clash ? '40%' : '-100%'})`;
      placed[key] = { x, y, width: el.offsetWidth };
    }
  }

  capture() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}
