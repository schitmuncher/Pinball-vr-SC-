// Gets the player's own Space Cadet game files: loose files, a folder, a .zip, or the Android APK
// (which is a zip with the files under assets/). Keeps them in IndexedDB so it's a one-time step.

const WANTED = /\.(DAT|WAV|MID|MDS|MP3|OGG|BIN)$/i;

export async function filesFromPicker(fileList) {
  const out = new Map();
  for (const file of fileList) {
    const name = file.name.toUpperCase();
    if (/\.(ZIP|APK)$/.test(name)) {
      for (const [n, data] of await unzip(new Uint8Array(await file.arrayBuffer()))) out.set(n, data);
    } else if (WANTED.test(name)) {
      out.set(name, new Uint8Array(await file.arrayBuffer()));
    }
  }
  return out;
}

export function hasGameData(files) {
  return files.has('PINBALL.DAT') || files.has('CADET.DAT');
}

// Minimal zip reader using the central directory and the browser's own deflate.
export async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip/APK file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const fullName = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const base = fullName.split('/').pop().toUpperCase();
    if (!base || !WANTED.test(base) || fullName.endsWith('/')) continue;
    // Skip Android resources that only share an extension (e.g. res/raw/*.bin is not game data)
    if (/\.BIN$/i.test(base) && base !== 'PB_MSGFT.BIN') continue;
    const lnameLen = dv.getUint16(local + 26, true), lextraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lnameLen + lextraLen;
    const raw = u8.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    if (!out.has(base) || fullName.toLowerCase().startsWith('assets/')) out.set(base, data);
  }
  return out;
}

const DB = 'space-cadet-vr', STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFiles(files) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      st.clear();
      for (const [k, v] of files) st.put(v, k);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('Could not store files', e); }
}

export async function loadSavedFiles() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const out = new Map();
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out.set(c.key, new Uint8Array(c.value)); c.continue(); } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  } catch { return new Map(); }
}

export async function forgetFiles() {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  } catch {}
}
