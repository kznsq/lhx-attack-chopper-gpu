// Which theatre the game is flying in. A mission loads its theatre file (GULF.W, ASIA.W or
// EUROPE.W) out of one of the game's LIB archives; this watches the reads and names the entry.

const THEATRES = { 'GULF.W': 'gulf', 'ASIA.W': 'asia', 'EUROPE.W': 'europe' };

// EALIB archive: "EALIB", u16 entry count, then 18-byte entries (13-byte name, type, u32 offset);
// an entry's data runs to the next entry's offset.
function libEntries(bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== 'EALIB') return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint16(5, true), out = [];
  for (let i = 0; i <= n; i++) {
    const o = 7 + i * 18;
    let name = '';
    for (let k = 0; k < 13 && bytes[o + k]; k++) name += String.fromCharCode(bytes[o + k]);
    out.push({ name: name.toUpperCase(), start: dv.getUint32(o + 14, true) });
  }
  for (let i = 0; i < n; i++) out[i].end = i + 1 < n ? out[i + 1].start : bytes.length;
  return out.slice(0, n);
}

export function watchTheatre(dos, files) {
  const ranges = new Map();
  for (const [file, bytes] of Object.entries(files)) {
    const hits = libEntries(bytes).filter((e) => THEATRES[e.name]);
    if (hits.length) ranges.set(file.toUpperCase(), hits);
  }
  const state = { name: null };
  dos.onRead = (file, pos, n) => {
    const hit = ranges.get(file)?.find((e) => pos < e.end && pos + n > e.start);
    if (hit) state.name = THEATRES[hit.name];
  };
  return state;
}
