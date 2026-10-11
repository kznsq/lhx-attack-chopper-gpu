// Real-mode x86 CPU: the 8086 instruction set plus the 80186 additions
// (PUSH imm, IMUL imm, shifts by imm, ENTER/LEAVE, PUSHA/POPA, INS/OUTS, BOUND).
// x87 escape opcodes decode and do nothing, so programs see no coprocessor.

export const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3;

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, p = 1;
  while (b) { p ^= b & 1; b >>= 1; }
  PARITY[i] = p;
}

export class CPUError extends Error {}

export class CPU {
  constructor(mem, io) {
    this.mem = mem;              // Uint8Array covering 1 MB + 64 KB (no A20 wrap)
    this.io = io;                // { in8(port), out8(port, value), in16, out16 }
    this.r = new Uint16Array(8);
    this.s = new Uint16Array(4);
    this.ip = 0;
    this.cf = 0; this.pf = 0; this.af = 0; this.zf = 0; this.sf = 0; this.of = 0;
    this.tf = 0; this.if_ = 0; this.df = 0;
    this.halted = false;
    this.cycles = 0;             // instructions executed
    // Hooks: a non-zero byte at a linear address runs hookFns.get(address)(cpu) before the
    // instruction there. A hook returns true when it has changed CS:IP itself; otherwise the
    // instruction at the address executes normally.
    this.hookFlags = new Uint8Array(0x110000);
    this.hookFns = new Map();
    this.irq = null;             // () => vector number or -1; polled while irqPending and IF are set
    this.irqPending = false;
    this.trace = new Uint32Array(256);
    this.tracePos = 0;
    this.segOverride = -1;
    this.rep = 0;
    // Write filter: CPU writes to linear addresses in [filterLo, filterLo + filterLen) are dropped.
    this.filterLo = 0;
    this.filterLen = 0;
  }

  hook(linear, fn) {
    this.hookFlags[linear] = 1;
    this.hookFns.set(linear, fn);
  }

  // ---------------------------------------------------------------- flags
  getFlags() {
    return 0xf002 | this.cf | this.pf << 2 | this.af << 4 | this.zf << 6 | this.sf << 7 |
      this.tf << 8 | this.if_ << 9 | this.df << 10 | this.of << 11;
  }
  setFlags(f) {
    this.cf = f & 1; this.pf = f >> 2 & 1; this.af = f >> 4 & 1; this.zf = f >> 6 & 1;
    this.sf = f >> 7 & 1; this.tf = f >> 8 & 1; this.if_ = f >> 9 & 1; this.df = f >> 10 & 1;
    this.of = f >> 11 & 1;
  }
  szp8(v) { this.zf = v === 0 ? 1 : 0; this.sf = v >> 7; this.pf = PARITY[v]; }
  szp16(v) { this.zf = v === 0 ? 1 : 0; this.sf = v >> 15; this.pf = PARITY[v & 0xff]; }

  // ---------------------------------------------------------------- memory
  rb(seg, off) { return this.mem[(seg << 4) + (off & 0xffff)]; }
  rw(seg, off) {
    const b = seg << 4;
    return this.mem[b + (off & 0xffff)] | this.mem[b + ((off + 1) & 0xffff)] << 8;
  }
  wb(seg, off, v) {
    const a = (seg << 4) + (off & 0xffff);
    if (a - this.filterLo >>> 0 < this.filterLen) return;
    this.mem[a] = v;
  }
  ww(seg, off, v) {
    const b = seg << 4, a0 = b + (off & 0xffff), a1 = b + ((off + 1) & 0xffff);
    if (a0 - this.filterLo >>> 0 >= this.filterLen) this.mem[a0] = v;
    if (a1 - this.filterLo >>> 0 >= this.filterLen) this.mem[a1] = v >> 8;
  }
  fetch8() { const v = this.mem[(this.s[CS] << 4) + this.ip]; this.ip = (this.ip + 1) & 0xffff; return v; }
  fetch16() { const v = this.rw(this.s[CS], this.ip); this.ip = (this.ip + 2) & 0xffff; return v; }
  fetchS8() { const v = this.fetch8(); return v & 0x80 ? v - 256 : v; }

