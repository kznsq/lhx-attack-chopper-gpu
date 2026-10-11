// Draws the world farther out than the game does (Enhanced mode), so buildings and vehicles do not
// pop up close to the helicopter.
//
// The draw-list builder (image 0x16e57) decides per object from its distance to the camera (the
// sum of the x, y and z differences, 24.8 fixed point, in dx:ax): with d = the distance's high
// word (units of 256 half-feet), the model record's two thresholds (+0xe, +0x10) choose the
// detailed model, the simple one, or nothing. Before that, a coarse check (0x19d65) tests the
// object against a box around the camera chosen by the record's size class (+0x16); each class's
// box is twice the size of the one before. Dividing d by `factor` and moving the size class up by
// log2(factor) widens both by `factor`; the distance stored in the draw list (used for sorting)
// stays true.
//
// The engine transforms models in 16-bit numbers, in each model's own units (2^(record +0xc,
// signed) half-feet), and its own range keeps every coordinate within that. A far object is drawn
// farther out only while its distance plus its radius (record +2) stays inside 16 bits; past that
// its coordinates would wrap around and land next to the camera.

const IMAGE = 0x8110;
const LOD_DISTANCE = 0x16ef2;       // dx:ax = distance, just before the threshold compares
const SIZE_CLASS = 0x19d6c;         // si = size class, just read from the record
const RECORD = 0x748;               // data segment: the model record of the object being listed
const SAFE = 0x7000;                // model units: coordinates the transform can hold, with margin

export class Reach {
  constructor(pc) {
    this.factor = 1;
    this.widened = false;           // whether the object being listed got the wider range
    pc.cpu.hook(IMAGE + LOD_DISTANCE, (cpu) => {
      this.widened = false;
      if (this.factor <= 1) return false;
      const ds = cpu.s[3], rec = cpu.rw(ds, RECORD);
      const unit = 2 ** ((cpu.rb(ds, rec + 0xc) << 24 >> 24));
      const halfFeet = (cpu.r[2] * 65536 + cpu.r[0]) / 256;
      if (halfFeet / unit + cpu.rw(ds, rec + 2) < SAFE) {
        cpu.r[2] = Math.floor(cpu.r[2] / this.factor);      // DX
        this.widened = true;
      }
      return false;
    });
    pc.cpu.hook(IMAGE + SIZE_CLASS, (cpu) => {
      if (this.widened) cpu.r[6] = Math.min(19, cpu.r[6] + Math.log2(this.factor));  // SI
      return false;
    });
  }
}
