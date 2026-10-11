// test helpers injected into a page: start a mission, snapshot, re-render a frame from any camera
(() => {
  const { pc, views, gpu } = window.lhx;
  window.tap = (code) => { pc.pressKey([code]); pc.run(0.05); pc.pressKey([code | 0x80]); };
  window.ext = (code) => { pc.pressKey([0xe0, code]); pc.run(0.05); pc.pressKey([0xe0, code | 0x80]); };
  window.runFor = (s) => { for (let t = 0; t < s; t += 0.05) pc.run(0.05); };
  window.snap = (list, w = 576, h = 360) => { let box = document.getElementById('snapbox'); if (!box) { box = document.createElement('div'); box.id = 'snapbox'; document.body.appendChild(box); } box.style.cssText = `position:fixed;left:0;top:0;z-index:99;display:flex;flex-direction:column;background:#000;width:${w}px`; box.innerHTML = ''; for (const c of list) { c.style.cssText = `width:${w}px;height:${h}px;flex:none;margin:0 0 4px 0`; box.appendChild(c); } };
  window.grab = () => { const g = document.getElementById('gpu'); const c = document.createElement('canvas'); c.width = g.width; c.height = g.height; c.getContext('2d').drawImage(g, 0, 0); return c; };
  window.mission = async (rights, downs) => {
    document.getElementById('pause').textContent === 'Pause' && document.getElementById('pause').click();
    const sel = document.getElementById('renderer'); sel.value = 'enhanced'; sel.dispatchEvent(new Event('change'));
    runFor(1); tap(0x1c); runFor(2.5); tap(0x1c); runFor(2.5);
    for (let i = 0; i < rights; i++) { ext(0x4d); runFor(1.2); }
    tap(0x1c); runFor(2.5);
    for (let i = 0; i < downs; i++) { ext(0x50); runFor(0.3); }
    tap(0x1c); runFor(1);
    for (let i = 0; i < 60; i++) { window.lhx.show(); await new Promise(r => setTimeout(r, 100)); }
    let started = false;
    for (let i = 0; i < 12 && !started; i++) { tap(0x1c); runFor(2.5); started = [...views.values()].some(f => pc.seconds - f.time < 0.5 && f.view.y1 >= 199 && f.objects.some(o => o.name === 'runway')); }
    runFor(5.5); tap(0x3f); runFor(1);
    for (let i = 0; i < 10; i++) { window.lhx.show(); await new Promise(r => setTimeout(r, 100)); }
    return started;
  };
  const T = 2 * Math.PI / 2880, Y = 0.868;
  const rot = (c) => { const [a, b, r] = [c.heading * T, c.pitch * T, c.roll * T]; const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, _, k) => s + row[k] * B[k][j], 0))); return mul(mul([[Math.cos(r), -Math.sin(r), 0], [Math.sin(r), Math.cos(r), 0], [0, 0, 1]], [[1, 0, 0], [0, Math.cos(b), -Math.sin(b)], [0, Math.sin(b), Math.cos(b)]]), [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]); };
  window.reproject = (f, cam2) => { const c1 = f.horizon.camera, R1 = rot(c1), R2 = rot(cam2); const objects = f.objects.map(o => { const P = o.pts, Q = new Float32Array(P.length); for (let i = 0; i < P.length; i += 3) { const p = [P[i] * o.unit, P[i + 1] * o.unit / Y, P[i + 2] * o.unit]; const w = [0, 1, 2].map(k => R1[0][k] * p[0] + R1[1][k] * p[1] + R1[2][k] * p[2] + c1.position[k]); const d = [0, 1, 2].map(k => w[k] - cam2.position[k]); const q = [0, 1, 2].map(k => R2[k][0] * d[0] + R2[k][1] * d[1] + R2[k][2] * d[2]); Q[i] = q[0] / o.unit; Q[i + 1] = q[1] * Y / o.unit; Q[i + 2] = q[2] / o.unit; } return { ...o, pts: Q, cx: 160, cy: 100 }; }); return { ...f, objects, view: { ...f.view, x0: 0, x1: 320, y0: 0, y1: 200, cx: 160, cy: 100 }, horizon: { ...f.horizon, camera: cam2 } }; };
  const clear = new Uint8Array(320 * 200 * 4);
  window.viewAt = (f, x, y, z, hd, pd) => { gpu.draw(clear, [reproject(f, { ...f.horizon.camera, heading: Math.round(hd * 8), pitch: Math.round(pd * 8), roll: 0, position: [x, y, z] })], pc.dac); return grab(); };
  window.frameWith = (name) => [...views.values()].filter(f => f.objects.some(o => o.name === name)).sort((p, q) => q.time - p.time)[0];
  window.paused = (fn) => { const b = document.getElementById('pause'); const was = b.textContent === 'Pause'; if (was) b.click(); try { return fn(); } finally { if (was) b.click(); } };
})();
'kit ready';
