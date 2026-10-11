// Draws LHX's captured 3D scene with WebGL (three.js) at full display resolution.
//
// Inside each 3D window the GPU draws the sky and ground (from the horizon the game computed) and
// the models the game drew this frame, from the game's own camera-space points, with a projection
// identical to the game's. The game's 320 x 200 frame is then laid on top: cockpit, instruments
// and HUD, with the 3D window left transparent where the game's own 3D drawing was keyed out.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const W = 320, H = 200;
const NEAR = 1, FAR = 1e7;          // half-feet (captured points are converted to half-feet)
const LINE_LIFT = 5e-4;           // fraction of the distance lines move toward the eye
const DECAL_LIFT = 1e-4;          // fraction of the distance a detail polygon moves toward the eye, per rank
// Enhanced-mode terrain (see Relief)
// Things lying on the terrain are moved toward the eye by a fraction of their distance, which keeps
// their order at any range: runway concrete, then the game's ground markings (and the helicopter's
// shadow), then the shadows of replacement models.
const RUNWAY_LIFT = 1e-3;
const TERRAIN_LIFT = 2e-3;
const SHADOW_LIFT = 1.2e-2;        // shadows lie on terrain that can slope a little under their flat plane
const DRAPE_STEP = 400;           // ground markings are cut into pieces this long (half-feet) to follow the terrain
const SKY_DISTANCE = 1e4;         // the star field (drawn around the camera) is pushed out behind the terrain

// Polygons reaching behind the eye (a runway the helicopter stands on) are clipped here rather
// than by the GPU: depth interpolated across a triangle whose w spans from the near plane to
// kilometres away is too coarse to keep the lifted detail polygons in front.
const CLIP_Z = -NEAR * 2;          // three.js view space: in front of the eye means z < 0
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = a[2] <= CLIP_Z, inb = b[2] <= CLIP_Z;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (CLIP_Z - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, CLIP_Z]);
    }
  }
  return out;
}

// The game draws point fields (the ground-dot field, stars) first, then markings lying on the
// ground (runways, roads), then the models, and nothing drawn earlier hides anything drawn later:
// a landed helicopter's model reaches below height 0 and is still drawn whole. Each layer is drawn
// here with a fresh depth buffer, so only models hide models.
function layerOf(o) {
  if (o.prims.every((p) => p.kind === 2 || p.kind === 3)) return 0;
  if (o.flat && o.world[1] === 0) return 1;
  return 2;
}

// A line cut where it passes behind the near plane; null when it is wholly behind. A line drawn
// with one end behind the eye would be projected through the eye and smeared across the screen.
function clipLine(a, b) {
  const ina = a[2] <= CLIP_Z, inb = b[2] <= CLIP_Z;
  if (ina && inb) return [a, b];
  if (!ina && !inb) return null;
  const t = (CLIP_Z - a[2]) / (b[2] - a[2]), m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, CLIP_Z];
  return ina ? [a, m] : [m, b];
}

// Splits a triangle along its longest edge until no edge is longer than maxLen.
function subdivide(tri, maxLen, out = []) {
  const [a, b, c] = tri, d = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const ab = d(a, b), bc = d(b, c), ca = d(c, a), m = Math.max(ab, bc, ca);
  if (m <= maxLen * maxLen || out.length > 20000) { out.push(tri); return out; }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  if (m === ab) { const k = mid(a, b); subdivide([a, k, c], maxLen, out); subdivide([k, b, c], maxLen, out); }
  else if (m === bc) { const k = mid(b, c); subdivide([a, b, k], maxLen, out); subdivide([a, k, c], maxLen, out); }
  else { const k = mid(c, a); subdivide([a, b, k], maxLen, out); subdivide([k, b, c], maxLen, out); }
  return out;
}

