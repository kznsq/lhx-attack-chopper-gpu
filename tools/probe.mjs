// Discovery runner: boots LHX into flight with a key script, then reports which code writes to
// video memory (string instructions with ES = A000h) during a window of emulated time.
//   jsc -m tools/probe.mjs -- <game dir> <seconds before probe> <probe seconds> [key script]

import { PC } from '../src/pc.js';
import { DOS } from '../src/dos.js';
import { scancodes } from '../src/keys.js';

const [gameDir, beforeArg, probeArg, keyArg = ''] = arguments;
const NAMES = ['LHX.EXE', 'LHX0.LIB', 'LHX1.LIB', 'LHX2.LIB', 'LHX3.LIB', 'LHX4.LIB'];
const files = {};
for (const n of NAMES) files[n] = read(`${gameDir}/${n}`, 'binary');
const pc = new PC({ ips: 8_000_000, log: () => {} });
const dos = new DOS(pc, files, { now: () => new Date(1990, 5, 1, 12, 0, 0) });
dos.loadExe('LHX.EXE', 'VGA KEYBOARD HIGH PCSOUND');
const keys = keyArg ? keyArg.split(',').map(p => { const [t, k] = p.split(':'); return { t: Number(t), k }; }) : [];

const runTo = (t) => {
  while (pc.seconds < t) {
    while (keys.length && keys[0].t <= pc.seconds) {
      const k = keys.shift().k;
      pc.pressKey(scancodes(k, true)); pc.run(0.05); pc.pressKey(scancodes(k, false));
    }
    pc.run(0.05);
  }
};
runTo(Number(beforeArg));

const cpu = pc.cpu, hits = new Map(), sizes = new Map();
const orig = cpu.stringOp.bind(cpu);
cpu.stringOp = (op) => {
  if (cpu.s[0] === 0xa000) {
    const at = `${(cpu.s[1]).toString(16)}:${cpu.ip.toString(16)} op=${op.toString(16)} rep=${cpu.rep ? 1 : 0}`;
    hits.set(at, (hits.get(at) || 0) + 1);
    sizes.set(at, (sizes.get(at) || 0) + (cpu.rep ? cpu.r[1] : 1));
  }
  orig(op);
};
const frames0 = cpu.cycles;
runTo(Number(beforeArg) + Number(probeArg));
const rows = [...hits].sort((a, b) => sizes.get(b[0]) - sizes.get(a[0]));
for (const [k, n] of rows.slice(0, 25)) print(`${k}  calls=${n}  units=${sizes.get(k)}`);
print(`image offset = linear - 0x8110; CS 17e2 = image segment fd1`);
