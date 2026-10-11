// BIOS and DOS services implemented in JavaScript (high-level emulation), the EXE loader and an
// in-memory file system. Every interrupt vector starts out pointing at a one-byte IRET stub in the
// ROM segment; a CPU hook on the stub runs the JavaScript service and then lets the IRET execute,
// so programs can still install their own handlers and chain to the originals.

import { AX, CX, DX, BX, SP, BP, SI, DI, ES, CS, SS, DS } from './cpu.js';

const ROM = 0xf000;
const STUBS = 0x1000;          // F000:1000 + n  - IRET stub for vector n
const INT8_CODE = 0x2000;      // F000:2000      - BIOS timer handler as real code
const LIST_OF_LISTS = 0x3000;  // F000:3000      - DOS internal tables (first MCB only)
const FIRST_MCB = 0x0800;
const MEM_TOP = 0xa000;

// scancode set 1 -> [normal, shifted] ASCII
const ASCII = {};
const rows = [
  [0x02, '1234567890-=', '!@#$%^&*()_+'], [0x10, 'qwertyuiop[]', 'QWERTYUIOP{}'],
  [0x1e, "asdfghjkl;'`", 'ASDFGHJKL:"~'], [0x2b, '\\zxcvbnm,./', '|ZXCVBNM<>?'],
];
for (const [base, lo, hi] of rows) for (let i = 0; i < lo.length; i++) ASCII[base + i] = [lo.charCodeAt(i), hi.charCodeAt(i)];
Object.assign(ASCII, { 0x01: [27, 27], 0x0e: [8, 8], 0x0f: [9, 0], 0x1c: [13, 13], 0x39: [32, 32], 0x37: [42, 42], 0x4a: [45, 45], 0x4e: [43, 43] });

function wildcard(pattern, name) {
  const [pb, pe = ''] = pattern.toUpperCase().split('.');
  const [nb, ne = ''] = name.toUpperCase().split('.');
  const part = (p, n, len) => {
    p = p.padEnd(len, ' '); n = n.padEnd(len, ' ');
    for (let i = 0; i < len; i++) {
      if (p[i] === '*') return true;
      if (p[i] !== '?' && p[i] !== n[i]) return false;
    }
    return true;
  };
  return part(pb, nb, 8) && part(pe, ne, 3);
}

export class DOS {
  constructor(pc, files, { now = () => new Date(), console: out = () => {} } = {}) {
    this.pc = pc;
    this.cpu = pc.cpu;
    this.mem = pc.mem;
    this.files = new Map(Object.entries(files).map(([k, v]) => [k.toUpperCase(), v]));
    this.now = now;
    this.out = out;
    this.handles = [];
    this.dta = [0, 0];
    this.searches = new Map();
    this.cursor = [0, 0];
    this.extended = false;
    this.calls = new Map();     // service usage counts, for discovery
    this.install();
  }

  // ---------------------------------------------------------------- setup
  install() {
    const cpu = this.cpu, m = this.mem;
    for (let n = 0; n < 256; n++) {
      const lin = ROM * 16 + STUBS + n;
      m[lin] = 0xcf;                                   // IRET
      cpu.ww(0, n * 4, STUBS + n); cpu.ww(0, n * 4 + 2, ROM);
      // a blocking service leaves CS:IP on the stub, halts, and runs again after the next interrupt
      cpu.hook(lin, () => { this.blocked = false; this.service(n); return this.blocked; });
    }
    // INT 8: count ticks at 0040:006C, call INT 1Ch, acknowledge the interrupt controller
    const int8 = [0x50, 0x1e, 0x31, 0xc0, 0x8e, 0xd8, 0xff, 0x06, 0x6c, 0x04, 0x75, 0x04,
      0xff, 0x06, 0x6e, 0x04, 0xcd, 0x1c, 0xb0, 0x20, 0xe6, 0x20, 0x1f, 0x58, 0xcf];
    m.set(int8, ROM * 16 + INT8_CODE);
    cpu.ww(0, 8 * 4, INT8_CODE);
    // BIOS data area
    cpu.ww(0x40, 0x10, 0x0061);                         // equipment: 80x25 colour, FPU absent
    cpu.ww(0x40, 0x13, 640);
    cpu.ww(0x40, 0x1a, 0x1e); cpu.ww(0x40, 0x1c, 0x1e);
    cpu.ww(0x40, 0x80, 0x1e); cpu.ww(0x40, 0x82, 0x3e);
    m[0x449] = 3; cpu.ww(0x40, 0x4a, 80); m[0x484] = 24;
    for (let i = 0; i < 80 * 25; i++) cpu.ww(0xb800, i * 2, 0x0720);
    cpu.ww(ROM, LIST_OF_LISTS, FIRST_MCB);
    // DOS memory: one free block from FIRST_MCB to the top of conventional memory
    this.writeMCB(FIRST_MCB, 0x5a, 0, MEM_TOP - FIRST_MCB - 1);
  }

