// Headless runner for the JavaScriptCore shell (macOS: /System/Library/Frameworks/
// JavaScriptCore.framework/Versions/A/Helpers/jsc). Runs LHX for a number of emulated seconds,
// optionally typing keys, and writes screenshots as PPM files.
//
//   jsc -m tools/run.mjs -- <game dir> <out dir> <seconds> [key script]
//
// key script: comma-separated "time:key" pairs, e.g. "3:enter,4.5:space" (seconds of emulated time).

import { PC } from '../src/pc.js';
import { DOS } from '../src/dos.js';
import { CPUError } from '../src/cpu.js';
import { scancodes } from '../src/keys.js';

const [gameDir, outDir, secondsArg, keyArg = ''] = arguments;
const seconds = Number(secondsArg || 5);
const NAMES = ['LHX.EXE', 'LHX0.LIB', 'LHX1.LIB', 'LHX2.LIB', 'LHX3.LIB', 'LHX4.LIB', 'README', 'START.BAT'];
const files = {};
for (const n of NAMES) files[n] = read(`${gameDir}/${n}`, 'binary');

const logLines = [];
const log = (s) => { logLines.push(`[${pc.seconds.toFixed(3)}] ${s}`); print(`[${pc.seconds.toFixed(3)}] ${s}`); };
const pc = new PC({ ips: 8_000_000, log });
let text = '';
const dos = new DOS(pc, files, { now: () => new Date(1990, 5, 1, 12, 0, 0), console: (c) => { text += c; } });
const { psp, load } = dos.loadExe('LHX.EXE', 'VGA KEYBOARD HIGH PCSOUND');
log(`loaded PSP=${psp.toString(16)} image=${load.toString(16)} entry=${pc.cpu.where()}`);

const keys = keyArg ? keyArg.split(',').map(p => { const [t, k] = p.split(':'); return { t: Number(t), k }; }) : [];
const hex = (v, n = 4) => v.toString(16).padStart(n, '0');
const regs = () => {
  const c = pc.cpu, r = c.r, s = c.s;
  return `AX=${hex(r[0])} BX=${hex(r[3])} CX=${hex(r[1])} DX=${hex(r[2])} SI=${hex(r[6])} DI=${hex(r[7])} BP=${hex(r[5])} SP=${hex(r[4])} ` +
    `DS=${hex(s[3])} ES=${hex(s[0])} SS=${hex(s[2])} CS:IP=${c.where()} flags=${hex(c.getFlags())}`;
};

function screenshot(name) {
  const rgba = pc.frame(new Uint8Array(320 * 200 * 4));
  if (!rgba) { print('--- text screen ---\n' + pc.textScreen()); return; }
  const head = 'P6\n320 200\n255\n';
  const out = new Uint8Array(head.length + 320 * 200 * 3);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  for (let i = 0, o = head.length; i < 64000; i++, o += 3) out.set(rgba.subarray(i * 4, i * 4 + 3), o);
  writeFile(`${outDir}/${name}.ppm`, out);
}

const t0 = preciseTime();
let shot = 0, nextShot = 1;
try {
  while (pc.seconds < seconds && pc.exited === null) {
    while (keys.length && keys[0].t <= pc.seconds) {
      const k = keys.shift().k;
      pc.pressKey(scancodes(k, true)); pc.run(0.05); pc.pressKey(scancodes(k, false));
      log(`key ${k}`);
    }
    pc.run(0.05);
    if (pc.seconds >= nextShot) { screenshot(`shot${String(shot++).padStart(3, '0')}`); nextShot += 1; }
  }
} catch (e) {
  log(`STOP: ${e.message}`);
  if (!(e instanceof CPUError)) print(e.stack);
}
const t1 = preciseTime();
screenshot('final');
log(regs());
const c = pc.cpu;
const trail = [];
for (let i = 1; i <= 24; i++) { const v = c.trace[(c.tracePos - i) & 255]; trail.push(`${hex(v >>> 16)}:${hex(v & 0xffff)}`); }
print('last instructions (newest first): ' + trail.join(' '));
print('services: ' + JSON.stringify(Object.fromEntries([...dos.calls].filter(([k]) => !k.startsWith('warn')))));
print(`exited=${pc.exited} mode=${pc.mode.toString(16)} emulated=${pc.seconds.toFixed(2)}s wall=${(t1 - t0).toFixed(2)}s instructions=${c.cycles}`);
if (text) print('--- console output ---\n' + text);
