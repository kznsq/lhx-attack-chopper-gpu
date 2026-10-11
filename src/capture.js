// Captures LHX's 3D scene from inside the running game, for drawing on the GPU.
//
// The engine draws every model through one routine (image 0x1cad8). Right after that routine has
// transformed the model's points into camera space (image 0x1cd76), the camera-space points, the
// level-of-detail record and its primitive list (with the face colours the game set at load time)
// are all in emulated memory; this module reads them there. The frame ends when the game copies
// its back buffer to the screen (image 0x11096).
//
// Camera space: X to the right, Y up, Z into the screen. The game projects with
// screen x = cx + focus * X / Z and screen y = cy - (15/16) * focus * Y / Z (pixels of the
// 320 x 200 screen), where focus = 2^[0xf02f] (128 for the main view; larger when zoomed).
//
// Each model's camera-space points are scaled by its own power of two: model units are
// 2^(record +0xc, signed) half-feet, and the draw-list builder (image 0x16b07) shifts each
// object's points left by [0xf1ff] so its largest coordinate fills 16 bits. `unit` undoes both:
// points * unit are half-feet, the same for every model, so depths compare between models.

const IMAGE = 0x8110;                 // linear address of unpacked-image offset 0
const AFTER_TRANSFORM = 0x1cd76;
const PRESENT = 0x11096;
// When neither the camera nor an object has moved, the draw routine redraws the object from
// cached screen coordinates and skips the transform. Jumping from the start of that cache check
// (0x1cbae) to the cache-miss path (0x1cc5f) makes every object go through the transform; the
// miss path reuses the object's cache buffer, so nothing is allocated.
const CACHE_CHECK = 0x1cbae;
const CACHE_MISS = 0x1cc5f;
const CODE_SEGMENT_BASE = 0xfd10;     // image offset of the engine's code segment

// data-segment variables (offsets in the game's data segment)
// model record fields
const MODEL_UNIT = 0xc;       // signed byte: model units are 2^n half-feet
const MODEL_BOX = 0x2c;       // bounding box x0, x1, y0, y1, z0, z1 (32-bit, 24.8 fixed point)

const V = {
  lod: 0xf209,          // near pointer to the level-of-detail record being drawn
  record: 0xf207,       // near pointer to the model record
  points: 0x70e,        // near pointer to the camera-space point buffer (16 bytes per point)
  centreX: 0xeb52, centreY: 0xeb54,
  focusShift: 0xf02f,   // screen x = cx + (X << focusShift) / Z
  scaleShift: 0xf1ff,   // per-draw precision shift; sphere radius = radius << scaleShift
  object: 0xf201,       // far pointer to the object being drawn (world position at +6, +0xa, +0xe)
  winX: 0xeb5a, winWords: 0xeb58, winTop: 0xeed1, winBottom: 0xeed3,
};

export class Capture {
  constructor(pc, onFrame) {
    this.pc = pc;
    this.onFrame = onFrame;
    this.objects = [];
    this.names = new Map();
    this.frames = 0;
    pc.cpu.hook(IMAGE + AFTER_TRANSFORM, () => { this.grab(); return false; });
    pc.cpu.hook(IMAGE + CACHE_CHECK, (cpu) => { cpu.ip = CACHE_MISS - CODE_SEGMENT_BASE; return true; });
    pc.cpu.hook(IMAGE + PRESENT, () => { this.present(); return false; });
  }

  w(off) { const c = this.pc.cpu; return c.rw(c.s[3], off); }
  s16(seg, off) { const v = this.pc.cpu.rw(seg, off); return v & 0x8000 ? v - 0x10000 : v; }