export class GPUView {
  constructor(canvas) {
    this.canvas = canvas;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true, stencil: true });
    r.outputColorSpace = THREE.LinearSRGBColorSpace;   // palette values go to the screen unchanged
    r.autoClear = false;
    r.setPixelRatio(window.devicePixelRatio || 1);

    // background: the game's own frame
    this.bgData = new Uint8Array(W * H * 4);
    this.bgTexture = new THREE.DataTexture(this.bgData, W, H, THREE.RGBAFormat);
    this.bgTexture.flipY = true;
    this.bgTexture.colorSpace = THREE.NoColorSpace;
    this.bgTexture.magFilter = THREE.NearestFilter;
    this.bgScene = new THREE.Scene();
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.bgTexture, transparent: true, depthTest: false, depthWrite: false })));
    // sky and ground, in 320 x 200 screen coordinates
    this.skyScene = new THREE.Scene();
    this.skyCamera = new THREE.OrthographicCamera(0, W, 0, H, -1, 1);
    this.skyCamera.near = NEAR; this.skyCamera.far = FAR;
    this.bgCamera = new THREE.Camera();
    this.bgCamera.near = NEAR; this.bgCamera.far = FAR;          // read by the logarithmic depth buffer

    // one scene per layer (see layerOf), rebuilt for each window every frame
    this.layers = [new THREE.Scene(), new THREE.Scene(), new THREE.Scene()];
    this.camera = new THREE.Camera();
    this.camera.near = NEAR; this.camera.far = FAR;
    this.materials = {
      front: withSurfaceDetail(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })),   // see winding note in build()
      both: withSurfaceDetail(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })),
      glass: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false }),
      // Enhanced: see-through polygons that are not a rotor (cockpit glass)
      canopy: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.7, depthWrite: false }),
      line: new LineMaterial({ vertexColors: true, linewidth: 2, worldUnits: false }),   // width in pixels, set in resize()
      dot: new THREE.PointsMaterial({ vertexColors: true, size: 2, sizeAttenuation: false }),
    };
    this.decals = new Map();
    // Enhanced mode: everything that goes beyond the game's own look lives behind this switch
    this.enhanced = false;
    this.lastGround = null;
    this.photoSky = new PhotoSky(this.skyScene);
    this.terrain = new Terrain(this.renderer);
    this.props = new Props(this.renderer);
    this.theatre = null;                // set by the page: 'gulf', 'asia', 'europe'
    this.sphere = new THREE.IcosahedronGeometry(1, 1).getAttribute('position').array;
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w && h && (w !== this.width || h !== this.height)) {
      this.width = w; this.height = h;
      this.renderer.setSize(w, h, false);
      // lines and dots as thick as the game's one-pixel lines at this size
      const dpr = this.renderer.getPixelRatio(), gamePixel = w * dpr / W;
      this.materials.line.linewidth = Math.max(1, gamePixel * 0.8);
      this.materials.line.resolution.set(w * dpr, h * dpr);
      this.materials.dot.size = Math.max(1, gamePixel);
    }
  }

  // projection reproducing screen x = cx + focus * X / Z, screen y = cy - (15/16) * focus * Y / Z
  // for camera-space points mapped to three.js view space as (X, Y, -Z)
  project(cx, cy, focus) {
    const kx = focus, ky = focus * 15 / 16;
    const a = -(FAR + NEAR) / (FAR - NEAR), b = -2 * FAR * NEAR / (FAR - NEAR);
    const m = this.camera.projectionMatrix;
    m.set(2 * kx / W, 0, -(2 * cx / W - 1), 0,
          0, 2 * ky / H, -(1 - 2 * cy / H), 0,
          0, 0, a, b,
          0, 0, -1, 0);
    this.camera.projectionMatrixInverse.copy(m).invert();
  }

  // Loads what Enhanced mode needs for a theatre. The game reads its theatre file when a tour is
  // chosen, many seconds before the first 3D frame, so the loading is done by then.
  prepare(theatre) {
    if (!this.enhanced || !theatre || this.prepared === theatre) return;
    this.prepared = theatre;
    this.terrain.get(theatre);
    this.props.preload();
  }

  // views: [{ view: window and projection centre, objects, horizon }]
  draw(frameRGBA, views, palette) {
    this.resize();
    const r = this.renderer;
    if (frameRGBA) { this.bgData.set(frameRGBA); this.bgTexture.needsUpdate = true; }
    r.setScissorTest(false);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    const sx = this.width / W, sy = this.height / H;
    for (const v of views) {
      const { x0, x1, y0, y1 } = v.view;
      r.setScissorTest(true);
      r.setScissor(x0 * sx, (H - y1) * sy, (x1 - x0) * sx, (y1 - y0) * sy);
      r.clear(true, true, false);
      const focus = v.objects.length ? v.objects[0].focus : 128;
      // instruments (the attitude ball) have no models and keep the game's look
      const scenic = this.enhanced && v.horizon?.camera && (v.objects.length > 0 || x1 - x0 === W);
      let objects = v.objects, relief = null, props = false;
      this.project(v.view.cx, v.view.cy, focus);
      if (scenic) {
        const land = this.terrain.get(this.theatre);
        if (land && v.horizon.camera.position) relief = new Relief(land, v.horizon.camera);
        // the terrain carries the game's hills as mounds (see hillMounds)
        if (relief) objects = objects.filter((o) => !HILLS.has(o.name));
        const night = this.photoSky.draw(v, focus, palette, this, relief !== null);
        if (night) objects = objects.filter((o) => o.name !== 'stars');   // the photo has real stars
        r.render(this.skyScene, this.skyCamera);
        const tint = this.photoSky.daylight;
        if (relief) {
          this.terrain.place(land, relief, tint, this.photoSky.haze);
          r.render(this.terrain.scene, this.camera);
        }
        if (v.horizon.camera.position) {
          props = true;
          this.props.begin(relief ?? new Relief(null, v.horizon.camera), tint, this.photoSky.haze);
          objects = objects.filter((o) => !this.props.add(o));
        }
      } else if (v.horizon) { this.buildSky(v.view, v.horizon, palette); r.render(this.skyScene, this.skyCamera); }
      const lists = this.layers.map(() => []);
      for (const o of objects) lists[layerOf(o)].push(o);
      // over terrain everything shares one depth buffer: hills hide what is behind them
      // Enhanced: a fainter rotor blur under the spinning blades; faces drawn from both sides, so the
      // game's open low-poly models (built for its back-face culling) look solid from any angle
      this.materials.glass.opacity = relief ? 0.2 : 0.5;
      const side = relief ? THREE.DoubleSide : THREE.BackSide;
      if (this.materials.front.side !== side) { this.materials.front.side = side; this.materials.front.needsUpdate = true; }
      this.frameTime = v.time;
      this.layers.forEach((scene, i) => this.build(lists[i], palette, scene, relief, props ? this.props : null));
      this.layers.forEach((scene, i) => {
        if (!relief) r.clearDepth();
        // replacements: runways under the ground markings (shadows), models with the models
        if (props && i === 1) r.render(this.props.ground, this.camera);
        r.render(scene, this.camera);
        if (props && i === 1) { r.clearStencil(); r.render(this.props.shadows, this.camera); }
        if (props && i === 2) r.render(this.props.scene, this.camera);
      });
    }
    r.setScissorTest(false);
    r.render(this.bgScene, this.bgCamera);
  }

  // The window in the far colour, then the near side of the horizon line in the other colour.
  buildSky(view, hz, palette) {
    const rgb = (c) => new THREE.Color(palette[c * 3] / 63, palette[c * 3 + 1] / 63, palette[c * 3 + 2] / 63);
    const rect = [[view.x0, view.y0], [view.x1, view.y0], [view.x1, view.y1], [view.x0, view.y1]];
    const polys = [[rect, hz.colors[hz.colors.length - 1]]];
    if (hz.colors.length === 2) {
      const [px, py] = hz.point, [nx, ny] = hz.normal, side = (q) => (q[0] - px) * nx + (q[1] - py) * ny;
      const out = [];
      for (let i = 0; i < 4; i++) {
        const a = rect[i], b = rect[(i + 1) % 4], sa = side(a), sb = side(b);
        if (sa >= 0) out.push(a);
        if ((sa >= 0) !== (sb >= 0)) { const t = sa / (sa - sb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      if (out.length >= 3) polys.push([out, hz.colors[0]]);
    }
    for (const m of this.skyScene.children) if (!m.userData.keep) { m.geometry.dispose(); m.material.dispose(); }
    this.skyScene.clear();
    for (const [poly, c] of polys) {
      const pos = [];
      for (let i = 1; i < poly.length - 1; i++) pos.push(...poly[0], 0, ...poly[i], 0, ...poly[i + 1], 0);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: rgb(c), side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      mesh.frustumCulled = false;
      this.skyScene.add(mesh);
    }
  }

  // Coplanar detail polygons (windows, markings, runway numbers) are painted over their base
  // face by the game. Here, within each group of coplanar polygons, smaller polygons are lifted
  // further toward the eye: rank 0 for the largest, one step more for each smaller one. Moving a
  // point toward the eye along its line of sight leaves its screen position unchanged, so only the
  // depth order changes. Coplanarity is affine-invariant, so this is computed once per level of detail.
  // The game's fixed-point transform leaves each vertex a few units off, so polygons of a group are
  // also snapped onto the plane of the group's largest polygon (base) before lifting.
  decalLevels(o) {
    const key = `${o.name}:${o.prims.length}:${o.pts.length}`;
    if (this.decals.has(key)) return this.decals.get(key);
    const P = o.pts;
    let reach = 1;
    for (let i = 0; i < P.length; i++) reach = Math.max(reach, Math.abs(P[i]));
    const info = o.prims.map((p, k) => {
      if (p.kind !== 0 || p.idx.length < 3) return null;
      const v = p.idx.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      const n = [0, 0, 0];
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const len = Math.hypot(...n);
      if (len < 1e-6) return null;
      const u = n.map((x) => x / len);
      return { k, n: u, d: u[0] * v[0][0] + u[1] * v[0][1] + u[2] * v[0][2], area: len / 2 };
    }).filter(Boolean);
    const groups = [];
    for (const a of info) {
      const g = groups.find((g) => {
        const b = g[0];
        return a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2] > 0.995 && Math.abs(a.d - b.d) < 2 + 2e-3 * reach;
      });
      if (g) g.push(a); else groups.push([a]);
    }
    const levels = new Array(o.prims.length).fill(0), base = new Array(o.prims.length).fill(-1);
    for (const g of groups) {
      g.sort((a, b) => b.area - a.area);
      g.forEach((a, rank) => { levels[a.k] = rank; if (g.length > 1) base[a.k] = g[0].k; });
    }
    // A vertex shared by faces of different groups stays where the game put it: snapping it would
    // open a crack along the edge between them. Only vertices of detail polygons alone move.
    const groupOf = new Map(), pinned = new Set();
    groups.forEach((g, gi) => { for (const a of g) for (const i of o.prims[a.k].idx) {
      if (groupOf.has(i) && groupOf.get(i) !== gi) pinned.add(i); else groupOf.set(i, gi);
    } });
    const result = { levels, base, pinned, rotors: rotorDiscs(o) };
    this.decals.set(key, result);
    return result;
  }

  // Rotor blades for one rotor disc (see rotorDiscs): four dark blades from the hub to the rim,
  // turning in the disc's plane; the main rotor about 3 turns a second (seen at 60 frames a second
  // that reads as rotation, faster would strobe), the tail rotor twice as fast.
  blades(rotor, at, pos, col, det) {
    const hub = at(rotor.hub), rim = rotor.rim.map(at);
    let r = 0;
    for (const q of rim) r = Math.max(r, Math.hypot(q[0] - hub[0], q[1] - hub[1], q[2] - hub[2]));
    if (r < 1) return;
    // disc normal: from two rim points, perpendicular to the hub
    const n = [0, 0, 0];
    for (let i = 0; i < rim.length; i++) {
      const a = rim[i], b = rim[(i + 1) % rim.length];
      const u = [a[0] - hub[0], a[1] - hub[1], a[2] - hub[2]], w = [b[0] - hub[0], b[1] - hub[1], b[2] - hub[2]];
      const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const sgn = c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0 ? -1 : 1;
      n[0] += sgn * c[0]; n[1] += sgn * c[1]; n[2] += sgn * c[2];
    }
    const nl = Math.hypot(...n);
    if (nl < 1e-6) return;
    const N = n.map((x) => x / nl);
    const e1 = rim.length ? [rim[0][0] - hub[0], rim[0][1] - hub[1], rim[0][2] - hub[2]] : [1, 0, 0];
    const d1 = e1[0] * N[0] + e1[1] * N[1] + e1[2] * N[2];
    const E1 = e1.map((x, i) => x - d1 * N[i]), l1 = Math.hypot(...E1), A = E1.map((x) => x / l1);
    const B = [N[1] * A[2] - N[2] * A[1], N[2] * A[0] - N[0] * A[2], N[0] * A[1] - N[1] * A[0]];
    const speed = rotor.main ? 3.1 : 6.2, turn = (this.frameTime || 0) * speed * 2 * Math.PI;
    const width = r * (rotor.main ? 0.045 : 0.09), dark = [0.12, 0.12, 0.11];
    for (let k = 0; k < 4; k++) {
      const t = turn + k * Math.PI / 2, d = [0, 1, 2].map((i) => Math.cos(t) * A[i] + Math.sin(t) * B[i]);
      const s = [0, 1, 2].map((i) => -Math.sin(t) * A[i] + Math.cos(t) * B[i]);
      const p = (along, side) => [0, 1, 2].map((i) => hub[i] + d[i] * along + s[i] * side);
      const q = [p(r * 0.06, -width / 2), p(r, -width / 2), p(r, width / 2), p(r * 0.06, width / 2)];
      pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
      for (let j = 0; j < 6; j++) { col.push(...dark); det.push(0, 0, 0, 0); }
    }
  }

  // relief (Enhanced mode, theatre terrain loaded): see Relief
  build(objects, palette, scene, relief = null, props = null) {
    const buf = { front: [], both: [], glass: [], canopy: [], line: [], dot: [] };
    const det = { front: [], both: [] };   // Enhanced: surface detail per vertex (see withSurfaceDetail)
    const col = { front: [], both: [], glass: [], canopy: [], line: [], dot: [] };
    const shadow = [];                  // Enhanced: flattened faces of vehicles on the ground
    const rgb = (c) => [palette[c * 3] / 63, palette[c * 3 + 1] / 63, palette[c * 3 + 2] / 63];
    for (const o of objects) {
      const P = o.pts, { levels, base, pinned, rotors } = this.decalLevels(o);
      const mode = relief ? relief.mode(o) : null, drape = mode === 'drape';
      // Enhanced: models lit by sun and sky; vehicles standing on the ground cast shadows
      const lit = mode === 'rigid';
      const paint = lit && (AIRCRAFT.has(o.name) || VEHICLES.has(o.name));    // service colours rather than the palette's bright ones
      const kind = !lit ? 0 : AIRCRAFT.has(o.name) ? 1 : VEHICLES.has(o.name) ? 2 : 0;
      const local = kind ? relief.localFrame(o) : null;
      const flat = lit && props && relief.casts(o) ? relief.flattener(o) : null;
      const shift = mode === 'rigid' ? relief.offset(o) : [0, 0, 0], f = o.unit * (mode === 'sky' ? SKY_DISTANCE : 1);
      // three.js view space in half-feet: (X, Y, -Z) times the model's unit
      const at = (i) => [P[i * 3] * f + shift[0], P[i * 3 + 1] * f + shift[1], -P[i * 3 + 2] * f + shift[2]];
      // moved toward the eye by a fraction of the distance: same place on screen, nearer in depth
      const toward = (q, lift) => [q[0] * (1 - lift), q[1] * (1 - lift), q[2] * (1 - lift)];
      const ground = (q, lift = 0) => toward(drape ? relief.drape(q) : q, lift + (drape ? TERRAIN_LIFT : 0));
      const planes = new Map();
      const planeOf = (b) => {
        if (planes.has(b)) return planes.get(b);
        const v = o.prims[b].idx.map((i) => at(i));
        const n = [0, 0, 0];
        for (let i = 0; i < v.length; i++) {
          const a = v[i], c = v[(i + 1) % v.length];
          n[0] += (a[1] - c[1]) * (a[2] + c[2]); n[1] += (a[2] - c[2]) * (a[0] + c[0]); n[2] += (a[0] - c[0]) * (a[1] + c[1]);
        }
        const len = Math.hypot(...n) || 1, u = n.map((x) => x / len);
        const d = v.reduce((acc, q) => acc + u[0] * q[0] + u[1] * q[1] + u[2] * q[2], 0) / v.length;
        const plane = { u, d };
        planes.set(b, plane);
        return plane;
      };
      o.prims.forEach((p, k) => {
        const c = rgb(p.color);
        if (p.kind === 0) {
          // The game's one-sided faces are clockwise on screen when visible; after mapping camera
          // space to three.js view space they are three.js back faces, hence side: BackSide.
          const rotorPoly = p.stipple && rotors.some((r) => p.idx.includes(r.hub));
          const target = p.stipple ? (lit && !rotorPoly ? 'canopy' : 'glass') : p.double ? 'both' : 'front';
          let v = p.idx.map((i) => at(i));
          if (base[k] >= 0) {
            const { u, d } = planeOf(base[k]);
            v = v.map((q, j) => {
              if (pinned.has(p.idx[j])) return q;
              const e = u[0] * q[0] + u[1] * q[1] + u[2] * q[2] - d;
              return [q[0] - e * u[0], q[1] - e * u[1], q[2] - e * u[2]];
            });
          }
          const lift = levels[k] * DECAL_LIFT;
          v = clipNear(drape ? v : v.map((q) => toward(q, lift)));
          if (v.length < 3) return;
          for (let j = 1; j < v.length - 1; j++) {
            const tris = drape ? subdivide([v[0], v[j], v[j + 1]], DRAPE_STEP) : [[v[0], v[j], v[j + 1]]];
            const shade = lit && target !== 'glass' && target !== 'canopy' ? relief.shade(v) : 1;
            const base = paint ? militaryPaint(c) : c;
            const cs = shade === 1 ? base : base.map((x) => Math.min(1, x * shade));
            for (const t of tris) {
              for (const q of t) {
                buf[target].push(...(drape ? ground(q, lift) : q));
                if (det[target]) det[target].push(...(local ? local(q) : [0, 0, 0]), local ? kind : 0);
              }
              col[target].push(...cs, ...cs, ...cs);
              if (flat && target !== 'glass' && target !== 'canopy') for (const q of t) shadow.push(...flat(q));
            }
          }
        } else if (p.kind === 1) {
          // lines usually lie on a face (window frames, road edges): keep them just in front
          const cut = clipLine(at(p.idx[0]), at(p.idx[1]));
          if (!cut) return;
          const [a, b] = cut;
          const n = drape ? Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / DRAPE_STEP)) : 1;
          for (let j = 0; j < n; j++) {
            const q0 = a.map((x, m) => x + (b[m] - x) * j / n), q1 = a.map((x, m) => x + (b[m] - x) * (j + 1) / n);
            buf.line.push(...ground(q0, LINE_LIFT), ...ground(q1, LINE_LIFT)); col.line.push(...c, ...c);
          }
        } else if (p.kind === 2) {
          buf.dot.push(...ground(at(p.idx[0]))); col.dot.push(...c);
        } else if (p.kind === 3) {
          const [x, y, z] = ground(at(p.idx[0])), rad = p.radius * o.scale * o.unit, s = this.sphere;
          if (rad === 0) { buf.dot.push(x, y, z); col.dot.push(...c); return; }
          for (let j = 0; j < s.length; j += 3) {
            buf.both.push(x + s[j] * rad, y + s[j + 1] * rad * 0.86, z + s[j + 2] * rad);
            col.both.push(...c);
            det.both.push(0, 0, 0, 0);
          }
        }
      });
      // Enhanced: spinning blades over each rotor's blur disc
      if (lit && rotors.length && HELICOPTERS.has(o.name)) {
        for (const rotor of rotors) this.blades(rotor, at, buf.both, col.both, det.both);
      }
    }
    if (scene.userData.geometry) for (const g of scene.userData.geometry) g.dispose();
    scene.clear();
    const add = (kind, Ctor) => {
      if (!buf[kind].length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buf[kind], 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col[kind], 3));
      if (det[kind]) g.setAttribute('detail', new THREE.Float32BufferAttribute(det[kind], 4));
      const obj = new Ctor(g, this.materials[kind]);
      obj.frustumCulled = false;
      scene.add(obj);
    };
    add('front', THREE.Mesh); add('both', THREE.Mesh); add('glass', THREE.Mesh); add('canopy', THREE.Mesh); add('dot', THREE.Points);
    if (buf.line.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(buf.line); g.setColors(col.line);
      const lines = new LineSegments2(g, this.materials.line);
      lines.frustumCulled = false;
      scene.add(lines);
    }
    scene.userData.geometry = scene.children.map((m) => m.geometry);
    if (props && shadow.length) props.addFlatShadow(shadow);
  }
}

