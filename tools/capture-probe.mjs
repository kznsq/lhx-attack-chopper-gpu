// Boots into flight and prints what the capture module sees for a few frames.
import { PC } from '../src/pc.js';
import { DOS } from '../src/dos.js';
import { Capture } from '../src/capture.js';
import { scancodes } from '../src/keys.js';

const [gameDir, beforeArg, keyArg = ''] = arguments;
const NAMES = ['LHX.EXE', 'LHX0.LIB', 'LHX1.LIB', 'LHX2.LIB', 'LHX3.LIB', 'LHX4.LIB'];
const files = {};
for (const n of NAMES) files[n] = read(`${gameDir}/${n}`, 'binary');
const pc = new PC({ ips: 8_000_000, log: () => {} });
const dos = new DOS(pc, files, { now: () => new Date(1990, 5, 1, 12, 0, 0) });
dos.loadExe('LHX.EXE', 'VGA KEYBOARD HIGH PCSOUND');
const frames = [];
const cap = new Capture(pc, (f) => frames.push(f));
const keys = keyArg ? keyArg.split(',').map(p => { const [t, k] = p.split(':'); return { t: Number(t), k }; }) : [];
while (pc.seconds < Number(beforeArg)) {
  while (keys.length && keys[0].t <= pc.seconds) { const k = keys.shift().k; pc.pressKey(scancodes(k, true)); pc.run(0.05); pc.pressKey(scancodes(k, false)); }
  pc.run(0.05);
}
print(`frames presented: ${cap.frames} in ${pc.seconds.toFixed(1)} s`);
for (const f of frames.slice(-2)) {
  print(`t=${f.time.toFixed(2)} view=${JSON.stringify(f.view)} objects=${f.objects.length}`);
  for (const o of f.objects) {
    const kinds = {};
    for (const p of o.prims) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
    const p0 = [...o.pts.slice(0, 3)].join(',');
    print(`   ${o.name.padEnd(10)} lod@${o.lod.toString(16)} pts=${o.pts.length / 3} prims=${JSON.stringify(kinds)} first=(${p0})`);
  }
}
const last = frames.filter(f => f.view.x1 - f.view.x0 === 320 && f.objects.length).pop();
writeFile(`${arguments[3] || '/tmp'}/frame.json`, JSON.stringify({ ...last, objects: last.objects.map(o => ({ ...o, pts: [...o.pts] })), palette: [...last.palette] }));