  modelName(record) {
    if (this.names.has(record)) return this.names.get(record);
    // At draw time a far model's block has been copied into a shared slot in the data segment,
    // and its record's name and level-of-detail pointers point into that copy.
    const c = this.pc.cpu, ds = c.s[3], seg = ds;
    const ptr = c.rw(ds, record + 0x1e);
    let s = '';
    for (let i = 0; i < 13; i++) {
      const ch = c.rb(seg, ptr + i);
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    const name = /^[a-z0-9_]+$/.test(s) ? s : `model@${record.toString(16)}`;
    this.names.set(record, name);
    return name;
  }

  grab() {
    const c = this.pc.cpu, ds = c.s[3];
    const lod = this.w(V.lod), record = this.w(V.record), buf = this.w(V.points);
    const nprim = c.rb(ds, lod), npts = c.rb(ds, lod + 1);
    const pts = new Float32Array(npts * 3);
    for (let i = 0; i < npts; i++) {
      const b = buf + i * 16;
      pts[i * 3] = this.s16(ds, b + 2);
      pts[i * 3 + 1] = this.s16(ds, b + 6);
      pts[i * 3 + 2] = this.s16(ds, b + 10);
    }
    const prims = [];
    let p = lod + 14;
    for (let k = 0; k < nprim; k++) {
      const t = c.rb(ds, p), kind = t & 7;
      const color = c.rb(ds, p + 3);
      if (kind === 0) {
        const n = c.rb(ds, p + 6);
        const idx = [];
        for (let j = 0; j < n; j++) idx.push(c.rb(ds, p + 7 + j));
        prims.push({ kind, color, double: !(t & 0x10), stipple: c.rb(ds, p + 4) !== 0xff, idx });
        p += 7 + n;
      } else if (kind === 1) {
        prims.push({ kind, color, idx: [c.rb(ds, p + 5), c.rb(ds, p + 6)] }); p += 7;
      } else if (kind === 2) {
        prims.push({ kind, color, idx: [c.rb(ds, p + 5)] }); p += 6;
      } else if (kind === 3) {
        prims.push({ kind, color, radius: c.rw(ds, p + 5), idx: [c.rb(ds, p + 7)] }); p += 8;
      } else if (kind === 4) {
        p += 8;
      } else break;
    }
    // the projection centre identifies which view (main window or cockpit camera) this is for
    const cx = this.s16(ds, V.centreX), cy = this.s16(ds, V.centreY);
    const focus = 1 << this.w(V.focusShift), shift = c.rb(ds, V.scaleShift), scale = 1 << shift;
    const unit = 2 ** ((c.rb(ds, record + MODEL_UNIT) << 24 >> 24) - shift);
    // level-of-detail flag bit 0: the engine calls a custom routine instead of drawing the
    // primitive list (the ground-dot field, for example); those are not drawn as models
    const custom = (c.rb(ds, lod + 0xd) & 1) !== 0;
    // world position in half-feet (x east, y up, z north), the model's lowest point relative to
    // its origin, and whether the model is flat (its box has no height): a flat model standing at
    // height 0 is a ground marking
    const i32 = (seg, off) => (c.rw(seg, off) | (c.rw(seg, off + 2) << 16));
    const oOff = this.w(V.object), oSeg = this.w(V.object + 2);
    const world = [6, 0xa, 0xe].map((k) => i32(oSeg, oOff + k) / 256);
    const box = [0, 1, 2, 3, 4, 5].map((k) => i32(ds, record + MODEL_BOX + 4 * k) / 256);
    const bottom = box[2], flat = box[2] === box[3];
    // the object's heading, pitch and roll (2880 per turn); objects flagged as unrotated have none
    const angles = c.rw(oSeg, oOff + 2) & 2 ? [0, 0, 0] : [0x12, 0x14, 0x16].map((k) => this.s16(oSeg, oOff + k));
    this.objects.push({ name: this.modelName(record), record, lod, pts, prims, cx, cy, focus, scale, unit, custom, world, box, bottom, flat, angles });
  }

  present() {
    const view = {
      cx: this.s16(this.pc.cpu.s[3], V.centreX), cy: this.s16(this.pc.cpu.s[3], V.centreY),
      x0: this.w(V.winX), x1: this.w(V.winX) + this.w(V.winWords) * 2,
      y0: this.w(V.winTop), y1: this.w(V.winBottom) + 1,
    };
    // several windows can be drawn before the first is presented: take this view's objects only
    const mine = this.objects.filter(o => o.cx === view.cx && o.cy === view.cy);
    this.objects = this.objects.filter(o => o.cx !== view.cx || o.cy !== view.cy);
    const frame = { objects: mine, view, palette: this.pc.dac.slice(), time: this.pc.seconds };
    this.frames++;
    this.onFrame(frame);
  }
}