  push(v) { this.r[SP] -= 2; this.ww(this.s[SS], this.r[SP], v); }
  pop() { const v = this.rw(this.s[SS], this.r[SP]); this.r[SP] += 2; return v; }

  // ---------------------------------------------------------------- registers
  getR8(i) { return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8; }
  setR8(i, v) {
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0x00ff) | (v & 0xff) << 8;
  }

  // ---------------------------------------------------------------- ModRM
  modrm() {
    const b = this.fetch8();
    this.mod = b >> 6; this.reg = b >> 3 & 7; this.rm = b & 7;
    if (this.mod === 3) return;
    const r = this.r;
    let off, seg = DS;
    switch (this.rm) {
      case 0: off = r[BX] + r[SI]; break;
      case 1: off = r[BX] + r[DI]; break;
      case 2: off = r[BP] + r[SI]; seg = SS; break;
      case 3: off = r[BP] + r[DI]; seg = SS; break;
      case 4: off = r[SI]; break;
      case 5: off = r[DI]; break;
      case 6:
        if (this.mod === 0) { off = this.fetch16(); } else { off = r[BP]; seg = SS; }
        break;
      case 7: off = r[BX]; break;
    }
    if (this.mod === 1) off += this.fetchS8();
    else if (this.mod === 2) off += this.fetch16();
    this.eaOff = off & 0xffff;
    this.eaSeg = this.segOverride >= 0 ? this.s[this.segOverride] : this.s[seg];
  }
  getRM8() { return this.mod === 3 ? this.getR8(this.rm) : this.rb(this.eaSeg, this.eaOff); }
  setRM8(v) { if (this.mod === 3) this.setR8(this.rm, v); else this.wb(this.eaSeg, this.eaOff, v); }
  getRM16() { return this.mod === 3 ? this.r[this.rm] : this.rw(this.eaSeg, this.eaOff); }
  setRM16(v) { if (this.mod === 3) this.r[this.rm] = v; else this.ww(this.eaSeg, this.eaOff, v); }
  dataSeg() { return this.segOverride >= 0 ? this.s[this.segOverride] : this.s[DS]; }

  // ---------------------------------------------------------------- ALU
  add8(a, b, c) {
    const t = a + b + c, v = t & 0xff;
    this.cf = t >> 8 & 1; this.af = (a ^ b ^ v) >> 4 & 1; this.of = ((a ^ v) & (b ^ v)) >> 7 & 1;
    this.szp8(v); return v;
  }
  add16(a, b, c) {
    const t = a + b + c, v = t & 0xffff;
    this.cf = t >> 16 & 1; this.af = (a ^ b ^ v) >> 4 & 1; this.of = ((a ^ v) & (b ^ v)) >> 15 & 1;
    this.szp16(v); return v;
  }
  sub8(a, b, c) {
    const t = a - b - c, v = t & 0xff;
    this.cf = t < 0 ? 1 : 0; this.af = (a ^ b ^ v) >> 4 & 1; this.of = ((a ^ b) & (a ^ v)) >> 7 & 1;
    this.szp8(v); return v;
  }
  sub16(a, b, c) {
    const t = a - b - c, v = t & 0xffff;
    this.cf = t < 0 ? 1 : 0; this.af = (a ^ b ^ v) >> 4 & 1; this.of = ((a ^ b) & (a ^ v)) >> 15 & 1;
    this.szp16(v); return v;
  }
  logic8(v) { this.cf = 0; this.of = 0; this.af = 0; this.szp8(v); return v; }
  logic16(v) { this.cf = 0; this.of = 0; this.af = 0; this.szp16(v); return v; }
  alu8(op, a, b) {
    switch (op) {
      case 0: return this.add8(a, b, 0);
      case 1: return this.logic8(a | b);
      case 2: return this.add8(a, b, this.cf);
      case 3: return this.sub8(a, b, this.cf);
      case 4: return this.logic8(a & b);
      case 5: case 7: return this.sub8(a, b, 0);
      case 6: return this.logic8(a ^ b);
    }
  }
  alu16(op, a, b) {
    switch (op) {
      case 0: return this.add16(a, b, 0);
      case 1: return this.logic16(a | b);
      case 2: return this.add16(a, b, this.cf);
      case 3: return this.sub16(a, b, this.cf);
      case 4: return this.logic16(a & b);
      case 5: case 7: return this.sub16(a, b, 0);
      case 6: return this.logic16(a ^ b);
    }
  }
  inc8(v) { const c = this.cf; v = this.add8(v, 1, 0); this.cf = c; return v; }
  dec8(v) { const c = this.cf; v = this.sub8(v, 1, 0); this.cf = c; return v; }
  inc16(v) { const c = this.cf; v = this.add16(v, 1, 0); this.cf = c; return v; }
  dec16(v) { const c = this.cf; v = this.sub16(v, 1, 0); this.cf = c; return v; }

  shift(op, v, n, w) {
    n &= 31;
    if (n === 0) return v;
    const bits = w ? 16 : 8, mask = w ? 0xffff : 0xff, top = w ? 15 : 7;
    switch (op) {
      case 0: // ROL
        for (let i = 0; i < n; i++) v = ((v << 1) | (v >> top)) & mask;
        this.cf = v & 1; this.of = (v >> top & 1) ^ this.cf; return v;
      case 1: // ROR
        for (let i = 0; i < n; i++) v = (v >> 1) | ((v & 1) << top);
        this.cf = v >> top & 1; this.of = (v >> top ^ v >> (top - 1)) & 1; return v;
      case 2: // RCL
        for (let i = 0; i < n; i++) { const c = v >> top & 1; v = ((v << 1) | this.cf) & mask; this.cf = c; }
        this.of = (v >> top & 1) ^ this.cf; return v;
      case 3: // RCR
        for (let i = 0; i < n; i++) { const c = v & 1; v = (v >> 1) | (this.cf << top); this.cf = c; }
        this.of = (v >> top ^ v >> (top - 1)) & 1; return v;
      case 4: case 6: // SHL / SAL
        this.cf = n <= bits ? (v << n) >> bits & 1 : 0;
        v = n < 32 ? (v << n) & mask : 0;
        this.of = (v >> top & 1) ^ this.cf; this.af = 0;
        w ? this.szp16(v) : this.szp8(v); return v;
      case 5: // SHR
        this.cf = n <= bits ? v >> (n - 1) & 1 : 0;
        this.of = n === 1 ? v >> top & 1 : 0;
        v = n < bits ? v >> n : 0; this.af = 0;
        w ? this.szp16(v) : this.szp8(v); return v;
      case 7: { // SAR
        const sv = w ? (v << 16) >> 16 : (v << 24) >> 24;
        const k = n > top ? top + 1 : n;
        this.cf = (sv >> (k - 1)) & 1;
        v = (sv >> Math.min(n, top)) & mask; this.of = 0; this.af = 0;
        w ? this.szp16(v) : this.szp8(v); return v;
      }
    }
  }

  // ---------------------------------------------------------------- interrupts
  interrupt(n) {
    this.push(this.getFlags());
    this.push(this.s[CS]);
    this.push(this.ip);
    this.if_ = 0; this.tf = 0;
    this.ip = this.rw(0, n * 4);
    this.s[CS] = this.rw(0, n * 4 + 2);
  }
  divideError(start) { this.ip = start; this.interrupt(0); }

  // ---------------------------------------------------------------- string ops
  strStep(w) { return this.df ? -(w ? 2 : 1) : (w ? 2 : 1); }

  stringOp(op) {
    const r = this.r, s = this.s, rep = this.rep;
    const w = op & 1, d = this.strStep(w);
    const src = this.dataSeg();
    if (rep && r[CX] === 0) return;
    for (;;) {
      switch (op) {
        case 0xa4: this.wb(s[ES], r[DI], this.rb(src, r[SI])); r[SI] += d; r[DI] += d; break;
        case 0xa5: this.ww(s[ES], r[DI], this.rw(src, r[SI])); r[SI] += d; r[DI] += d; break;
        case 0xa6: this.sub8(this.rb(src, r[SI]), this.rb(s[ES], r[DI]), 0); r[SI] += d; r[DI] += d; break;
        case 0xa7: this.sub16(this.rw(src, r[SI]), this.rw(s[ES], r[DI]), 0); r[SI] += d; r[DI] += d; break;
        case 0xaa: this.wb(s[ES], r[DI], r[AX]); r[DI] += d; break;
        case 0xab: this.ww(s[ES], r[DI], r[AX]); r[DI] += d; break;
        case 0xac: this.setR8(0, this.rb(src, r[SI])); r[SI] += d; break;
        case 0xad: r[AX] = this.rw(src, r[SI]); r[SI] += d; break;
        case 0xae: this.sub8(r[AX] & 0xff, this.rb(s[ES], r[DI]), 0); r[DI] += d; break;
        case 0xaf: this.sub16(r[AX], this.rw(s[ES], r[DI]), 0); r[DI] += d; break;
        case 0x6c: this.wb(s[ES], r[DI], this.io.in8(r[DX])); r[DI] += d; break;
        case 0x6d: this.ww(s[ES], r[DI], this.io.in16(r[DX])); r[DI] += d; break;
        case 0x6e: this.io.out8(r[DX], this.rb(src, r[SI])); r[SI] += d; break;
        case 0x6f: this.io.out16(r[DX], this.rw(src, r[SI])); r[SI] += d; break;
      }
      if (!rep) return;
      r[CX]--;
      if (r[CX] === 0) return;
      if (op === 0xa6 || op === 0xa7 || op === 0xae || op === 0xaf) {
        if (rep === 0xf3 && !this.zf) return;
        if (rep === 0xf2 && this.zf) return;
      }
    }
  }

  // ---------------------------------------------------------------- execution
  run(count) {
    const end = this.cycles + count;
    while (this.cycles < end) {
      if (this.irqPending && this.if_) {
        const v = this.irq();
        if (v >= 0) { this.halted = false; this.interrupt(v); }
      }
      if (this.halted) return;
      this.step();
    }
  }

  step() {
    const s = this.s, r = this.r;
    let lin = (s[CS] << 4) + this.ip;
    if (this.hookFlags[lin]) {
      if (this.hookFns.get(lin)(this)) return;
    }
    this.trace[this.tracePos++ & 255] = s[CS] << 16 | this.ip;
    this.cycles++;
    const start = this.ip;
    this.segOverride = -1; this.rep = 0;
    let op;
    for (;;) {
      op = this.fetch8();
      if (op === 0x26) this.segOverride = ES;
      else if (op === 0x2e) this.segOverride = CS;
      else if (op === 0x36) this.segOverride = SS;
      else if (op === 0x3e) this.segOverride = DS;
      else if (op === 0xf2 || op === 0xf3) this.rep = op;
      else if (op !== 0xf0) break;
    }
    if (op < 0x40 && (op & 7) < 6) {
      const alu = op >> 3;
      switch (op & 7) {
        case 0: { this.modrm(); const v = this.alu8(alu, this.getRM8(), this.getR8(this.reg)); if (alu !== 7) this.setRM8(v); return; }
        case 1: { this.modrm(); const v = this.alu16(alu, this.getRM16(), r[this.reg]); if (alu !== 7) this.setRM16(v); return; }
        case 2: { this.modrm(); const v = this.alu8(alu, this.getR8(this.reg), this.getRM8()); if (alu !== 7) this.setR8(this.reg, v); return; }
        case 3: { this.modrm(); const v = this.alu16(alu, r[this.reg], this.getRM16()); if (alu !== 7) r[this.reg] = v; return; }
        case 4: { const v = this.alu8(alu, r[AX] & 0xff, this.fetch8()); if (alu !== 7) this.setR8(0, v); return; }
        case 5: { const v = this.alu16(alu, r[AX], this.fetch16()); if (alu !== 7) r[AX] = v; return; }
      }
    }
    switch (op) {
      case 0x06: this.push(s[ES]); return;
      case 0x07: s[ES] = this.pop(); return;
      case 0x0e: this.push(s[CS]); return;
      case 0x16: this.push(s[SS]); return;
      case 0x17: s[SS] = this.pop(); return;
      case 0x1e: this.push(s[DS]); return;
      case 0x1f: s[DS] = this.pop(); return;
      case 0x27: { // DAA
        const al = r[AX] & 0xff, oc = this.cf;
        let v = al;
        if ((al & 0xf) > 9 || this.af) { v += 6; this.af = 1; } else this.af = 0;
        if (al > 0x99 || oc) { v += 0x60; this.cf = 1; } else this.cf = 0;
        this.setR8(0, v & 0xff); this.szp8(v & 0xff); return;
      }
      case 0x2f: { // DAS
        const al = r[AX] & 0xff, oc = this.cf;
        let v = al;
        if ((al & 0xf) > 9 || this.af) { v -= 6; this.af = 1; } else this.af = 0;
        if (al > 0x99 || oc) { v -= 0x60; this.cf = 1; } else this.cf = 0;
        this.setR8(0, v & 0xff); this.szp8(v & 0xff); return;
      }
      case 0x37: // AAA
        if ((r[AX] & 0xf) > 9 || this.af) { r[AX] += 0x106; this.af = this.cf = 1; } else this.af = this.cf = 0;
        this.setR8(0, r[AX] & 0xf); return;
      case 0x3f: // AAS
        if ((r[AX] & 0xf) > 9 || this.af) { r[AX] -= 6; this.setR8(4, (r[AX] >> 8) - 1); this.af = this.cf = 1; } else this.af = this.cf = 0;
        this.setR8(0, r[AX] & 0xf); return;
    }
    if (op >= 0x40 && op < 0x60) {
      const i = op & 7;
      if (op < 0x48) r[i] = this.inc16(r[i]);
      else if (op < 0x50) r[i] = this.dec16(r[i]);
      else if (op < 0x58) { if (i === SP) { const v = r[SP] - 2; this.push(v & 0xffff); } else this.push(r[i]); }
      else r[i] = this.pop();
      return;
    }
    if (op >= 0x70 && op < 0x80) {
      const d = this.fetchS8();
      if (this.cond(op & 15)) this.ip = (this.ip + d) & 0xffff;
      return;
    }
    if (op >= 0x91 && op <= 0x97) { const i = op & 7, t = r[i]; r[i] = r[AX]; r[AX] = t; return; }
    if (op >= 0xb0 && op <= 0xb7) { this.setR8(op & 7, this.fetch8()); return; }
    if (op >= 0xb8 && op <= 0xbf) { r[op & 7] = this.fetch16(); return; }
    if (op >= 0xd8 && op <= 0xdf) { this.modrm(); return; } // x87 escape: no coprocessor
    switch (op) {
      case 0x60: { const t = r[SP]; this.push(r[AX]); this.push(r[CX]); this.push(r[DX]); this.push(r[BX]); this.push(t); this.push(r[BP]); this.push(r[SI]); this.push(r[DI]); return; }
      case 0x61: r[DI] = this.pop(); r[SI] = this.pop(); r[BP] = this.pop(); this.pop(); r[BX] = this.pop(); r[DX] = this.pop(); r[CX] = this.pop(); r[AX] = this.pop(); return;
      case 0x62: this.modrm(); return; // BOUND: bounds are not checked
      case 0x68: this.push(this.fetch16()); return;
      case 0x69: case 0x6b: {
        this.modrm();
        const a = (this.getRM16() << 16) >> 16;
        const b = op === 0x69 ? (this.fetch16() << 16) >> 16 : this.fetchS8();
        const p = a * b;
        r[this.reg] = p & 0xffff;
        this.cf = this.of = (p < -32768 || p > 32767) ? 1 : 0; this.szp16(p & 0xffff);
        return;
      }
      case 0x6a: this.push(this.fetchS8() & 0xffff); return;
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: this.stringOp(op); return;
      case 0x80: case 0x82: { this.modrm(); const v = this.alu8(this.reg, this.getRM8(), this.fetch8()); if (this.reg !== 7) this.setRM8(v); return; }
      case 0x81: { this.modrm(); const v = this.alu16(this.reg, this.getRM16(), this.fetch16()); if (this.reg !== 7) this.setRM16(v); return; }
      case 0x83: { this.modrm(); const v = this.alu16(this.reg, this.getRM16(), this.fetchS8() & 0xffff); if (this.reg !== 7) this.setRM16(v); return; }
      case 0x84: this.modrm(); this.logic8(this.getRM8() & this.getR8(this.reg)); return;
      case 0x85: this.modrm(); this.logic16(this.getRM16() & r[this.reg]); return;
      case 0x86: { this.modrm(); const t = this.getRM8(); this.setRM8(this.getR8(this.reg)); this.setR8(this.reg, t); return; }
      case 0x87: { this.modrm(); const t = this.getRM16(); this.setRM16(r[this.reg]); r[this.reg] = t; return; }
      case 0x88: this.modrm(); this.setRM8(this.getR8(this.reg)); return;
      case 0x89: this.modrm(); this.setRM16(r[this.reg]); return;
      case 0x8a: this.modrm(); this.setR8(this.reg, this.getRM8()); return;
      case 0x8b: this.modrm(); r[this.reg] = this.getRM16(); return;
      case 0x8c: this.modrm(); this.setRM16(s[this.reg & 3]); return;
      case 0x8d: this.modrm(); r[this.reg] = this.eaOff; return;
      case 0x8e: this.modrm(); s[this.reg & 3] = this.getRM16(); return;
      case 0x8f: { const v = this.pop(); this.modrm(); this.setRM16(v); return; }
      case 0x90: return;
      case 0x98: r[AX] = (r[AX] & 0x80) ? r[AX] | 0xff00 : r[AX] & 0xff; return;
      case 0x99: r[DX] = (r[AX] & 0x8000) ? 0xffff : 0; return;
      case 0x9a: { const ip = this.fetch16(), cs = this.fetch16(); this.push(s[CS]); this.push(this.ip); s[CS] = cs; this.ip = ip; return; }
      case 0x9b: return;
      case 0x9c: this.push(this.getFlags()); return;
      case 0x9d: this.setFlags(this.pop()); return;
      case 0x9e: { const ah = r[AX] >> 8; this.cf = ah & 1; this.pf = ah >> 2 & 1; this.af = ah >> 4 & 1; this.zf = ah >> 6 & 1; this.sf = ah >> 7 & 1; return; }
      case 0x9f: this.setR8(4, this.getFlags() & 0xff); return;
      case 0xa0: this.setR8(0, this.rb(this.dataSeg(), this.fetch16())); return;
      case 0xa1: r[AX] = this.rw(this.dataSeg(), this.fetch16()); return;
      case 0xa2: this.wb(this.dataSeg(), this.fetch16(), r[AX]); return;
      case 0xa3: this.ww(this.dataSeg(), this.fetch16(), r[AX]); return;
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab:
      case 0xac: case 0xad: case 0xae: case 0xaf: this.stringOp(op); return;
      case 0xa8: this.logic8((r[AX] & 0xff) & this.fetch8()); return;
      case 0xa9: this.logic16(r[AX] & this.fetch16()); return;
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        this.modrm();
        const w = op & 1;
        const n = op <= 0xc1 ? this.fetch8() : op <= 0xd1 ? 1 : r[CX] & 0xff;
        if (w) this.setRM16(this.shift(this.reg, this.getRM16(), n, 1));
        else this.setRM8(this.shift(this.reg, this.getRM8(), n, 0));
        return;
      }
      case 0xc2: { const n = this.fetch16(); this.ip = this.pop(); r[SP] += n; return; }
      case 0xc3: this.ip = this.pop(); return;
      case 0xc4: case 0xc5: {
        this.modrm();
        r[this.reg] = this.rw(this.eaSeg, this.eaOff);
        s[op === 0xc4 ? ES : DS] = this.rw(this.eaSeg, this.eaOff + 2);
        return;
      }
      case 0xc6: this.modrm(); this.setRM8(this.fetch8()); return;
      case 0xc7: this.modrm(); this.setRM16(this.fetch16()); return;
      case 0xc8: { // ENTER
        const size = this.fetch16(), level = this.fetch8() & 31;
        this.push(r[BP]);
        const frame = r[SP];
        for (let i = 1; i < level; i++) { r[BP] -= 2; this.push(this.rw(s[SS], r[BP])); }
        if (level > 0) this.push(frame);
        r[BP] = frame; r[SP] -= size;
        return;
      }
      case 0xc9: r[SP] = r[BP]; r[BP] = this.pop(); return;
      case 0xca: { const n = this.fetch16(); this.ip = this.pop(); s[CS] = this.pop(); r[SP] += n; return; }
      case 0xcb: this.ip = this.pop(); s[CS] = this.pop(); return;
      case 0xcc: this.interrupt(3); return;
      case 0xcd: this.interrupt(this.fetch8()); return;
      case 0xce: if (this.of) this.interrupt(4); return;
      case 0xcf: this.ip = this.pop(); s[CS] = this.pop(); this.setFlags(this.pop()); return;
      case 0xd4: { // AAM
        const b = this.fetch8();
        if (b === 0) { this.divideError(start); return; }
        const al = r[AX] & 0xff;
        r[AX] = ((al / b | 0) << 8) | (al % b); this.szp8(r[AX] & 0xff); return;
      }
      case 0xd5: { // AAD
        const b = this.fetch8();
        const v = ((r[AX] >> 8) * b + (r[AX] & 0xff)) & 0xff;
        r[AX] = v; this.szp8(v); return;
      }
      case 0xd6: this.setR8(0, this.cf ? 0xff : 0); return;
      case 0xd7: this.setR8(0, this.rb(this.dataSeg(), r[BX] + (r[AX] & 0xff))); return;
      case 0xe0: case 0xe1: case 0xe2: {
        const d = this.fetchS8();
        r[CX]--;
        const go = r[CX] !== 0 && (op === 0xe2 || (op === 0xe1 ? this.zf : !this.zf));
        if (go) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe3: { const d = this.fetchS8(); if (r[CX] === 0) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: this.setR8(0, this.io.in8(this.fetch8())); return;
      case 0xe5: r[AX] = this.io.in16(this.fetch8()); return;
      case 0xe6: this.io.out8(this.fetch8(), r[AX] & 0xff); return;
      case 0xe7: this.io.out16(this.fetch8(), r[AX]); return;
      case 0xe8: { const d = this.fetch16(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fetch16(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const ip = this.fetch16(); s[CS] = this.fetch16(); this.ip = ip; return; }
      case 0xeb: { const d = this.fetchS8(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xec: this.setR8(0, this.io.in8(r[DX])); return;
      case 0xed: r[AX] = this.io.in16(r[DX]); return;
      case 0xee: this.io.out8(r[DX], r[AX] & 0xff); return;
      case 0xef: this.io.out16(r[DX], r[AX]); return;
      case 0xf4: this.halted = true; return;
      case 0xf5: this.cf ^= 1; return;
      case 0xf6: case 0xf7: this.group3(op & 1, start); return;
      case 0xf8: this.cf = 0; return;
      case 0xf9: this.cf = 1; return;
      case 0xfa: this.if_ = 0; return;
      case 0xfb: this.if_ = 1; return;
      case 0xfc: this.df = 0; return;
      case 0xfd: this.df = 1; return;
      case 0xfe: {
        this.modrm();
        if (this.reg === 0) this.setRM8(this.inc8(this.getRM8()));
        else if (this.reg === 1) this.setRM8(this.dec8(this.getRM8()));
        else this.bad(op, start);
        return;
      }
      case 0xff: {
        this.modrm();
        switch (this.reg) {
          case 0: this.setRM16(this.inc16(this.getRM16())); return;
          case 1: this.setRM16(this.dec16(this.getRM16())); return;
          case 2: { const t = this.getRM16(); this.push(this.ip); this.ip = t; return; }
          case 3: {
            const ip = this.rw(this.eaSeg, this.eaOff), cs = this.rw(this.eaSeg, this.eaOff + 2);
            this.push(s[CS]); this.push(this.ip); s[CS] = cs; this.ip = ip; return;
          }
          case 4: this.ip = this.getRM16(); return;
          case 5: { const ip = this.rw(this.eaSeg, this.eaOff); s[CS] = this.rw(this.eaSeg, this.eaOff + 2); this.ip = ip; return; }
          case 6: this.push(this.getRM16()); return;
        }
        this.bad(op, start); return;
      }
    }
    this.bad(op, start);
  }

  group3(w, start) {
    const r = this.r;
    this.modrm();
    switch (this.reg) {
      case 0: case 1:
        if (w) this.logic16(this.getRM16() & this.fetch16()); else this.logic8(this.getRM8() & this.fetch8());
        return;
      case 2: if (w) this.setRM16(~this.getRM16() & 0xffff); else this.setRM8(~this.getRM8() & 0xff); return;
      case 3:
        if (w) { const v = this.getRM16(); this.setRM16(this.sub16(0, v, 0)); this.cf = v ? 1 : 0; }
        else { const v = this.getRM8(); this.setRM8(this.sub8(0, v, 0)); this.cf = v ? 1 : 0; }
        return;
      case 4:
        if (w) { const p = r[AX] * this.getRM16(); r[AX] = p & 0xffff; r[DX] = p >>> 16; this.cf = this.of = r[DX] ? 1 : 0; }
        else { const p = (r[AX] & 0xff) * this.getRM8(); r[AX] = p; this.cf = this.of = (p >> 8) ? 1 : 0; }
        return;
      case 5:
        if (w) {
          const p = ((r[AX] << 16) >> 16) * ((this.getRM16() << 16) >> 16);
          r[AX] = p & 0xffff; r[DX] = (p >> 16) & 0xffff; this.cf = this.of = (p < -32768 || p > 32767) ? 1 : 0;
        } else {
          const p = ((r[AX] << 24) >> 24) * ((this.getRM8() << 24) >> 24);
          r[AX] = p & 0xffff; this.cf = this.of = (p < -128 || p > 127) ? 1 : 0;
        }
        return;
      case 6:
        if (w) {
          const d = this.getRM16(), n = (r[DX] * 65536 + r[AX]);
          if (d === 0) { this.divideError(start); return; }
          const q = Math.floor(n / d);
          if (q > 0xffff) { this.divideError(start); return; }
          r[AX] = q; r[DX] = n % d;
        } else {
          const d = this.getRM8(), n = r[AX];
          if (d === 0) { this.divideError(start); return; }
          const q = (n / d) | 0;
          if (q > 0xff) { this.divideError(start); return; }
          r[AX] = (n % d) << 8 | q;
        }
        return;
      case 7:
        if (w) {
          const d = (this.getRM16() << 16) >> 16, n = (r[DX] << 16) | r[AX];
          if (d === 0) { this.divideError(start); return; }
          const q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) { this.divideError(start); return; }
          r[AX] = q & 0xffff; r[DX] = (n - q * d) & 0xffff;
        } else {
          const d = (this.getRM8() << 24) >> 24, n = (r[AX] << 16) >> 16;
          if (d === 0) { this.divideError(start); return; }
          const q = Math.trunc(n / d);
          if (q > 127 || q < -128) { this.divideError(start); return; }
          r[AX] = ((n - q * d) & 0xff) << 8 | (q & 0xff);
        }
        return;
    }
  }

  cond(c) {
    switch (c) {
      case 0: return this.of;
      case 1: return !this.of;
      case 2: return this.cf;
      case 3: return !this.cf;
      case 4: return this.zf;
      case 5: return !this.zf;
      case 6: return this.cf || this.zf;
      case 7: return !this.cf && !this.zf;
      case 8: return this.sf;
      case 9: return !this.sf;
      case 10: return this.pf;
      case 11: return !this.pf;
      case 12: return this.sf !== this.of;
      case 13: return this.sf === this.of;
      case 14: return this.zf || this.sf !== this.of;
      case 15: return !this.zf && this.sf === this.of;
    }
  }

  bad(op, start) {
    this.ip = start;
    throw new CPUError(`unimplemented opcode ${op.toString(16)} at ${this.s[CS].toString(16)}:${start.toString(16)}`);
  }

  where() { return `${this.s[CS].toString(16).padStart(4, '0')}:${this.ip.toString(16).padStart(4, '0')}`; }
}
