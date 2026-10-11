// IBM PC/AT-class machine around the CPU: interrupt controller (8259), timer (8253),
// keyboard controller, VGA (mode 13h and text), joystick port and PC speaker gate.
// Time is counted in executed instructions; `ips` converts it to seconds.

import { CPU } from './cpu.js';

export const PIT_HZ = 1193182;

export class PC {
  constructor({ ips = 8_000_000, log = () => {} } = {}) {
    this.ips = ips;
    this.log = log;
    this.mem = new Uint8Array(0x110000);
    this.cpu = new CPU(this.mem, this);
    this.cpu.irq = () => this.acknowledge();

    // 8259 interrupt controller
    this.imr = 0xfc;            // timer and keyboard enabled
    this.irr = 0;
    this.isr = 0;

    // 8253 timer: channel 0 drives IRQ 0, channel 2 the speaker
    this.pit = [0, 1, 2].map(() => ({ reload: 0x10000, mode: 3, access: 3, lowNext: true, latched: -1, start: 0, value: 0 }));
    this.timerPeriod = this.ips * 0x10000 / PIT_HZ;
    this.nextTimer = this.timerPeriod;

    // keyboard controller
    this.keyQueue = [];
    this.port60 = 0;
    this.port61 = 0;

    // VGA
    this.mode = 3;
    this.dac = new Uint8Array(768);
    this.dacWrite = 0; this.dacRead = 0; this.dacSub = 0;
    this.seqIndex = 0; this.seq = new Uint8Array(8);
    this.gcIndex = 0; this.gc = new Uint8Array(16);
    this.crtcIndex = 0; this.crtc = new Uint8Array(32);
    this.attrFlip = false;

    this.portLog = new Map();   // first use of each unhandled port, for discovery
    this.exited = null;
  }

  get seconds() { return this.cpu.cycles / this.ips; }

  // Change emulated speed; timer periods are kept in instructions, so they are rescaled.
  setIPS(ips) {
    this.ips = ips;
    this.timerPeriod = ips * (this.pit[0].reload || 0x10000) / PIT_HZ;
    this.nextTimer = this.cpu.cycles + this.timerPeriod;
  }

  // ---------------------------------------------------------------- 8259
  raise(irq) { this.irr |= 1 << irq; this.updatePending(); }
  updatePending() { this.cpu.irqPending = (this.irr & ~this.imr) !== 0; }
  acknowledge() {
    const ready = this.irr & ~this.imr;
    for (let i = 0; i < 8; i++) {
      const bit = 1 << i;
      if (this.isr & bit) break;           // a higher-priority interrupt is still being served
      if (ready & bit) {
        this.irr &= ~bit; this.isr |= bit; this.updatePending();
        return 8 + i;
      }
    }
    this.cpu.irqPending = false;
    return -1;
  }
  eoi() {
    for (let i = 0; i < 8; i++) if (this.isr & (1 << i)) { this.isr &= ~(1 << i); break; }
    this.deliverKey();
    this.updatePending();
  }

  // ---------------------------------------------------------------- 8253
  pitCount(c) {
    const ch = this.pit[c];
    const ticks = Math.floor((this.cpu.cycles - ch.start) * PIT_HZ / this.ips);
    const period = ch.reload || 0x10000;
    return (period - (ticks % period)) & 0xffff;
  }
  pitWrite(c, v) {
    const ch = this.pit[c];
    let full = false;
    if (ch.access === 1) { ch.value = v; full = true; }
    else if (ch.access === 2) { ch.value = v << 8; full = true; }
    else if (ch.lowNext) { ch.value = v; ch.lowNext = false; }
    else { ch.value |= v << 8; ch.lowNext = true; full = true; }
    if (!full) return;
    ch.reload = ch.value || 0x10000;
    ch.start = this.cpu.cycles;
    if (c === 0) {
      this.timerPeriod = this.ips * ch.reload / PIT_HZ;
      this.nextTimer = this.cpu.cycles + this.timerPeriod;
    }
  }
  pitRead(c) {
    const ch = this.pit[c];
    let v = ch.latched >= 0 ? ch.latched : this.pitCount(c);
    if (ch.access === 1) { ch.latched = -1; return v & 0xff; }
    if (ch.access === 2) { ch.latched = -1; return v >> 8; }
    if (ch.lowNext) { ch.lowNext = false; return v & 0xff; }
    ch.lowNext = true; ch.latched = -1; return v >> 8;
  }

  // ---------------------------------------------------------------- keyboard
  pressKey(scancodes) { this.keyQueue.push(...scancodes); this.deliverKey(); }
  deliverKey() {
    if (!this.keyQueue.length || (this.isr & 2) || (this.irr & 2)) return;
    this.port60 = this.keyQueue.shift();
    this.raise(1);
  }

  // ---------------------------------------------------------------- VGA
  retrace() {
    // 70 Hz frames, vertical retrace for the last ~6 % of each frame
    const frame = this.seconds * 70;
    return frame - Math.floor(frame) > 0.94;
  }