// ---------------------------------------------------------------------------------- Enhanced mode

const TURN = 2 * Math.PI / 2880;        // the game's angle unit
const Y_SCALE = 0.868;                  // the game's camera space squeezes Y by this (measured)
const SKY_EXPOSURE = 0.78;              // the photo skies are exposed for a bright display; under them the land looked dark

// World-to-camera rotation from the game's camera angles: Rz(roll) * Rx(pitch) * Ry(heading),
// world axes east, up, north (measured against captured objects).
export function cameraRotation({ heading, pitch, roll }) {
  const [a, b, c] = [heading * TURN, pitch * TURN, roll * TURN];
  const Ry = new THREE.Matrix3().set(Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a));
  const Rx = new THREE.Matrix3().set(1, 0, 0, 0, Math.cos(b), -Math.sin(b), 0, Math.sin(b), Math.cos(b));
  const Rz = new THREE.Matrix3().set(Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1);
  return Rz.multiply(Rx).multiply(Ry);
}

// World direction seen at a screen point (320 x 200 coordinates) of a view.
function worldDirection(R, cx, cy, focus, sx, sy) {
  const d = new THREE.Vector3((sx - cx) / focus, (cy - sy) / (focus * 15 / 16) / Y_SCALE, 1);
  return d.applyMatrix3(R.clone().transpose()).normalize();
}

