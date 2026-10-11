import { PC } from '../src/pc.js';
import { DOS } from '../src/dos.js';
import { scancodes } from '../src/keys.js';
import { Capture } from '../src/capture.js';
import { Composite, KEY } from '../src/composite.js';
import { watchTheatre } from '../src/theatre.js';
import { Reach } from '../src/reach.js';
import { GPUView } from './gpu.js';

const NAMES = ['LHX.EXE', 'LHX0.LIB', 'LHX1.LIB', 'LHX2.LIB', 'LHX3.LIB', 'LHX4.LIB'];
const ARGS = 'VGA KEYBOARD HIGH PCSOUND';

const $ = (id) => document.getElementById(id);
const raw = $('raw'), rawCtx = raw.getContext('2d');
const image = rawCtx.createImageData(320, 200);
const text = $('text'), status = $('status');

async function fromServer() {
  const files = {};
  for (const n of NAMES) {
    const r = await fetch(`game/${n}`);
    if (!r.ok) return null;
    files[n] = new Uint8Array(await r.arrayBuffer());
  }
  return files;
}

function fromFolder() {
  $('loader').hidden = false;
  return new Promise((resolve) => {
    $('folder').addEventListener('change', async (e) => {
      const files = {};
      for (const f of e.target.files) {
        const n = f.name.toUpperCase();
        if (NAMES.includes(n)) files[n] = new Uint8Array(await f.arrayBuffer());
      }
      const missing = NAMES.filter(n => !files[n]);
      if (missing.length) { status.textContent = `missing: ${missing.join(', ')}`; return; }
      $('loader').hidden = true;
      resolve(files);
    });
  });
}

// PC speaker: a square wave at the timer channel 2 frequency while the speaker gate is open
function speaker(pc) {
  const ac = new AudioContext();
  const osc = ac.createOscillator(), gain = ac.createGain();
  osc.type = 'square'; gain.gain.value = 0;
  osc.connect(gain).connect(ac.destination); osc.start();
  return {
    update() {
      const f = 1193182 / (pc.pit[2].reload || 0x10000);
      const on = (pc.port61 & 3) === 3 && f > 20 && f < 20000;
      if (on) osc.frequency.setTargetAtTime(f, ac.currentTime, 0.002);
      gain.gain.setTargetAtTime(on ? 0.04 : 0, ac.currentTime, 0.002);
    },
    stop() { osc.stop(); ac.close(); },
  };
}

async function main() {
  const files = (await fromServer()) || (await fromFolder());
  const pc = new PC({ ips: 6_000_000, log: (s) => console.log(`[${pc.seconds.toFixed(2)}] ${s}`) });
  const dos = new DOS(pc, files);
  dos.loadExe('LHX.EXE', ARGS);

  // latest captured frame for each 3D window (main view, cockpit camera), with the horizon and
  // camera the compositor recorded for that window earlier in the same frame
  const views = new Map();
  const composite = new Composite(pc);
  const capture = new Capture(pc, (f) => {
    const key = `${f.view.x0},${f.view.y0},${f.view.x1},${f.view.y1}`;
    f.horizon = composite.horizons.get(key);
    views.set(key, f);
  });
  const gpu = new GPUView($('gpu'));
  const theatre = watchTheatre(dos, files);
  const reach = new Reach(pc);
  window.lhx = { pc, dos, capture, composite, gpu, views, theatre, reach };

  let paused = false, sound = null;
  $('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; };
  $('sound').onclick = () => {
    if (!sound) { sound = speaker(pc); $('sound').textContent = 'Sound: on'; }
    else { sound.stop(); sound = null; $('sound').textContent = 'Sound: off'; }
  };
  // 3D modes: the game's own software renderer, the GPU reproducing it (Accurate), or the GPU
  // with additions such as the photo sky (Enhanced)
  // Enhanced mode also draws the world four times farther out than the game does
  const setMode = (m) => { composite.enabled = m !== 'game'; gpu.enhanced = m === 'enhanced'; reach.factor = gpu.enhanced ? 4 : 1; };
  $('renderer').onchange = (e) => setMode(e.target.value);
  setMode($('renderer').value);
  $('speed').oninput = (e) => { pc.setIPS(Number(e.target.value) * 1e6); $('speedText').textContent = `${e.target.value} MIPS`; };

  // keys go to the game unless a page control has focus
  const down = new Set();
  const handle = (e, isDown) => {
    if (e.metaKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return;
    const codes = scancodes(e.code, isDown);
    if (!codes.length) return;
    e.preventDefault();
    if (isDown && e.repeat && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !e.code.startsWith('Numpad')) return;
    if (isDown) down.add(e.code); else down.delete(e.code);
    pc.pressKey(codes);
  };
  window.addEventListener('keydown', (e) => handle(e, true));
  window.addEventListener('keyup', (e) => handle(e, false));
  window.addEventListener('blur', () => { for (const c of down) pc.pressKey(scancodes(c, false)); down.clear(); });

  const show = () => {
    const gpuOn = composite.enabled;
    gpu.prepare(theatre.name);           // Enhanced mode: load the theatre's terrain and models early
    if (pc.frame(image.data, gpuOn ? KEY : -1)) {
      rawCtx.putImageData(image, 0, 0);
      $('gpu').style.display = 'block'; text.style.display = 'none';
      // 3D windows presented in the last half second (the cockpit camera can be switched off)
      const live = gpuOn ? [...views.values()].filter((f) => pc.seconds - f.time < 0.5) : [];
      gpu.theatre = theatre.name;
      gpu.draw(image.data, live, pc.dac);
    } else {
      text.textContent = pc.textScreen();
      $('gpu').style.display = 'none'; text.style.display = 'block';
    }
  };
  window.lhx.show = show;

  let last = performance.now(), frames = 0, fpsTime = last, cycles0 = 0;
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused && pc.exited === null) pc.run(dt);
    show();
    if (sound) sound.update();
    frames++;
    if (now - fpsTime > 1000) {
      const mips = (pc.cpu.cycles - cycles0) / ((now - fpsTime) * 1000);
      status.textContent = pc.exited !== null ? `exited (${pc.exited})` : `${mips.toFixed(1)} MIPS emulated · ${(frames * 1000 / (now - fpsTime)).toFixed(0)} fps`;
      frames = 0; fpsTime = now; cycles0 = pc.cpu.cycles;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e) => { status.textContent = e.message; console.error(e); });