  // ---------------------------------------------------------------- memory control blocks
  writeMCB(seg, type, owner, size) {
    const b = seg * 16;
    this.mem[b] = type; this.cpu.ww(seg, 1, owner); this.cpu.ww(seg, 3, size);
  }
  mcbs() {
    const out = [];
    let seg = FIRST_MCB;
    for (;;) {
      const type = this.mem[seg * 16], owner = this.cpu.rw(seg, 1), size = this.cpu.rw(seg, 3);
      out.push({ seg, type, owner, size });
      if (type === 0x5a || out.length > 4096) return out;
      seg += size + 1;
    }
  }
  coalesce() {
    let list = this.mcbs();
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a.owner === 0 && b.owner === 0) {
        this.writeMCB(a.seg, b.type, 0, a.size + b.size + 1);
        list = this.mcbs(); i = -1;
      }
    }
  }
  alloc(paras, owner) {
    this.coalesce();
    let largest = 0;
    for (const b of this.mcbs()) {
      if (b.owner !== 0) continue;
      if (b.size >= paras) {
        if (b.size > paras) {
          this.writeMCB(b.seg + paras + 1, b.type, 0, b.size - paras - 1);
          this.writeMCB(b.seg, 0x4d, owner, paras);
        } else this.writeMCB(b.seg, b.type, owner, paras);
        return { seg: b.seg + 1 };
      }
      largest = Math.max(largest, b.size);
    }
    return { error: 8, largest };
  }
  free(seg) { this.cpu.ww(seg - 1, 1, 0); this.coalesce(); return true; }
  resize(seg, paras) {
    this.coalesce();
    const list = this.mcbs();
    const i = list.findIndex(b => b.seg === seg - 1);
    if (i < 0) return { error: 9 };
    const b = list[i], next = list[i + 1];
    let avail = b.size;
    if (next && next.owner === 0) avail += next.size + 1;
    if (paras > avail) return { error: 8, largest: avail };
    const type = paras < avail ? 0x4d : (next && next.owner === 0 ? next.type : b.type);
    const lastType = next && next.owner === 0 ? next.type : b.type;
    if (paras < avail) {
      this.writeMCB(b.seg + paras + 1, lastType, 0, avail - paras - 1);
      this.writeMCB(b.seg, 0x4d, b.owner, paras);
    } else this.writeMCB(b.seg, type, b.owner, paras);
    return {};
  }

  // ---------------------------------------------------------------- program loading
  loadExe(name, tail) {
    const cpu = this.cpu, data = this.files.get(name.toUpperCase());
    if (!data) throw new Error(`${name} not found`);
    const h = (o) => data[o] | data[o + 1] << 8;
    if (h(0) !== 0x5a4d) throw new Error('not an MZ executable');
    const pages = h(4), last = h(2), relocs = h(6), hdr = h(8) * 16;
    const size = pages * 512 - (last ? 512 - last : 0) - hdr;

    const env = this.alloc(0x20, 0).seg;
    const envText = 'COMSPEC=C:\\COMMAND.COM\0PATH=C:\\\0\0\x01\0C:\\LHX\\' + name.toUpperCase() + '\0';
    for (let i = 0; i < envText.length; i++) this.mem[env * 16 + i] = envText.charCodeAt(i);

    const largest = this.alloc(0xffff, 0).largest;
    const psp = this.alloc(largest, 0).seg;
    cpu.ww(psp - 1, 1, psp); cpu.ww(env - 1, 1, psp);
    this.psp = psp;
    const load = psp + 0x10;
    this.mem.set(data.subarray(hdr, hdr + size), load * 16);
    for (let i = 0; i < relocs; i++) {
      const o = h(24) + i * 4, off = h(o), seg = h(o + 2);
      cpu.ww(load + seg, off, (cpu.rw(load + seg, off) + load) & 0xffff);
    }
    // program segment prefix
    const p = psp * 16;
    this.mem[p] = 0xcd; this.mem[p + 1] = 0x20;
    cpu.ww(psp, 2, MEM_TOP);
    cpu.ww(psp, 0x16, psp);
    for (let i = 0; i < 20; i++) this.mem[p + 0x18 + i] = i < 3 ? 1 : i < 5 ? 2 - (i === 3 ? 2 : 0) : 0xff;
    cpu.ww(psp, 0x2c, env);
    cpu.ww(psp, 0x32, 20); cpu.ww(psp, 0x34, 0x18); cpu.ww(psp, 0x36, psp);
    this.mem.set([0xcd, 0x21, 0xcb], p + 0x50);
    this.mem.fill(0x20, p + 0x5d, p + 0x68); this.mem.fill(0x20, p + 0x6d, p + 0x78);
    const t = ' ' + tail;
    this.mem[p + 0x80] = t.length;
    for (let i = 0; i < t.length; i++) this.mem[p + 0x81 + i] = t.charCodeAt(i);
    this.mem[p + 0x81 + t.length] = 13;
    this.dta = [psp, 0x80];

    cpu.s[SS] = load + h(14); cpu.r[SP] = h(16);
    cpu.s[CS] = load + h(22); cpu.ip = h(20);
    cpu.s[DS] = cpu.s[ES] = psp;
    cpu.r[AX] = 0; cpu.r[BX] = 0; cpu.r[CX] = 0xff; cpu.r[DX] = psp; cpu.r[SI] = cpu.ip; cpu.r[DI] = cpu.r[SP]; cpu.r[BP] = 0x91c;
    cpu.if_ = 1;
    return { psp, load };
  }

  // ---------------------------------------------------------------- helpers
  str(seg, off) {
    let s = '';
    for (let i = 0; i < 128; i++) {
      const c = this.cpu.rb(seg, off + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  key(path) { return path.replace(/^.*[\\/:]/, '').toUpperCase(); }
  // the interrupted program's flags live in the IRET frame on the stack
  frameFlags(set, bit, on) {
    const cpu = this.cpu, a = cpu.r[SP] + 4;
    let f = cpu.rw(cpu.s[SS], a);
    f = on ? f | bit : f & ~bit;
    cpu.ww(cpu.s[SS], a, f);
  }
  setCF(on) { this.frameFlags(true, 1, on); }
  setZF(on) { this.frameFlags(true, 0x40, on); }
  ok() { this.setCF(false); }
  fail(code) { this.cpu.r[AX] = code; this.setCF(true); }

  // ---------------------------------------------------------------- dispatch
  service(n) {
    const cpu = this.cpu;
    const ah = cpu.r[AX] >> 8;
    const key = n === 0x21 || n === 0x10 || n === 0x16 ? `${n.toString(16)}/${ah.toString(16)}` : n.toString(16);
    this.calls.set(key, (this.calls.get(key) || 0) + 1);
    switch (n) {
      case 0x08: return;                 // reached only if a program chains to the stub directly
      case 0x09: return this.keyboardIRQ();
      case 0x10: return this.video();
      case 0x11: cpu.r[AX] = cpu.rw(0x40, 0x10); return;
      case 0x12: cpu.r[AX] = 640; return;
      case 0x15: cpu.setR8(4, 0x86); this.setCF(true); return;
      case 0x16: return this.keyboard();
      case 0x1a: return this.clock();
      case 0x20: this.pc.exited = 0; return;
      case 0x21: return this.dos();
      case 0x2f: if ((cpu.r[AX] & 0xff00) === 0x1600) cpu.r[AX] &= 0xff00; else cpu.setR8(0, 0); return;
      case 0x33: if (cpu.r[AX] === 0) { cpu.r[AX] = 0; cpu.r[BX] = 0; } return;
      case 0x00: this.pc.log(`divide error at ${cpu.rw(cpu.s[SS], cpu.r[SP] + 2).toString(16)}:${cpu.rw(cpu.s[SS], cpu.r[SP]).toString(16)}`); return;
      case 0x1b: case 0x1c: case 0x23: case 0x24: case 0x28: return;
    }
    if (!this.calls.has('warned' + n)) {
      this.calls.set('warned' + n, 1);
      this.pc.log(`unhandled interrupt ${n.toString(16)} AX=${cpu.r[AX].toString(16)}`);
    }
  }

  // ---------------------------------------------------------------- INT 9 / 16h keyboard
  keyboardIRQ() {
    const cpu = this.cpu, sc = this.pc.port60;
    const flags = cpu.rb(0x40, 0x17);
    const shiftBits = { 0x2a: 2, 0x36: 1, 0x1d: 4, 0x38: 8 };
    if (sc === 0xe0) { this.extended = true; this.pc.eoi(); return; }
    const make = !(sc & 0x80), code = sc & 0x7f;
    if (shiftBits[code]) {
      cpu.wb(0x40, 0x17, make ? flags | shiftBits[code] : flags & ~shiftBits[code]);
    } else if (make) {
      const shifted = flags & 3, ctrl = flags & 4;
      let ascii = 0;
      if (!this.extended && ASCII[code]) ascii = ASCII[code][shifted ? 1 : 0];
      if (ctrl && ascii >= 0x61 && ascii <= 0x7a) ascii -= 0x60;
      this.pushKey(code << 8 | ascii);
    }
    this.extended = false;
    this.pc.eoi();
  }
  pushKey(word) {
    const cpu = this.cpu, head = cpu.rw(0x40, 0x1a), tail = cpu.rw(0x40, 0x1c);
    const next = tail + 2 >= 0x3e ? 0x1e : tail + 2;
    if (next === head) return;
    cpu.ww(0x40, tail, word); cpu.ww(0x40, 0x1c, next);
  }
  popKey(remove) {
    const cpu = this.cpu, head = cpu.rw(0x40, 0x1a), tail = cpu.rw(0x40, 0x1c);
    if (head === tail) return -1;
    const word = cpu.rw(0x40, head);
    if (remove) cpu.ww(0x40, 0x1a, head + 2 >= 0x3e ? 0x1e : head + 2);
    return word;
  }
  keyboard() {
    const cpu = this.cpu, ah = cpu.r[AX] >> 8;
    switch (ah) {
      case 0x00: case 0x10: {
        const k = this.popKey(true);
        if (k < 0) { this.block(); return; }
        cpu.r[AX] = k; return;
      }
      case 0x01: case 0x11: {
        const k = this.popKey(false);
        if (k < 0) this.setZF(true); else { cpu.r[AX] = k; this.setZF(false); }
        return;
      }
      case 0x02: case 0x12: cpu.setR8(0, cpu.rb(0x40, 0x17)); return;
      case 0x05: this.pushKey(cpu.r[CX]); cpu.setR8(0, 0); return;
    }
  }
  // Wait for a hardware interrupt, then run the same service again (see install()).
  block() {
    this.blocked = true;
    this.cpu.if_ = 1;
    this.cpu.halted = true;
  }

  clock() {
    const cpu = this.cpu, ah = cpu.r[AX] >> 8;
    const bcd = v => ((v / 10 | 0) << 4) | (v % 10);
    const t = this.now();
    switch (ah) {
      case 0x00: cpu.r[CX] = cpu.rw(0x40, 0x6e); cpu.r[DX] = cpu.rw(0x40, 0x6c); cpu.setR8(0, 0); return;
      case 0x02: cpu.r[CX] = bcd(t.getHours()) << 8 | bcd(t.getMinutes()); cpu.r[DX] = bcd(t.getSeconds()) << 8; this.setCF(false); return;
      case 0x04: cpu.r[CX] = bcd(t.getFullYear() / 100 | 0) << 8 | bcd(t.getFullYear() % 100); cpu.r[DX] = bcd(t.getMonth() + 1) << 8 | bcd(t.getDate()); this.setCF(false); return;
    }
  }

  // ---------------------------------------------------------------- INT 10h video
  setMode(mode) {
    const pc = this.pc, cpu = this.cpu, clear = !(mode & 0x80);
    mode &= 0x7f;
    pc.mode = mode;
    this.mem[0x449] = mode;
    if (mode === 0x13) {
      if (clear) this.mem.fill(0, 0xa0000, 0xa0000 + 65536);
      const ega = [0, 0, 0, 0, 0, 42, 0, 42, 0, 0, 42, 42, 42, 0, 0, 42, 0, 42, 42, 21, 0, 42, 42, 42,
        21, 21, 21, 21, 21, 63, 21, 63, 21, 21, 63, 63, 63, 21, 21, 63, 21, 63, 63, 63, 21, 63, 63, 63];
      pc.dac.fill(0); pc.dac.set(ega);
      cpu.ww(0x40, 0x4a, 40);
    } else {
      if (clear) for (let i = 0; i < 80 * 25; i++) cpu.ww(0xb800, i * 2, 0x0720);
      cpu.ww(0x40, 0x4a, 80);
      this.cursor = [0, 0];
    }
    this.pc.log(`video mode ${mode.toString(16)}`);
  }
  teletype(c) {
    const cpu = this.cpu;
    let [x, y] = this.cursor;
    this.out(String.fromCharCode(c));
    if (this.pc.mode !== 3 && this.pc.mode !== 2) return;
    if (c === 13) x = 0;
    else if (c === 10) y++;
    else if (c === 8) x = Math.max(0, x - 1);
    else if (c === 7) { /* bell */ }
    else { cpu.wb(0xb800, (y * 80 + x) * 2, c); if (++x >= 80) { x = 0; y++; } }
    if (y >= 25) {
      this.mem.copyWithin(0xb8000, 0xb8000 + 160, 0xb8000 + 4000);
      for (let i = 0; i < 80; i++) cpu.ww(0xb800, (24 * 80 + i) * 2, 0x0720);
      y = 24;
    }
    this.cursor = [x, y];
  }
  video() {
    const cpu = this.cpu, pc = this.pc, ah = cpu.r[AX] >> 8, al = cpu.r[AX] & 0xff;
    switch (ah) {
      case 0x00: this.setMode(al); return;
      case 0x02: this.cursor = [cpu.r[DX] & 0xff, cpu.r[DX] >> 8]; return;
      case 0x03: cpu.r[DX] = this.cursor[1] << 8 | this.cursor[0]; cpu.r[CX] = 0x0607; return;
      case 0x06: case 0x07: return;
      case 0x08: cpu.r[AX] = 0x0720; return;
      case 0x09: case 0x0a: for (let i = 0; i < cpu.r[CX]; i++) cpu.wb(0xb800, (this.cursor[1] * 80 + this.cursor[0] + i) * 2, al); return;
      case 0x0b: return;
      case 0x0c: if (pc.mode === 0x13) this.mem[0xa0000 + (cpu.r[DX] * 320 + cpu.r[CX])] = al; return;
      case 0x0d: cpu.setR8(0, pc.mode === 0x13 ? this.mem[0xa0000 + (cpu.r[DX] * 320 + cpu.r[CX])] : 0); return;
      case 0x0e: this.teletype(al); return;
      case 0x0f: cpu.r[AX] = (cpu.rw(0x40, 0x4a) << 8) | pc.mode; cpu.setR8(7, 0); return;
      case 0x10:
        switch (al) {
          case 0x10: { const i = cpu.r[BX] & 0xff; pc.dac[i * 3] = cpu.r[DX] >> 8 & 63; pc.dac[i * 3 + 1] = cpu.r[CX] >> 8 & 63; pc.dac[i * 3 + 2] = cpu.r[CX] & 63; return; }
          case 0x12: for (let i = 0; i < cpu.r[CX] * 3; i++) pc.dac[(cpu.r[BX] * 3 + i) % 768] = cpu.rb(cpu.s[ES], cpu.r[DX] + i) & 63; return;
          case 0x15: { const i = cpu.r[BX] & 0xff; cpu.setR8(6, pc.dac[i * 3]); cpu.setR8(5, pc.dac[i * 3 + 1]); cpu.setR8(1, pc.dac[i * 3 + 2]); return; }
          case 0x17: for (let i = 0; i < cpu.r[CX] * 3; i++) cpu.wb(cpu.s[ES], cpu.r[DX] + i, pc.dac[(cpu.r[BX] * 3 + i) % 768]); return;
          case 0x1a: cpu.r[BX] = 0; return;
        }
        return;
      case 0x11: if (al === 0x30) { cpu.s[ES] = ROM; cpu.r[BP] = 0x4000; cpu.r[CX] = 16; cpu.setR8(2, 24); } return;
      case 0x12: if ((cpu.r[BX] & 0xff) === 0x10) { cpu.r[BX] = 0x0003; cpu.r[CX] = 0x0009; } return;
      case 0x1a: if (al === 0) { cpu.setR8(0, 0x1a); cpu.r[BX] = 0x0008; } return;
    }
    if (!this.calls.has('warn10/' + ah)) { this.calls.set('warn10/' + ah, 1); this.pc.log(`unhandled INT 10h AH=${ah.toString(16)} AL=${al.toString(16)}`); }
  }

  // ---------------------------------------------------------------- INT 21h DOS
  dos() {
    const cpu = this.cpu, r = cpu.r, ah = r[AX] >> 8, al = r[AX] & 0xff;
    switch (ah) {
      case 0x00: this.pc.exited = 0; return;
      case 0x01: case 0x07: case 0x08: {
        const k = this.popKey(true);
        if (k < 0) { this.block(); return; }
        cpu.setR8(0, k & 0xff); if (ah === 0x01) this.teletype(k & 0xff); return;
      }
      case 0x02: this.teletype(r[DX] & 0xff); cpu.setR8(0, r[DX] & 0xff); return;
      case 0x06:
        if ((r[DX] & 0xff) === 0xff) {
          const k = this.popKey(true);
          if (k < 0) { this.setZF(true); cpu.setR8(0, 0); } else { this.setZF(false); cpu.setR8(0, k & 0xff); }
        } else this.teletype(r[DX] & 0xff);
        return;
      case 0x09: {
        for (let i = 0; i < 4096; i++) {
          const c = cpu.rb(cpu.s[DS], r[DX] + i);
          if (c === 0x24) break;
          this.teletype(c);
        }
        cpu.setR8(0, 0x24); return;
      }
      case 0x0b: cpu.setR8(0, this.popKey(false) < 0 ? 0 : 0xff); return;
      case 0x0c: { while (this.popKey(true) >= 0); r[AX] = (r[AX] & 0xff) << 8 | (r[AX] & 0xff); return this.dos(); }
      case 0x0d: return;
      case 0x0e: cpu.setR8(0, 3); return;
      case 0x19: cpu.setR8(0, 2); return;
      case 0x1a: this.dta = [cpu.s[DS], r[DX]]; return;
      case 0x25: cpu.ww(0, al * 4, r[DX]); cpu.ww(0, al * 4 + 2, cpu.s[DS]); return;
      case 0x2a: { const t = this.now(); r[CX] = t.getFullYear(); r[DX] = (t.getMonth() + 1) << 8 | t.getDate(); cpu.setR8(0, t.getDay()); return; }
      case 0x2c: { const t = this.now(); r[CX] = t.getHours() << 8 | t.getMinutes(); r[DX] = t.getSeconds() << 8 | (t.getMilliseconds() / 10 | 0); return; }
      case 0x2f: cpu.s[ES] = this.dta[0]; r[BX] = this.dta[1]; return;
      case 0x30: r[AX] = 0x0005; r[BX] = 0xff00; r[CX] = 0; return;
      case 0x33: if (al === 0) cpu.setR8(2, 0); return;
      case 0x35: r[BX] = cpu.rw(0, al * 4); cpu.s[ES] = cpu.rw(0, al * 4 + 2); return;
      case 0x36: r[AX] = 64; r[BX] = 0x7fff; r[CX] = 512; r[DX] = 0xffff; return;
      case 0x3b: this.ok(); return;
      case 0x3c: return this.open(this.str(cpu.s[DS], r[DX]), 2, true);
      case 0x3d: return this.open(this.str(cpu.s[DS], r[DX]), al & 3, false);
      case 0x3e: if (this.handles[r[BX]] || r[BX] < 5) { this.handles[r[BX]] = null; this.ok(); } else this.fail(6); return;
      case 0x3f: return this.read();
      case 0x40: return this.write();
      case 0x41: if (this.files.delete(this.key(this.str(cpu.s[DS], r[DX])))) this.ok(); else this.fail(2); return;
      case 0x42: return this.seek();
      case 0x43: if (this.files.has(this.key(this.str(cpu.s[DS], r[DX])))) { r[CX] = 0x20; this.ok(); } else this.fail(2); return;
      case 0x44: return this.ioctl();
      case 0x45: { const h = this.newHandle({ ...this.handles[r[BX]] }); r[AX] = h; this.ok(); return; }
      case 0x47: cpu.wb(cpu.s[DS], r[SI], 0); this.ok(); return;
      case 0x48: {
        const res = this.alloc(r[BX], this.psp || 8);
        if (res.error) { r[BX] = res.largest; this.fail(8); } else { r[AX] = res.seg; this.ok(); }
        return;
      }
      case 0x49: this.free(cpu.s[ES]); this.ok(); return;
      case 0x4a: {
        const res = this.resize(cpu.s[ES], r[BX]);
        if (res.error) { r[BX] = res.largest || 0; this.fail(res.error); } else this.ok();
        return;
      }
      case 0x4b: this.fail(2); return;
      case 0x4c: this.pc.exited = al; return;
      case 0x4d: r[AX] = 0; return;
      case 0x4e: return this.findFirst();
      case 0x4f: return this.findNext();
      case 0x51: case 0x62: r[BX] = this.psp; return;
      case 0x52: cpu.s[ES] = ROM; r[BX] = LIST_OF_LISTS + 2; return;  // word at ES:BX-2 = first MCB
      case 0x57: if (al === 0) { r[CX] = 0x6000; r[DX] = 0x1ee1; } this.ok(); return;
      case 0x58: r[AX] = 0; this.ok(); return;
      case 0x59: r[AX] = 2; r[BX] = 0x0101; r[CX] = 0; return;
    }
    if (!this.calls.has('warn21/' + ah)) { this.calls.set('warn21/' + ah, 1); this.pc.log(`unhandled INT 21h AH=${ah.toString(16)} AL=${al.toString(16)}`); }
    this.fail(1);
  }

  newHandle(f) {
    let h = 5;
    while (this.handles[h]) h++;
    this.handles[h] = f;
    return h;
  }
  open(path, mode, create) {
    const cpu = this.cpu, k = this.key(path);
    if (create) this.files.set(k, new Uint8Array(0));
    const data = this.files.get(k);
    if (!data) { this.pc.log(`open ${path}: not found`); this.fail(2); return; }
    cpu.r[AX] = this.newHandle({ name: k, pos: 0, mode: create ? 2 : mode });
    this.pc.log(`open ${path} -> ${cpu.r[AX]}`);
    this.ok();
  }
  read() {
    const cpu = this.cpu, r = cpu.r, f = this.handles[r[BX]];
    if (r[BX] === 0) { r[AX] = 0; this.ok(); return; }
    if (!f) { this.fail(6); return; }
    const data = this.files.get(f.name);
    const n = Math.max(0, Math.min(r[CX], data.length - f.pos));
    const base = cpu.s[DS] * 16 + r[DX];
    this.mem.set(data.subarray(f.pos, f.pos + n), base);
    if (this.onRead) this.onRead(f.name, f.pos, n);
    f.pos += n;
    r[AX] = n; this.ok();
  }
  write() {
    const cpu = this.cpu, r = cpu.r, f = this.handles[r[BX]];
    const bytes = this.mem.slice(cpu.s[DS] * 16 + r[DX], cpu.s[DS] * 16 + r[DX] + r[CX]);
    if (r[BX] === 1 || r[BX] === 2) { for (const c of bytes) this.teletype(c); r[AX] = r[CX]; this.ok(); return; }
    if (!f) { this.fail(6); return; }
    let data = this.files.get(f.name);
    if (f.pos + bytes.length > data.length) { const d = new Uint8Array(f.pos + bytes.length); d.set(data); data = d; this.files.set(f.name, data); }
    data.set(bytes, f.pos); f.pos += bytes.length;
    r[AX] = bytes.length; this.ok();
  }
  seek() {
    const cpu = this.cpu, r = cpu.r, f = this.handles[r[BX]];
    if (!f) { this.fail(6); return; }
    const off = ((r[CX] << 16) | r[DX]) >> 0;
    const size = this.files.get(f.name).length;
    const al = r[AX] & 0xff;
    f.pos = Math.max(0, al === 0 ? off >>> 0 : al === 1 ? f.pos + off : size + off);
    r[DX] = f.pos >>> 16; r[AX] = f.pos & 0xffff; this.ok();
  }
  ioctl() {
    const cpu = this.cpu, r = cpu.r, al = r[AX] & 0xff;
    if (al === 0) { r[DX] = r[BX] < 5 ? 0x80d3 : 0x0002; this.ok(); return; }
    if (al === 1) { this.ok(); return; }
    if (al === 8) { r[AX] = 1; this.ok(); return; }
    if (al === 0x0e) { cpu.setR8(0, 0); this.ok(); return; }
    this.fail(1);
  }
  findFirst() {
    const cpu = this.cpu, pattern = this.key(this.str(cpu.s[DS], cpu.r[DX]));
    const names = [...this.files.keys()].filter(n => wildcard(pattern, n)).sort();
    this.search = names;
    this.searchPos = 0;
    this.findNext();
  }
  findNext() {
    const cpu = this.cpu;
    if (!this.search || this.searchPos >= this.search.length) { this.fail(18); return; }
    const name = this.search[this.searchPos++];
    const [seg, off] = this.dta, size = this.files.get(name).length;
    cpu.wb(seg, off + 0x15, 0x20); cpu.ww(seg, off + 0x16, 0x6000); cpu.ww(seg, off + 0x18, 0x1ee1);
    cpu.ww(seg, off + 0x1a, size & 0xffff); cpu.ww(seg, off + 0x1c, size >>> 16);
    for (let i = 0; i < 13; i++) cpu.wb(seg, off + 0x1e + i, i < name.length ? name.charCodeAt(i) : 0);
    this.ok();
  }
}