// A photo sky (equirectangular panorama) above the true horizon and the game's ground colour
// below it, for every pixel of the window.
class PhotoSky {
  constructor(scene) {
    const loader = new THREE.TextureLoader();
    const load = (url) => {
      const t = loader.load(url);
      t.colorSpace = THREE.NoColorSpace;    // JPEG values go to the screen unchanged
      t.wrapS = THREE.RepeatWrapping;
      return t;
    };
    this.day = load('assets/sky/day.jpg');
    this.night = load('assets/sky/night.jpg');
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        sky: { value: this.day }, toWorld: { value: new THREE.Matrix3() },
        centre: { value: new THREE.Vector2() }, focus: { value: 128 }, resolution: { value: new THREE.Vector2() },
        ground: { value: new THREE.Color() }, haze: { value: new THREE.Color() },
      },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D sky; uniform mat3 toWorld; uniform vec2 centre; uniform float focus;
        uniform vec2 resolution; uniform vec3 ground; uniform vec3 haze;
        void main() {
          // the game's projection, inverted: screen point -> camera direction -> world direction
          vec2 s = vec2(gl_FragCoord.x / resolution.x * 320.0, (1.0 - gl_FragCoord.y / resolution.y) * 200.0);
          vec3 cam = vec3((s.x - centre.x) / focus, (centre.y - s.y) / (focus * 0.9375) / ${Y_SCALE.toFixed(3)}, 1.0);
          vec3 d = normalize(toWorld * cam);
          float elevation = asin(clamp(d.y, -1.0, 1.0));
          if (elevation < 0.0) {
            // ground: the game's colour, fading into haze toward the horizon
            gl_FragColor = vec4(mix(ground, haze, exp(elevation * 40.0) * 0.35), 1.0);
            return;
          }
          float azimuth = atan(d.x, d.z);
          vec2 uv = vec2(0.5 + azimuth / 6.2831853, 0.5 + elevation / 3.1415927);
          gl_FragColor = vec4(texture2D(sky, uv).rgb * ${SKY_EXPOSURE.toFixed(2)}, 1.0);
        }`,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, W, 0, 0, W, H, 0, 0, 0, 0, W, H, 0, 0, H, 0], 3));
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.userData.keep = true;
    this.scene = scene;
  }

  // Sets up the sky for one view; returns true when it is night.
  draw(v, focus, palette, gpu, terrain = false) {
    const { cx, cy } = v.view, hz = v.horizon;
    const R = cameraRotation(hz.camera);
    const rgb = (c) => new THREE.Color(palette[c * 3] / 63, palette[c * 3 + 1] / 63, palette[c * 3 + 2] / 63);
    // which of the game's colours is the ground: the one on the side whose direction looks down
    const below = (sx, sy) => worldDirection(R, cx, cy, focus, sx, sy).y < 0;
    let ground = gpu.lastGround, sky = null;
    if (hz.colors.length === 2) {
      const [px, py] = hz.point, [nx, ny] = hz.normal;
      const posBelow = below(px + nx * 12, py + ny * 12);
      ground = hz.colors[posBelow ? 0 : 1]; sky = hz.colors[posBelow ? 1 : 0];
    } else if (below((v.view.x0 + v.view.x1) / 2, (v.view.y0 + v.view.y1) / 2)) ground = hz.colors[0];
    else sky = hz.colors[0];
    // the game's own colour table, when known: the fill above works only on what is in view, and a
    // camera looking straight down sees no sky at all
    if (hz.sky !== undefined) { ground = hz.ground; sky = hz.sky; }
    if (ground !== null) gpu.lastGround = ground;
    if (sky !== null) this.lastSky = sky;
    const skyRGB = rgb(this.lastSky ?? 0);
    const night = skyRGB.r + skyRGB.g + skyRGB.b < 0.45;
    // light on the ground, from the game's sky colour: 1 under a day sky, low at dusk, lowest at night
    const skyLum = 0.3 * skyRGB.r + 0.59 * skyRGB.g + 0.11 * skyRGB.b;
    this.daylight = Math.min(1, 0.12 + skyLum * 1.6);
    const u = this.material.uniforms;
    u.sky.value = night ? this.night : this.day;
    u.toWorld.value.copy(R).transpose();
    u.centre.value.set(cx, cy); u.focus.value = focus;
    gpu.renderer.getDrawingBufferSize(u.resolution.value);
    this.haze = night ? new THREE.Color(0.05, 0.06, 0.09) : new THREE.Color(0.64, 0.69, 0.75);
    u.haze.value.copy(this.haze);
    // with terrain, only the band beyond its far edge shows: haze, as the terrain fades into
    u.ground.value.copy(terrain ? this.haze : rgb(ground ?? 0));
    for (const m of this.scene.children) if (!m.userData.keep) { m.geometry.dispose(); m.material.dispose(); }
    this.scene.clear();
    this.scene.add(this.mesh);
    return night;
  }
}

// ---------------------------------------------------------------------------- Enhanced mode: terrain

// Theatre terrain built by tools/terrain.py from satellite imagery and elevation data: a detailed
// grid over the play area and a coarse one around it, both in game coordinates.
const TERRAIN_DATA = 'assets/terrain/';
const HAZE_DENSITY = 4e-6;              // exponential-squared haze per half-foot
const SUN = new THREE.Vector3(-1, 1.1, 1).normalize();   // from the north-west, about 38 degrees up: relief shading, model light and shadows

// A height grid and its mesh. Vertices sit on every `step`-th sample; heights between vertices
// follow the mesh's own triangles, so draped ground markings lie exactly on the drawn surface.
class TerrainGrid {
  constructor(info, samples, texture, step, hole = null) {
    const [x0, x1, z0, z1] = this.bounds = info.bounds;
    const N = this.N = info.heights, n = this.n = Math.floor((N - 1) / step) + 1;
    this.step = step;
    const h = this.h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = samples[j * step * N + i * step];
    const X = (i) => x0 + (i * step + 0.5) / N * (x1 - x0), Z = (j) => z1 - (j * step + 0.5) / N * (z1 - z0);
    const cell = (x1 - x0) / N * step;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), shade = new Float32Array(n * n * 3);
    const drop = hole ? 4 : 0;          // the coarse grid sits just below the detailed one where they overlap
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, x = X(i), z = Z(j);
      pos.set([x, h[k] - drop, z], k * 3);
      uv.set([(x - x0) / (x1 - x0), (z - z0) / (z1 - z0)], k * 2);
      // slope toward east and north; shading 1 on flat ground
      const dx = (h[j * n + Math.min(i + 1, n - 1)] - h[j * n + Math.max(i - 1, 0)]) / (2 * cell);
      const dz = (h[Math.max(j - 1, 0) * n + i] - h[Math.min(j + 1, n - 1) * n + i]) / (2 * cell);
      const len = Math.hypot(dx, 1, dz);
      const lit = (-dx * SUN.x + SUN.y - dz * SUN.z) / len;
      const v = Math.min(1.25, Math.max(0.55, 1 + 0.9 * (lit - SUN.y)));
      shade.set([v, v, v], k * 3);
    }
    const inHole = (i, j) => hole && X(i) > hole[0] + cell && X(i) < hole[1] - cell && Z(j) > hole[2] + cell && Z(j) < hole[3] - cell;
    const index = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      if (inHole(i, j) && inHole(i + 1, j + 1)) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, c, b, b, c, d);     // split along b-c, as heightAt assumes
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(shade, 3));
    g.setIndex(index);
    this.material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
  }

  // height of the drawn surface at a world point, or null outside the grid
  heightAt(x, z) {
    const [x0, x1, z0, z1] = this.bounds, N = this.N, n = this.n;
    const gx = ((x - x0) / (x1 - x0) * N - 0.5) / this.step, gz = ((z1 - z) / (z1 - z0) * N - 0.5) / this.step;
    if (!(gx >= 0 && gz >= 0 && gx <= n - 1 && gz <= n - 1)) return null;
    const i = Math.min(Math.floor(gx), n - 2), j = Math.min(Math.floor(gz), n - 2), fx = gx - i, fz = gz - j;
    const h = this.h, a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }
}

const HILLS = new Set(['hill1', 'hill2', 'hill3', 'hill4', 'mountain']);
const inside = ([x0, x1, z0, z1], p) => p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1;

// The game's hills and mountains as smooth mounds of the terrain itself: one mesh per grid, textured
// and shaded like it. Each mound sits on the real ground, has the game hill's centre, heading and
// height, and spreads 5% past its footprint with a soft foot. Its profile is a bell with a rounded
// top: 90% of the game hill's height, falling as exp(-(r / 0.35)^2) to nothing at the edge of that
// wider footprint. It stays under the game's pyramid everywhere (within a hundredth of a unit), so
// nothing the game keeps clear of its hill ends up inside the mound. The foot starts a unit under
// the ground.
const HILL_RINGS = 14, HILL_SEGMENTS = 36;
const BELL_EDGE = Math.exp(-((1 / 0.35) ** 2));
const bell = (r) => 0.9 * (Math.exp(-((r / 0.35) ** 2)) - BELL_EDGE) / (1 - BELL_EDGE);
function hillMounds(hills, grid, grids) {
  if (!hills.length) return null;
  const [x0, x1, z0, z1] = grid.bounds;
  const ground = (x, z) => { for (const g of grids) { const h = g.heightAt(x, z); if (h !== null) return h; } return 0; };
  const pos = [], uv = [], index = [];
  for (const hill of hills) {
    const first = pos.length / 3;
    const a = hill.heading_deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const rx = hill.w / 2 * 1.05, rz = hill.l / 2 * 1.05;
    for (let i = 0; i <= HILL_RINGS; i++) {
      const r = i / HILL_RINGS, n = i === 0 ? 1 : HILL_SEGMENTS;
      for (let j = 0; j < n; j++) {
        const t = j / HILL_SEGMENTS * 2 * Math.PI, lx = Math.cos(t) * r * rx, lz = Math.sin(t) * r * rz;
        const x = hill.x + c * lx - s * lz, z = hill.z + s * lx + c * lz;
        pos.push(x, ground(x, z) + hill.h * bell(r) - 1, z);
        uv.push((x - x0) / (x1 - x0), (z - z0) / (z1 - z0));
      }
    }
    const ring = (i, j) => first + (i === 0 ? 0 : 1 + (i - 1) * HILL_SEGMENTS + (j % HILL_SEGMENTS));
    for (let j = 0; j < HILL_SEGMENTS; j++) index.push(ring(0, 0), ring(1, j), ring(1, j + 1));
    for (let i = 1; i < HILL_RINGS; i++) for (let j = 0; j < HILL_SEGMENTS; j++) {
      index.push(ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j), ring(i + 1, j + 1), ring(i, j + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  // the terrain's relief shading: 1 on flat ground, lighter toward the sun
  const nrm = g.getAttribute('normal'), shade = new Float32Array(nrm.count * 3);
  for (let k = 0; k < nrm.count; k++) {
    let nx = nrm.getX(k), ny = nrm.getY(k), nz = nrm.getZ(k);
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const v = Math.min(1.25, Math.max(0.55, 1 + 0.9 * (nx * SUN.x + ny * SUN.y + nz * SUN.z - SUN.y)));
    shade.set([v, v, v], k * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  const mesh = new THREE.Mesh(g, grid.material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  return mesh;
}

class Terrain {
  constructor(renderer) {
    this.renderer = renderer;
    this.theatres = new Map();          // name -> { ready, grids, meta } or { failed }
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xffffff, HAZE_DENSITY);
  }

  // the theatre's terrain when loaded; starts loading it the first time
  get(name) {
    if (!name) return null;
    let t = this.theatres.get(name);
    if (!t) { t = {}; this.theatres.set(name, t); this.load(name, t).catch((e) => { t.failed = true; console.info(`no terrain for ${name}: ${e.message}`); }); }
    return t.ready ? t : null;
  }

  async load(name, t) {
    const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r; };
    const meta = await (await get(`${TERRAIN_DATA}${name}.json`)).json();
    const grid = async (label, step, hole) => {
      const samples = new Int16Array(await (await get(`${TERRAIN_DATA}${name}_${label}.i16`)).arrayBuffer());
      const texture = await new THREE.TextureLoader().loadAsync(`${TERRAIN_DATA}${name}_${label}.jpg`);
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      return new TerrainGrid(meta[label], samples, texture, step, hole);
    };
    const near = await grid('near', 2), far = await grid('far', 2, meta.near.bounds);
    // upload now: a 6144-pixel texture takes a quarter of a second, better spent before the 3D starts
    for (const g of [near, far]) this.renderer.initTexture(g.material.map);
    const mounds = [near, far].map((g, i) => hillMounds((meta.hills ?? []).filter((h) => (inside(meta.near.bounds, h) ? 0 : 1) === i), g, [near, far]));
    Object.assign(t, { meta, grids: [near, far], mounds: mounds.filter(Boolean), ready: true });
  }

  // Places the terrain for one view: world -> three.js view space with the camera raised by the
  // terrain under it. Darkened with the game's ground colour (night) and hazed with distance.
  place(t, relief, tint, haze) {
    const m = viewMatrix(relief.e, relief.cam, relief.base);
    this.scene.clear();
    for (const g of t.grids) {
      g.mesh.matrix.copy(m);
      g.mesh.matrixWorldNeedsUpdate = true;
      g.material.color.setScalar(tint);
      this.scene.add(g.mesh);
    }
    for (const mesh of t.mounds) {
      mesh.matrix.copy(m);
      mesh.matrixWorldNeedsUpdate = true;
      this.scene.add(mesh);
    }
    this.scene.fog.color.copy(haze);
  }
}

// World (game half-feet, camera raised by `base`) -> three.js view space, for a camera rotation
// (column-major elements) and world position.
function viewMatrix(e, [cx, cy, cz], base = 0) {
  const ey = cy + base;
  const rows = [[e[0], e[3], e[6]], [e[1] * Y_SCALE, e[4] * Y_SCALE, e[7] * Y_SCALE], [-e[2], -e[5], -e[8]]];
  return new THREE.Matrix4().set(
    ...rows[0], -(rows[0][0] * cx + rows[0][1] * ey + rows[0][2] * cz),
    ...rows[1], -(rows[1][0] * cx + rows[1][1] * ey + rows[1][2] * cz),
    ...rows[2], -(rows[2][0] * cx + rows[2][1] * ey + rows[2][2] * cz),
    0, 0, 0, 1);
}

// The game paints its aircraft and vehicles in bright palette colours (a lime-green Apache); Enhanced
// mode tones them toward service paint: a third of the saturation, darker, and warmed (greens become olive drab).
// Near-black paint (the Black Hawk) is lifted to a dark olive grey, so light, shade and panel lines
// still show on it.
function militaryPaint([r, g, b]) {
  const l = 0.3 * r + 0.59 * g + 0.11 * b, warm = [0.05, 0.03, -0.03], floor = [0.13, 0.14, 0.11];
  return [r, g, b].map((x, i) => Math.max(floor[i], (l + (x - l) * 0.35) * 0.75 + warm[i]));
}

// The game draws a turning rotor as a fan of see-through sectors around the hub vertex. Each hub is
// a vertex shared by three or more see-through polygons; the rotor with the most sectors is the main
// one. Returns [{ hub, rim: [vertex indices], main }].
function rotorDiscs(o) {
  const glass = o.prims.filter((p) => p.kind === 0 && p.stipple);
  const count = new Map();
  for (const p of glass) for (const i of new Set(p.idx)) count.set(i, (count.get(i) || 0) + 1);
  const hubs = [...count].filter(([, n]) => n >= 3).map(([i]) => i);
  const discs = hubs.map((hub) => {
    const polys = glass.filter((p) => p.idx.includes(hub));
    return { hub, rim: [...new Set(polys.flatMap((p) => p.idx))].filter((i) => i !== hub), sectors: polys.length };
  });
  const most = Math.max(0, ...discs.map((d) => d.sectors));
  return discs.map((d) => ({ hub: d.hub, rim: d.rim, main: d.sectors === most }));
}
const HELICOPTERS = new Set(['apache', 'black', 'lhx', 'osprey', 'hind', 'hip', 'havoc', 'hokum']);
const VEHICLES = new Set(['t80', 'm1', 'm2', 'm113', 'bmp2', 'brdm', 'btr70', 'zsu23', 'zsu57', 'sa6', 'sa8', 'sa11', 'sa13', 's60', 's23', 'truck', 'radar']);

// Generated surface detail for the game's models (Enhanced mode), drawn per pixel from each vertex's
// position in its model's own frame (attribute detail.xyz, half-feet; detail.w = 1 aircraft,
// 2 ground vehicle, 0 none). Faces are flat, so the face's direction comes from the screen-space
// derivatives of that position, and the pattern is projected along its main axis. Aircraft get
// panel lines and fine paint variation, vehicles two-tone camouflage; both some wear. Panel lines
// fade out once they would be thinner than a pixel apart.
function withSurfaceDetail(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 detail;\nvarying vec4 vDetail;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDetail = detail;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vDetail;
        float dHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float dNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
          return mix(mix(dHash(i), dHash(i + vec2(1, 0)), u.x), mix(dHash(i + vec2(0, 1)), dHash(i + vec2(1, 1)), u.x), u.y);
        }
        float surfaceDetail(vec4 d) {
          vec3 L = d.xyz, n = abs(normalize(cross(dFdx(L), dFdy(L))));
          vec2 uv = n.x > n.y && n.x > n.z ? L.zy : (n.y > n.z ? L.xz : L.xy);
          float k = (0.93 + 0.14 * dNoise(uv * 0.3)) * (0.97 + 0.06 * dNoise(uv * 1.7));
          if (d.w > 1.5) {
            float c = dNoise(uv * 0.05 + 7.3) + 0.5 * dNoise(uv * 0.13 + 2.1);
            k *= mix(1.0, 0.68, smoothstep(0.88, 0.95, c));
          } else {
            vec2 g = uv / vec2(9.0, 6.0), w = fwidth(g);
            vec2 line = 1.0 - smoothstep(vec2(0.0), w * 1.2, abs(fract(g - 0.5) - 0.5));
            k *= 1.0 - 0.2 * max(line.x, line.y) * clamp(1.0 - max(w.x, w.y) * 5.0, 0.0, 1.0);
          }
          return k;
        }`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (vDetail.w > 0.5) diffuseColor.rgb *= surfaceDetail(vDetail);');
  };
  material.customProgramCacheKey = () => 'surface-detail';
  return material;
}