  // ---------------------------------------------------------------- I/O ports
  in8(port) {
    switch (port) {
      case 0x20: return this.irr;
      case 0x21: return this.imr;
      case 0x40: case 0x41: case 0x42: return this.pitRead(port - 0x40);
      case 0x60: return this.port60;
      case 0x61: this.port61 ^= 0x10; return this.port61;  // refresh toggle, polled by delay loops
      case 0x64: return this.keyQueue.length ? 1 : 0;
      case 0x201: return 0xff;                             // no joystick
      case 0x3c4: return this.seqIndex;
      case 0x3c5: return this.seq[this.seqIndex & 7];
      case 0x3c7: return 3;
      case 0x3c8: return this.dacWrite;
      case 0x3c9: {
        const v = this.dac[this.dacRead * 3 + this.dacSub];
        if (++this.dacSub === 3) { this.dacSub = 0; this.dacRead = (this.dacRead + 1) & 255; }
        return v;
      }
      case 0x3cc: return 0x63;
      case 0x3ce: return this.gcIndex;
      case 0x3cf: return this.gc[this.gcIndex & 15];
      case 0x3d4: return this.crtcIndex;
      case 0x3d5: return this.crtc[this.crtcIndex & 31];
      case 0x3da: {
        this.attrFlip = false;
        const vr = this.retrace();
        // bit 0 toggles fast (display enable / horizontal retrace), bit 3 is vertical retrace
        return (vr ? 9 : 0) | ((this.cpu.cycles >> 3) & 1);
      }
    }
    this.unhandled('in', port);
    return 0xff;
  }
  out8(port, v) {
    switch (port) {
      case 0x20: if (v & 0x20) this.eoi(); return;
      case 0x21: this.imr = v; this.updatePending(); return;
      case 0x40: case 0x41: case 0x42: this.pitWrite(port - 0x40, v); return;
      case 0x43: {
        const c = v >> 6;
        if (c === 3) return;
        const ch = this.pit[c], access = v >> 4 & 3;
        if (access === 0) { ch.latched = this.pitCount(c); return; }
        ch.access = access; ch.mode = v >> 1 & 7; ch.lowNext = true;
        return;
      }
      case 0x61: this.port61 = v; return;
      case 0x201: return;
      case 0x3c4: this.seqIndex = v; return;
      case 0x3c5: this.seq[this.seqIndex & 7] = v; return;
      case 0x3c7: this.dacRead = v; this.dacSub = 0; return;
      case 0x3c8: this.dacWrite = v; this.dacSub = 0; return;
      case 0x3c9:
        this.dac[this.dacWrite * 3 + this.dacSub] = v & 63;
        if (++this.dacSub === 3) { this.dacSub = 0; this.dacWrite = (this.dacWrite + 1) & 255; }
        return;
      case 0x3c0: this.attrFlip = !this.attrFlip; return;
      case 0x3ce: this.gcIndex = v; return;
      case 0x3cf: this.gc[this.gcIndex & 15] = v; return;
      case 0x3d4: this.crtcIndex = v; return;
      case 0x3d5: this.crtc[this.crtcIndex & 31] = v; return;
    }
    this.unhandled('out', port, v);
  }
  in16(port) { return this.in8(port) | this.in8(port + 1) << 8; }
  out16(port, v) { this.out8(port, v & 0xff); this.out8(port + 1, v >> 8); }
  unhandled(dir, port, v) {
    const key = dir + port;
    if (!this.portLog.has(key)) {
      this.portLog.set(key, 0);
      this.log(`port ${dir} ${port.toString(16)}${v !== undefined ? ' = ' + v.toString(16) : ''} at ${this.cpu.where()}`);
    }
    this.portLog.set(key, this.portLog.get(key) + 1);
  }

  // ---------------------------------------------------------------- execution
  // Runs the machine for `seconds` of emulated time.
  run(seconds) {
    const cpu = this.cpu;
    const target = cpu.cycles + seconds * this.ips;
    while (cpu.cycles < target && this.exited === null) {
      const next = Math.min(target, this.nextTimer);
      if (cpu.halted) cpu.cycles = Math.max(cpu.cycles, Math.ceil(next));
      else cpu.run(Math.max(1, Math.ceil(next - cpu.cycles)));
      if (cpu.cycles >= this.nextTimer) {
        this.raise(0);
        this.nextTimer += this.timerPeriod;
        if (this.nextTimer < cpu.cycles) this.nextTimer = cpu.cycles + this.timerPeriod;
      }
    }
  }

  // RGBA image of the current screen (mode 13h) or null in text mode. Pixels of palette index
  // `key` (if given) are made fully transparent.
  frame(rgba, key = -1) {
    if (this.mode !== 0x13) return null;
    const m = this.mem, dac = this.dac;
    for (let i = 0, o = 0; i < 64000; i++, o += 4) {
      const p = m[0xa0000 + i], c = p * 3;
      rgba[o] = dac[c] << 2 | dac[c] >> 4;
      rgba[o + 1] = dac[c + 1] << 2 | dac[c + 1] >> 4;
      rgba[o + 2] = dac[c + 2] << 2 | dac[c + 2] >> 4;
      rgba[o + 3] = p === key ? 0 : 255;
    }
    return rgba;
  }

  textScreen() {
    const lines = [];
    for (let y = 0; y < 25; y++) {
      let s = '';
      for (let x = 0; x < 80; x++) {
        const c = this.mem[0xb8000 + (y * 80 + x) * 2];
        s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
      }
      lines.push(s.replace(/\s+$/, ''));
    }
    return lines.join('\n').replace(/\n+$/, '');
  }
}
