// Takes LHX's own 3D drawing out of its frames so the GPU can draw the 3D world underneath.
//
// The scene renderer (image 0x140ce) first fills the 3D window with sky and ground colours, then
// draws the models and effects. Right after the horizon fill (image 0x1468a) this module reads the
// window, records the sky and ground colours and the horizon line, fills the window with the key
// colour and drops every CPU write into the window until the scene renderer returns (image
// 0x14792). Whatever the game paints afterwards - HUD symbols, text, the canopy frame - lands on
// top of the key colour, so on screen it is drawn over the GPU picture, as in the game.

const IMAGE = 0x8110;
const AFTER_HORIZON = 0x1468a;
const SCENE_END = 0x14792;
// After the models the scene renderer calls 0x6e:2f12 for symbols drawn over the 3D view (the
// target box); those are kept, so the filter is off for that call.
const SYMBOLS_CALL = 0x146be, SYMBOLS_RETURN = 0x146c3;
// Effect primitives (explosions) call a 2D drawing routine whose address is stored in the
// primitive; they draw into the game's frame and show over the GPU picture.
const EFFECT_CALL = 0x1aa0d, EFFECT_RETURN = 0x1aa10;
export const KEY = 255;                 // palette index the game never shows (an unused copy of white)

const V = {
  backBuffer: 0xecfe,                   // segment of the off-screen frame
  lineFill: 0xed3c,                     // per scanline: the solid colour the line holds, 0xff if mixed
  rows: 0xeb6e,                         // table of row offsets in the frame (word per line)
  winX: 0xeb5a, winWords: 0xeb58, winTop: 0xeed1, winBottom: 0xeed3,
  heading: 0xf027, pitch: 0xf029, roll: 0xf02b,
  position: 0xf01b,                     // camera world x, y, z: 32-bit, 24.8 fixed point, half-feet
  colours: 0xf019,                      // pointer to the ground and sky palette indices the horizon fill uses
};

export class Composite {
  constructor(pc) {
    this.pc = pc;
    this.enabled = true;
    this.horizons = new Map();          // window key -> horizon of the latest scene drawn in it
    pc.cpu.hook(IMAGE + AFTER_HORIZON, () => { if (this.enabled) this.afterHorizon(); return false; });
    pc.cpu.hook(IMAGE + SCENE_END, (cpu) => { cpu.filterLen = 0; this.held = 0; return false; });
    pc.cpu.hook(IMAGE + SYMBOLS_CALL, (cpu) => { this.held = cpu.filterLen; cpu.filterLen = 0; return false; });
    pc.cpu.hook(IMAGE + SYMBOLS_RETURN, (cpu) => { cpu.filterLen = this.held || 0; return false; });
    pc.cpu.hook(IMAGE + EFFECT_CALL, (cpu) => { this.held = cpu.filterLen; cpu.filterLen = 0; return false; });
    pc.cpu.hook(IMAGE + EFFECT_RETURN, (cpu) => { cpu.filterLen = this.held || 0; return false; });
  }

  w(off) { const c = this.pc.cpu; return c.rw(c.s[3], off); }

  afterHorizon() {
    const c = this.pc.cpu, m = this.pc.mem;
    const seg = this.w(V.backBuffer), xb = this.w(V.winX), width = this.w(V.winWords) * 2;
    const y0 = this.w(V.winTop), y1 = this.w(V.winBottom);
    const rowAt = (y) => seg * 16 + this.w(V.rows + 2 * y) + xb;
    const h = y1 - y0 + 1;
    const pix = new Uint8Array(width * h);
    for (let y = 0; y < h; y++) pix.set(m.subarray(rowAt(y0 + y), rowAt(y0 + y) + width), y * width);
    const view = { x0: xb, x1: xb + width, y0, y1: y1 + 1 };
    // camera angles of this view (2880 units per turn), read while the view is being drawn
    const angle = (o) => { const v = this.w(o); return v & 0x8000 ? v - 0x10000 : v; };
    const camera = { heading: angle(V.heading), pitch: angle(V.pitch), roll: angle(V.roll),
      position: [0, 4, 8].map((k) => (this.w(V.position + k) | (this.w(V.position + k + 2) << 16)) / 256) };
    const table = this.w(V.colours);
    const ground = c.rb(c.s[3], table), sky = c.rb(c.s[3], table + 1);
    this.horizons.set(`${view.x0},${view.y0},${view.x1},${view.y1}`, { ...horizon(pix, width, h, xb, y0), camera, ground, sky, time: this.pc.seconds });
    // the key fill makes the lines mixed: the game must refill and present them every frame
    const ds = c.s[3];
    for (let y = y0; y <= y1; y++) { m.fill(KEY, rowAt(y), rowAt(y) + width); c.wb(ds, V.lineFill + y, 0xff); }
    c.filterLo = rowAt(y0) - xb;
    c.filterLen = rowAt(y1) - xb + 320 - c.filterLo;
  }
}

// Sky and ground colours and the line between them, in 320 x 200 screen coordinates.
// Returns { colors: [a] } for a single colour, or { colors: [pos, neg], point, normal } where
// `pos` fills the side the normal points to.
export function horizon(pix, w, h, x0, y0) {
  const count = new Map();
  for (const p of pix) count.set(p, (count.get(p) || 0) + 1);
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2 || ranked[1][1] < pix.length * 0.002) return { colors: [ranked[0][0]] };
  const A = ranked[0][0], B = ranked[1][0];
  const both = (p) => p === A || p === B;
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = pix[y * w + x];
    if (!both(p)) continue;
    if (x + 1 < w) { const q = pix[y * w + x + 1]; if (both(q) && q !== p) pts.push([x + 1, y + 0.5]); }
    if (y + 1 < h) { const q = pix[(y + 1) * w + x]; if (both(q) && q !== p) pts.push([x + 0.5, y + 1]); }
  }
  if (pts.length < 2) return { colors: [A] };
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);          // direction of the line
  const n = [-Math.sin(angle), Math.cos(angle)];
  const sample = (s) => {
    const votes = new Map();
    for (const d of [3, 5, 8]) {
      const x = Math.round(cx + n[0] * d * s - 0.5), y = Math.round(cy + n[1] * d * s - 0.5);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const p = pix[y * w + x];
      votes.set(p, (votes.get(p) || 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  let pos = sample(1), neg = sample(-1);
  if (pos === undefined) pos = neg === A ? B : A;
  if (neg === undefined || neg === pos) neg = pos === A ? B : A;
  return { colors: [pos, neg], point: [x0 + cx, y0 + cy], normal: n };
}