// aircraft: the game draws their shadows itself (the "...sh" models)
const AIRCRAFT = new Set(['apache', 'black', 'lhx', 'osprey', 'hind', 'hip', 'havoc', 'hokum', 'b2', 'mig27', 'su25']);

// Enhanced-mode relief. The game's ground is flat at height 0 and its logic stays that way; on
// screen every point is raised by the terrain height under it, less the height under the camera,
// so the camera keeps the game's height above the ground and the hills rise around it. Models
// move up as a whole by the height under their origin; ground markings and the ground-dot field
// follow the terrain point by point.
class Relief {
  // terrain null: flat ground at height 0 (a theatre without terrain data)
  constructor(terrain, camera) {
    this.terrain = terrain;
    this.e = cameraRotation(camera).elements;     // world -> camera, column-major
    this.cam = camera.position;
    this.base = this.heightAt(this.cam[0], this.cam[2]);
    const e = this.e;
    this.up = [e[3], e[4] * Y_SCALE, -e[5]];       // world up in three.js view space
  }

  heightAt(x, z) {
    for (const g of this.terrain?.grids ?? []) { const h = g.heightAt(x, z); if (h !== null) return h; }
    return 0;
  }

  // view-space direction toward the sun, and world up
  get sunView() {
    if (!this._sun) {
      const e = this.e, L = SUN;
      const v = [e[0] * L.x + e[3] * L.y + e[6] * L.z, (e[1] * L.x + e[4] * L.y + e[7] * L.z) * Y_SCALE, -(e[2] * L.x + e[5] * L.y + e[8] * L.z)];
      const n = Math.hypot(...v);
      this._sun = v.map((x) => x / n);
      const u = Math.hypot(...this.up);
      this._upN = this.up.map((x) => x / u);
    }
    return this._sun;
  }

  // Light on a face (view-space polygon): the side seen by the camera, lit by the sun and the sky.
  shade(v) {
    const n = [0, 0, 0], c = [0, 0, 0];
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      c[0] += a[0]; c[1] += a[1]; c[2] += a[2];
    }
    const len = Math.hypot(...n);
    if (len < 1e-9) return 1;
    let k = 1 / len;
    if (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0) k = -k;      // the side facing the camera
    const L = this.sunView, U = this._upN;
    const sun = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) * k);
    const sky = (n[0] * U[0] + n[1] * U[1] + n[2] * U[2]) * k;
    return Math.min(1.25, Math.max(0.4, 0.55 + 0.6 * sun + 0.1 * sky));
  }

  // view-space point -> the object's own frame (half-feet, before its heading, pitch and roll),
  // so surface detail stays fixed to the model as it moves. Model -> world is R^T with
  // R = Rz(roll) Rx(pitch) Ry(heading), the camera's convention (heading checked against hangars).
  localFrame(o) {
    const w = viewMatrix(this.e, this.cam, this.base).invert().elements;
    const R = cameraRotation({ heading: o.angles[0], pitch: o.angles[1], roll: o.angles[2] }).elements;
    const ox = o.world[0], oy = o.world[1] + this.heightAt(o.world[0], o.world[2]) + Math.max(0, -(o.world[1] + o.bottom)), oz = o.world[2];
    return (q) => {
      const x = w[0] * q[0] + w[4] * q[1] + w[8] * q[2] + w[12] - ox;
      const y = w[1] * q[0] + w[5] * q[1] + w[9] * q[2] + w[13] - oy;
      const z = w[2] * q[0] + w[6] * q[1] + w[10] * q[2] + w[14] - oz;
      return [R[0] * x + R[3] * y + R[6] * z, R[1] * x + R[4] * y + R[7] * z, R[2] * x + R[5] * y + R[8] * z];
    };
  }

  // Ground vehicles, soldiers and structures cast shadows; aircraft have the game's own shadow models.
  casts(o) {
    return o.world[1] + o.bottom < 24 && !AIRCRAFT.has(o.name);
  }

  // view-space point -> its shadow along the sun, laid on the terrain
  flattener(o) {
    const view = viewMatrix(this.e, this.cam, this.base), v = view.elements, w = view.clone().invert().elements;
    const gy = this.heightAt(o.world[0], o.world[2]), L = SUN, k = 1 - SHADOW_LIFT;
    return (q) => {
      const x = w[0] * q[0] + w[4] * q[1] + w[8] * q[2] + w[12];
      const y = w[1] * q[0] + w[5] * q[1] + w[9] * q[2] + w[13];
      const z = w[2] * q[0] + w[6] * q[1] + w[10] * q[2] + w[14];
      const t = (y - gy) / L.y, sx = x - L.x * t, sz = z - L.z * t, sy = this.heightAt(sx, sz);
      return [0, 1, 2].map((i) => k * (v[i] * sx + v[4 + i] * sy + v[8 + i] * sz + v[12 + i]));
    };
  }

  mode(o) {
    if (o.name === 'stars') return 'sky';
    return layerOf(o) < 2 ? 'drape' : 'rigid';
  }

  // view-space shift of a model; one whose box reaches below the ground (a helicopter parked at
  // height 0 at the start of a mission) is also lifted onto it
  offset(o) {
    const d = this.heightAt(o.world[0], o.world[2]) - this.base + Math.max(0, -(o.world[1] + o.bottom));
    return this.up.map((u) => u * d);
  }

  // A view-space point of the game's ground put exactly on the terrain. Only its map position is
  // kept: the game's fixed-point transform leaves ground points a few units above or below
  // height 0, which a low camera looking along the ground would see as markings sinking into it.
  drape(q) {
    const e = this.e, px = q[0], py = q[1] / Y_SCALE, pz = -q[2];
    const x = this.cam[0] + e[0] * px + e[1] * py + e[2] * pz;
    const y = e[3] * px + e[4] * py + e[5] * pz;               // height relative to the camera
    const z = this.cam[2] + e[6] * px + e[7] * py + e[8] * pz;
    const d = this.heightAt(x, z) - this.base - this.cam[1] - y;
    return [q[0] + this.up[0] * d, q[1] + this.up[1] * d, q[2] + this.up[2] * d];
  }
}

// ------------------------------------------------------------- Enhanced mode: replacement models

// Static game models drawn with modern low-poly models (Kenney, CC0; assets/models/kenney). Each
// replacement takes the game object's position, heading and model box; only the look changes.
// Destroyed versions, vehicles, soldiers, towers and cranes keep the game's own models.
const MODELS = 'assets/models/kenney/';
const HALLS = ['a', 'b', 'g', 'h', 'k', 'o', 'p', 'q', 's', 't'].map((c) => `industrial/building-${c}`);
const HOUSES = 'abcdefghijklmnopqrstu'.split('').map((c) => `suburban/building-type-${c}`);
const TENT = { files: ['nature/tent_detailedClosed'], colour: 0x6b7040 };
const REPLACE = {
  palm: { files: ['nature/tree_palmTall', 'nature/tree_palmDetailedTall', 'nature/tree_palm', 'nature/tree_palmBend'], fit: 'height' },
  tree2: { files: ['nature/tree_default', 'nature/tree_oak'], fit: 'height' },
  tent: TENT, tent2: TENT,
  hooch: { files: ['survival/structure-canvas'], colour: 0xc8a060 },
  house2: { files: HALLS }, house5: { files: HALLS }, house6: { files: HALLS },
  hangar: { files: ['industrial/building-i', 'industrial/building-j'] },
  factory: { files: ['industrial/building-e', 'industrial/building-l', 'industrial/building-m', 'industrial/building-c', 'industrial/building-f'] },
  oil: { files: ['industrial/detail-tank-large'] },
  house1: { files: HOUSES }, house3: { files: HOUSES }, house4: { files: HOUSES },
};
const TURN_RAD = 2 * Math.PI / 2880;

class Props {
  constructor(renderer) {
    this.renderer = renderer;
    this.loader = new GLTFLoader();
    this.models = new Map();            // file -> { root, size, centre } once loaded, or null while loading
    this.pools = new Map();             // file -> clones, reused frame to frame
    this.scene = new THREE.Scene();     // replacement models
    this.ground = new THREE.Scene();    // runways
    this.ground.fog = new THREE.FogExp2(0xffffff, HAZE_DENSITY);
    // sky light from above, darker bounce from the ground: walls darken toward their foot
    this.ambient = new THREE.HemisphereLight(0xe8f0ff, 0x5a5448, 2.0);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    // shadows and contact darkening, drawn on the ground before the models (see addShadow)
    this.shadows = new THREE.Scene();
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
      // each pixel darkens once, however many shadow triangles cover it
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    });
    this.contactMaterial = new THREE.MeshBasicMaterial({ map: contactTexture(), transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
    this.contactGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadowPools = new Map(); this.contacts = [];
    this.runway = new Runway(renderer);
  }

  model(file) {
    if (this.models.has(file)) return this.models.get(file);
    this.models.set(file, null);
    this.loader.loadAsync(`${MODELS}${file}.glb`).then((g) => {
      // The page writes colours to the screen unconverted (the game's palette is exact that way);
      // Kenney's sRGB colours are used as they are, so they look as designed.
      g.scene.traverse((m) => {
        if (!m.isMesh) return;
        const mat = m.material = m.material.clone();
        mat.color.convertLinearToSRGB();
        mat.metalness = 0; mat.roughness = 1;     // some kits mark plain colours metallic: black without reflections
        if (mat.map) mat.map.colorSpace = THREE.NoColorSpace;
      });
      const box = new THREE.Box3().setFromObject(g.scene);
      this.models.set(file, { root: g.scene, size: box.getSize(new THREE.Vector3()), centre: box.getCenter(new THREE.Vector3()), min: box.min.clone() });
    }).catch((e) => console.info(`model ${file}: ${e.message}`));
    return null;
  }

  preload() {
    for (const spec of Object.values(REPLACE)) for (const f of spec.files) this.model(f);
    this.runway.concrete(6400, 512);
  }

  // Starts a view: `place` gives the camera (rotation, position, terrain height under it).
  begin(place, tint, haze) {
    this.place = place;
    this.view = viewMatrix(place.e, place.cam, place.base);
    for (const pool of this.pools.values()) pool.used = 0;
    this.scene.clear(); this.ground.clear();
    // sunlight from the north-west, in view space
    const d = SUN.clone().applyMatrix4(new THREE.Matrix4().extractRotation(this.view));
    this.sun.position.copy(d); this.sun.target.position.set(0, 0, 0);
    // the hemisphere's up is view-space world up
    this.ambient.position.set(place.up[0], place.up[1], place.up[2]);
    this.ambient.intensity = 2.0 * tint; this.sun.intensity = 2.2 * tint;
    this.scene.add(this.ambient, this.sun, this.sun.target);
    this.shadows.clear();
    for (const pool of this.shadowPools.values()) pool.used = 0;
    this.contactsUsed = 0;
    this.shadowMaterial.opacity = 0.5 * tint; this.contactMaterial.opacity = 0.55 * tint;
    this.tint = tint;
    this.ground.fog.color.copy(haze);
    this.runway.begin();
  }

  // shadows of the game's own vehicles, already flattened (see Relief.flattener)
  addFlatShadow(positions) {
    if (!this.flatShadow) {
      this.flatShadow = new THREE.Mesh(new THREE.BufferGeometry(), this.shadowMaterial);
      this.flatShadow.frustumCulled = false;
    }
    this.flatShadow.geometry.dispose();
    const g = this.flatShadow.geometry = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.shadows.add(this.flatShadow);
  }

  // Sun shadow: the model flattened onto the ground plane at its foot along the sun direction;
  // and contact darkening: a soft patch around its footprint (trees: a smaller one at the trunk).
  // Both are moved slightly toward the eye so the terrain under them does not hide them.
  addShadow(file, m, world, base, place, w, l, tree) {
    const k = 1 - SHADOW_LIFT;
    const toward = new THREE.Matrix4().makeScale(k, k, k);
    const L = SUN;
    const flatten = new THREE.Matrix4().set(
      1, -L.x / L.y, 0, base * L.x / L.y,
      0, 0, 0, base,
      0, -L.z / L.y, 1, base * L.z / L.y,
      0, 0, 0, 1);
    let pool = this.shadowPools.get(file);
    if (!pool) { pool = []; pool.used = 0; this.shadowPools.set(file, pool); }
    let shadow = pool[pool.used];
    if (!shadow) {
      shadow = m.root.clone(true);
      shadow.matrixAutoUpdate = false;
      shadow.traverse((n) => { n.frustumCulled = false; if (n.isMesh) n.material = this.shadowMaterial; });
      pool.push(shadow);
    }
    pool.used++;
    shadow.matrix.copy(toward).multiply(this.view).multiply(flatten).multiply(world);
    shadow.matrixWorldNeedsUpdate = true;
    this.shadows.add(shadow);
    let patch = this.contacts[this.contactsUsed];
    if (!patch) {
      patch = new THREE.Mesh(this.contactGeometry, this.contactMaterial);
      patch.matrixAutoUpdate = false; patch.frustumCulled = false;
      this.contacts.push(patch);
    }
    this.contactsUsed++;
    const size = tree ? [w * 0.6, l * 0.6] : [w * 1.35, l * 1.35];
    patch.matrix.copy(toward).multiply(this.view).multiply(place).multiply(new THREE.Matrix4().makeScale(size[0], 1, size[1]));
    patch.matrixWorldNeedsUpdate = true;
    this.shadows.add(patch);
  }

  // Draws a replacement for the object; false when it has none (or it is still loading).
  add(o) {
    if (!o.world || !o.box) return false;
    if (o.name === 'runway') return this.runway.add(o, this);
    const spec = REPLACE[o.name];
    if (!spec) return false;
    const models = spec.files.map((f) => this.model(f));
    if (models.some((m) => !m)) return false;
    const [x0, x1, y0, y1, z0, z1] = o.box;
    const w = x1 - x0, l = z1 - z0, h = y1 - y0;
    const hash = Math.abs(Math.imul(Math.round(o.world[0]), 73856093) ^ Math.imul(Math.round(o.world[2]), 19349663));
    // the replacement whose footprint is closest in shape, among the best three, varied per object
    const shape = (m) => Math.abs(Math.log(Math.max(m.size.x, m.size.z) / Math.min(m.size.x, m.size.z)) - Math.log(Math.max(w, l) / Math.max(1, Math.min(w, l))));
    const order = spec.fit === 'height' ? models.map((m, i) => i) : models.map((m, i) => i).sort((a, b) => shape(models[a]) - shape(models[b])).slice(0, 3);
    const k = order[hash % order.length], m = models[k], file = spec.files[k];
    // long sides together; the size follows the game's box, half way between its proportions and the model's own
    const turn = spec.fit !== 'height' && (m.size.x > m.size.z) !== (w > l);
    const W = turn ? m.size.z : m.size.x, L = turn ? m.size.x : m.size.z;
    let s = [w / W, h / m.size.y, l / L];
    if (spec.fit === 'height') s = [s[1], s[1], s[1]];
    else { const g = Math.cbrt(s[0] * s[1] * s[2]); s = s.map((v) => g * Math.sqrt(v / g)); }
    const a = o.angles[0] * TURN_RAD, c = Math.cos(a), sn = Math.sin(a);
    const yb = Math.max(o.world[1] + y0, 0) + this.place.heightAt(o.world[0], o.world[2]);
    const place = new THREE.Matrix4().set(c, 0, -sn, o.world[0], 0, 1, 0, yb, sn, 0, c, o.world[2], 0, 0, 0, 1)   // heading: model x -> (cos, sin), z -> (-sin, cos)
      .multiply(new THREE.Matrix4().makeTranslation((x0 + x1) / 2, 0, (z0 + z1) / 2));
    const world = place.clone()
      .multiply(new THREE.Matrix4().makeScale(...s))
      .multiply(new THREE.Matrix4().makeRotationY(turn ? Math.PI / 2 : 0))
      .multiply(new THREE.Matrix4().makeScale(-1, 1, 1))                // right-handed model into the game's left-handed world
      .multiply(new THREE.Matrix4().makeTranslation(-m.centre.x, -m.min.y, -m.centre.z));
    const mat = this.view.clone().multiply(world);
    this.addShadow(file, m, world, yb, place, Math.max(w, 1), Math.max(l, 1), spec.fit === 'height');
    let pool = this.pools.get(file);
    if (!pool) { pool = []; pool.used = 0; this.pools.set(file, pool); }
    let obj = pool[pool.used];
    if (!obj) {
      obj = m.root.clone(true);
      obj.matrixAutoUpdate = false;
      obj.traverse((n) => { n.frustumCulled = false; });
      if (spec.colour !== undefined) obj.traverse((n) => { if (n.isMesh) { n.material = n.material.clone(); n.material.color.set(spec.colour); } });
      pool.push(obj);
    }
    pool.used++;
    obj.matrix.copy(mat);
    obj.matrixWorldNeedsUpdate = true;
    this.scene.add(obj);
    return true;
  }
}

// Soft dark patch for under a model: black, fading out from the middle.
function contactTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// A runway drawn as concrete with markings: slabs, weathering, tyre marks, edge stripes, threshold
// bars, heading numbers at both ends, centre-line dashes and a helipad mark at its centre, where
// the helicopter starts. The texture is drawn once; the strip is laid on the terrain.
class Runway {
  constructor(renderer) {
    this.renderer = renderer;
    this.textures = new Map();          // "length:heading" -> texture
    this.meshes = [];
  }

  begin() { this.used = 0; }

  // concrete and every marking except the heading numbers, drawn once per runway size
  concrete(len, wid) {
    const key = `${len}:${wid}`;
    if (this.textures.has(key)) return this.textures.get(key);
    const W = 512, H = 4096, c = document.createElement('canvas');
    c.width = W; c.height = H;
    this.textures.set(key, c);
    const g = c.getContext('2d'), py = H / len, px = W / wid;     // pixels per game unit along, across
    // seeded noise, so every load looks the same
    let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    g.fillStyle = '#8f8f8a'; g.fillRect(0, 0, W, H);
    // concrete slabs 50 units square, each a slightly different shade, with dark joints
    for (let z = 0; z < len; z += 50) for (let x = 0; x < wid; x += 50) {
      const v = 128 + (rnd() - 0.5) * 18 | 0;
      g.fillStyle = `rgb(${v + 14},${v + 14},${v + 9})`;
      g.fillRect(x * px, z * py, 50 * px, 50 * py);
    }
    // joints: thin sealant lines (a texel is about 15 cm across the runway)
    g.fillStyle = 'rgba(60,60,56,0.35)';
    for (let z = 0; z <= len; z += 50) g.fillRect(0, z * py - 0.5, W, 1);
    for (let x = 0; x <= wid; x += 50) g.fillRect(x * px - 0.5, 0, 1, H);
    // speckle and stains
    for (let i = 0; i < 60000; i++) { const v = 60 + rnd() * 140 | 0; g.fillStyle = `rgba(${v},${v},${v},0.18)`; g.fillRect(rnd() * W, rnd() * H, 1, 1); }
    for (let i = 0; i < 60; i++) {
      const x = rnd() * W, y = rnd() * H, r = 20 + rnd() * 60;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(70,66,56,0.10)'); gr.addColorStop(1, 'rgba(70,66,56,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // tyre marks in the touchdown zones
    for (const end of [0, 1]) for (let i = 0; i < 70; i++) {
      const z = (end ? len - 700 - rnd() * 900 : 700 + rnd() * 900) * py, x = W / 2 + (rnd() - 0.5) * W * 0.25;
      g.fillStyle = `rgba(25,25,25,${0.08 + rnd() * 0.15})`;
      g.fillRect(x, z, 3 + rnd() * 4, (40 + rnd() * 160) * py);
    }
    const white = (x, z, w, l) => { g.fillStyle = 'rgba(245,245,240,0.92)'; g.fillRect(x * px, z * py, w * px, l * py); };
    // edge stripes
    white(8, 0, 6, len); white(wid - 14, 0, 6, len);
    for (const end of [0, 1]) {
      const at = (z, l) => (end ? len - z - l : z);
      // threshold bars
      for (let i = 0; i < 8; i++) { const x = 30 + i * ((wid - 60) / 8); if (Math.abs(x + 12 - wid / 2) > 30) white(x, at(40, 300), 24, 300); }
      // touchdown zone and aiming point markers
      for (const [z, l, w] of [[900, 250, 40], [1500, 180, 24], [2000, 180, 24]]) { white(wid / 2 - 70 - w, at(z, l), w, l); white(wid / 2 + 70, at(z, l), w, l); }
    }
    // centre line, interrupted by the helipad
    for (let z = 760; z < len - 760; z += 400) if (Math.abs(z + 120 - len / 2) > 260) white(wid / 2 - 3, z, 6, 240);
    // helipad: ring and H
    g.save();
    g.translate(W / 2, len / 2 * py); g.scale(px, py);
    g.strokeStyle = 'rgba(245,245,240,0.92)'; g.lineWidth = 8;
    g.beginPath(); g.arc(0, 0, 120, 0, 2 * Math.PI); g.stroke();
    g.fillStyle = 'rgba(245,245,240,0.92)';
    g.fillRect(-55, -70, 18, 140); g.fillRect(37, -70, 18, 140); g.fillRect(-55, -9, 110, 18);
    g.restore();
    return c;
  }

  // the concrete with this runway's heading numbers at both ends
  texture(len, wid, bearing) {
    const key = `${len}:${wid}:${bearing}`;
    if (this.textures.has(key)) return this.textures.get(key);
    const base = this.concrete(len, wid), W = base.width, H = base.height, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d'), py = H / len, px = W / wid;
    g.drawImage(base, 0, 0);
    for (const end of [0, 1]) {
      const at = (z, l) => (end ? len - z - l : z);
      // heading number, read when approaching this end
      const n = String(Math.round((((end ? bearing + 180 : bearing) % 360) + 360) % 360 / 10) || 36).padStart(2, '0');
      // the top of the numbers points down the runway, away from the approaching pilot
      g.save();
      g.translate(W / 2, at(420, 170) * py + 85 * py);
      g.scale(px, py);
      if (!end) g.rotate(Math.PI);
      g.fillStyle = 'rgba(245,245,240,0.92)';
      g.font = 'bold 170px Arial, Helvetica, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(n, 0, 0);
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    t.flipY = false;
    this.textures.set(key, t);
    return t;
  }

  add(o, props) {
    const [x0, x1, , , z0, z1] = o.box, a = o.angles[0] * TURN_RAD, c = Math.cos(a), s = Math.sin(a);
    const wid = x1 - x0, len = z1 - z0;
    const bearing = ((Math.atan2(-s, c) * 180 / Math.PI) + 360) % 360;      // of the model's +z, clockwise from north
    let mesh = this.meshes[this.used];
    const nx = 4, nz = 64;
    if (!mesh) {
      const g = new THREE.PlaneGeometry(1, 1, nx, nz);
      mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      this.meshes.push(mesh);
    }
    this.used++;
    mesh.material.map = this.texture(Math.round(len), Math.round(wid), Math.round(bearing));
    mesh.material.color.setScalar(props.tint);
    // vertices in world units, laid on the terrain (just above it)
    const pos = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i, u = i / nx, v = j / nz;
      const mx = x0 + u * wid, mz = z0 + v * len;
      const wx = o.world[0] + c * mx - s * mz, wz = o.world[2] + s * mx + c * mz;
      pos.setXYZ(k, wx, props.place.heightAt(wx, wz), wz);
      uv.setXY(k, u, v);
    }
    pos.needsUpdate = true; uv.needsUpdate = true;
    mesh.matrix.makeScale(1 - RUNWAY_LIFT, 1 - RUNWAY_LIFT, 1 - RUNWAY_LIFT).multiply(props.view);
    mesh.matrixWorldNeedsUpdate = true;
    props.ground.add(mesh);
    return true;
  }
}
