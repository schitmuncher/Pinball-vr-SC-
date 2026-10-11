// Minesweeper VR: the classic mine-clearing puzzle as a 3D board you point at.
// All graphics and sounds here are original; only the rules are the classic ones.
import * as THREE from './vendor/three.module.min.js';

const LEVELS = {
  beginner: { cols: 9, rows: 9, mines: 10 },
  intermediate: { cols: 16, rows: 16, mines: 40 },
  expert: { cols: 30, rows: 16, mines: 99 },
};
const TILT = 0.45; // board leans toward you like a drafting table
const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------------------------------------------------------------- game rules
const game = { level: store.get('ms-level', 'beginner') };
if (!LEVELS[game.level]) game.level = 'beginner';

function newGame(level = game.level) {
  const L = LEVELS[level];
  Object.assign(game, {
    level, cols: L.cols, rows: L.rows, mines: L.mines, n: L.cols * L.rows,
    mine: new Uint8Array(L.cols * L.rows), open: new Uint8Array(L.cols * L.rows),
    flag: new Uint8Array(L.cols * L.rows), count: new Uint8Array(L.cols * L.rows),
    state: 'ready', start: 0, elapsed: 0, opened: 0, flags: 0, boom: -1,
  });
  store.set('ms-level', level);
  buildBoard();
  syncAll();
  drawPanel();
  updateLevelButtons();
}

function neighbours(i, fn) {
  const c = i % game.cols, r = (i / game.cols) | 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const cc = c + dc, rr = r + dr;
    if (cc >= 0 && rr >= 0 && cc < game.cols && rr < game.rows) fn(rr * game.cols + cc);
  }
}

// Mines are laid after the first dig, never on or next to it, so the first dig always opens space
function layMines(safe) {
  const banned = new Set([safe]);
  neighbours(safe, (j) => banned.add(j));
  let placed = 0;
  while (placed < game.mines) {
    const i = (Math.random() * game.n) | 0;
    if (game.mine[i] || banned.has(i)) continue;
    game.mine[i] = 1;
    placed++;
  }
  for (let i = 0; i < game.n; i++) { let k = 0; neighbours(i, (j) => { k += game.mine[j]; }); game.count[i] = k; }
  game.state = 'playing';
  game.start = performance.now();
}

function dig(i) {
  if (game.state === 'won' || game.state === 'lost') return false;
  if (game.flag[i] || game.open[i]) return false;
  if (game.state === 'ready') layMines(i);
  if (game.mine[i]) { lose(i); return true; }
  // Flood-fill outward from empty squares; depth drives a ripple in the dig animation
  const queue = [i], depth = new Map([[i, 0]]);
  while (queue.length) {
    const j = queue.shift();
    if (game.open[j] || game.flag[j]) continue;
    game.open[j] = 1;
    game.opened++;
    animateOpen(j, depth.get(j));
    if (game.count[j] === 0) neighbours(j, (k) => {
      if (!game.open[k] && !game.flag[k] && !depth.has(k)) { depth.set(k, depth.get(j) + 1); queue.push(k); }
    });
  }
  sfx.dig(depth.size > 1);
  checkWin();
  return true;
}

// Digging an open number whose flags are all placed clears the rest of its neighbours
function chord(i) {
  if (game.state !== 'playing' || !game.open[i] || !game.count[i]) return false;
  let flags = 0;
  neighbours(i, (j) => { flags += game.flag[j]; });
  if (flags !== game.count[i]) return false;
  let any = false;
  neighbours(i, (j) => { if (!game.open[j] && !game.flag[j]) any = dig(j) || any; });
  return any;
}

function toggleFlag(i) {
  if (game.state === 'won' || game.state === 'lost' || game.open[i]) return false;
  game.flag[i] ^= 1;
  game.flags += game.flag[i] ? 1 : -1;
  syncCell(i);
  sfx.flag(game.flag[i]);
  drawPanel();
  return true;
}

function lose(i) {
  game.state = 'lost';
  game.boom = i;
  game.elapsed = performance.now() - game.start;
  syncAll();
  sfx.boom();
  buzzAll(1, 300);
  drawPanel();
}

function checkWin() {
  if (game.state !== 'playing' || game.opened !== game.n - game.mines) { drawPanel(); return; }
  game.state = 'won';
  game.elapsed = performance.now() - game.start;
  for (let i = 0; i < game.n; i++) if (game.mine[i] && !game.flag[i]) { game.flag[i] = 1; game.flags++; }
  const secs = Math.max(1, Math.round(game.elapsed / 1000));
  const key = 'ms-best-' + game.level;
  const best = Number(store.get(key, 0));
  game.newBest = !best || secs < best;
  if (game.newBest) store.set(key, String(secs));
  syncAll();
  sfx.win();
  buzzAll(0.5, 120);
  drawPanel();
  updateBest();
}

// ---------------------------------------------------------------- sound (synthesised, nothing to load)
const sfx = (() => {
  let ctx = null, noise = null;
  const ac = () => {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  };
  const tone = (f, t0, dur, type = 'square', vol = 0.08) => {
    const c = ac(), o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(vol, c.currentTime + t0);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.02);
  };
  const burst = (dur, freq, vol, type = 'lowpass') => {
    const c = ac(), s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noise; f.type = type; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    s.connect(f).connect(g).connect(c.destination);
    s.start(); s.stop(c.currentTime + dur + 0.05);
  };
  return {
    unlock: () => ac(),
    dig: (big) => { burst(big ? 0.18 : 0.06, big ? 1400 : 2600, big ? 0.25 : 0.18, 'bandpass'); },
    flag: (on) => { tone(on ? 880 : 520, 0, 0.08, 'triangle', 0.12); },
    boom: () => { burst(1.2, 500, 0.9); tone(70, 0, 0.6, 'sine', 0.5); },
    win: () => { [523, 659, 784, 1047].forEach((f, k) => tone(f, k * 0.11, 0.25, 'triangle', 0.12)); },
    tick: () => { tone(1200, 0, 0.03, 'sine', 0.05); },
  };
})();

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0.8);
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07060f);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.02, 100);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xd8dcff, 0x2a2240, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(0.4, 2.5, 1.0);
scene.add(sun);

const world = new THREE.Group();
scene.add(world);
{
  const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 64), new THREE.MeshBasicMaterial({ color: 0x110e1b }));
  floor.rotation.x = -Math.PI / 2;
  world.add(floor);
  const grid = new THREE.GridHelper(16, 32, 0x3a2f66, 0x221b3d);
  grid.position.y = 0.002;
  world.add(grid);
  const n = 2000, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * s * 30, Math.abs(u) * 27 + 1, Math.sin(a) * s * 30], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  world.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.08, color: 0xdde0ff })));
}

const rig = new THREE.Group(); // moved by "bring board to me"
scene.add(rig);
const stand = new THREE.Group(); // board height
rig.add(stand);
const boardG = new THREE.Group();
boardG.rotation.x = TILT;
stand.add(boardG);
let heightOffset = Number(store.get('ms-height', 0));

// Number tiles: one atlas texture, drawn once. 0 = empty, 1-8 numbers, 9 = blown-up mine square, 10 = wrong flag
const NUM_COLORS = ['', '#2f6bff', '#1f9a4a', '#e8344a', '#26238f', '#8f1f2c', '#118a8a', '#222', '#6b6b78'];
const atlas = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  for (let t = 0; t < 16; t++) {
    const ox = (t % 4) * 128, oy = ((t / 4) | 0) * 128;
    x.fillStyle = t === 9 ? '#ff4d6a' : '#cfd3e6';
    x.fillRect(ox, oy, 128, 128);
    x.strokeStyle = 'rgba(70,72,110,0.55)'; x.lineWidth = 4;
    x.strokeRect(ox + 2, oy + 2, 124, 124);
    if (t >= 1 && t <= 8) {
      x.fillStyle = NUM_COLORS[t];
      x.font = 'bold 92px system-ui, Arial, sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(t), ox + 64, oy + 70);
    }
    if (t === 10) {
      x.strokeStyle = '#e8344a'; x.lineWidth = 12; x.lineCap = 'round';
      x.beginPath(); x.moveTo(ox + 30, oy + 30); x.lineTo(ox + 98, oy + 98); x.moveTo(ox + 98, oy + 30); x.lineTo(ox + 30, oy + 98); x.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
})();

const tileMat = new THREE.ShaderMaterial({
  uniforms: { uAtlas: { value: atlas } },
  vertexShader: `
    attribute float tile;
    varying vec2 vUv;
    void main() {
      vec2 cell = vec2(mod(tile, 4.0), floor(tile / 4.0));
      vUv = (cell + vec2(uv.x, 1.0 - uv.y)) / 4.0;
      vUv.y = 1.0 - vUv.y;
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D uAtlas;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(uAtlas, vUv); }`,
});
tileMat.toneMapped = false;

let cell = 0.05, W = 0, D = 0, blocks, tiles, tileAttr, flagPoles, flagCloths, minesMesh, hitPlane, frame, panel, panelCanvas, panelTex;
const BLOCK_H = 0.32; // as a fraction of cell size
const anims = new Map(); // cell -> start time for dig animation
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _col = new THREE.Color();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function cellPos(i, y, out) {
  const c = i % game.cols, r = (i / game.cols) | 0;
  return out.set((c - (game.cols - 1) / 2) * cell, y, (r - (game.rows - 1) / 2) * cell);
}

function buildBoard() {
  boardG.clear();
  cell = Math.min(0.055, 0.8 / game.cols);
  W = game.cols * cell; D = game.rows * cell;
  const n = game.n;

  // Base tray and frame
  const trayMat = new THREE.MeshLambertMaterial({ color: 0x232048 });
  const tray = new THREE.Mesh(new THREE.BoxGeometry(W + 0.04, 0.02, D + 0.04), trayMat);
  tray.position.y = -0.011;
  boardG.add(tray);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0x8d86ff, toneMapped: false });
  for (const [sx, sz, px, pz] of [[W + 0.05, 0.006, 0, -D / 2 - 0.022], [W + 0.05, 0.006, 0, D / 2 + 0.022], [0.006, D + 0.05, -W / 2 - 0.022, 0], [0.006, D + 0.05, W / 2 + 0.022, 0]]) {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.008, sz), rimMat);
    rim.position.set(px, 0.002, pz);
    boardG.add(rim);
  }

  // Revealed squares (instanced, pick their picture from the atlas)
  const tileGeo = new THREE.PlaneGeometry(cell, cell);
  tileGeo.rotateX(-Math.PI / 2);
  tileAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  tileGeo.setAttribute('tile', tileAttr);
  tiles = new THREE.InstancedMesh(tileGeo, tileMat, n);
  tiles.frustumCulled = false;
  boardG.add(tiles);

  // Unrevealed squares: raised blocks
  const blockGeo = new THREE.BoxGeometry(cell * 0.92, cell * BLOCK_H, cell * 0.92);
  blockGeo.translate(0, cell * BLOCK_H / 2, 0);
  blocks = new THREE.InstancedMesh(blockGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
  blocks.frustumCulled = false;
  boardG.add(blocks);

  // Flags and mines
  const poleGeo = new THREE.CylinderGeometry(cell * 0.03, cell * 0.03, cell * 0.6, 6);
  poleGeo.translate(0, cell * 0.3, 0);
  flagPoles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x2a2a35 }), n);
  const clothGeo = new THREE.ConeGeometry(cell * 0.2, cell * 0.32, 3);
  clothGeo.rotateZ(-Math.PI / 2);
  clothGeo.translate(cell * 0.15, cell * 0.48, 0);
  flagCloths = new THREE.InstancedMesh(clothGeo, new THREE.MeshLambertMaterial({ color: 0xff3355, emissive: 0x551020 }), n);
  minesMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(cell * 0.28, 0), new THREE.MeshLambertMaterial({ color: 0x1a1a22, emissive: 0x220008 }), n);
  for (const m of [flagPoles, flagCloths, minesMesh]) { m.frustumCulled = false; boardG.add(m); }

  // Invisible surface the lasers and mouse hit
  hitPlane = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  hitPlane.rotation.x = -Math.PI / 2;
  hitPlane.position.y = cell * BLOCK_H;
  boardG.add(hitPlane);

  // Hover outlines (one per hand / mouse)
  for (const h of hovers) {
    h.mesh = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-cell / 2, 0, -cell / 2), new THREE.Vector3(cell / 2, 0, -cell / 2),
      new THREE.Vector3(cell / 2, 0, cell / 2), new THREE.Vector3(-cell / 2, 0, cell / 2)]),
    new THREE.LineBasicMaterial({ color: h.color, toneMapped: false }));
    h.mesh.visible = false;
    boardG.add(h.mesh);
  }

  buildPanel();
  anims.clear();
  placeBoard();
  if (state.inXR) state.needsRecenter = true;
}

function syncCell(i) {
  const open = game.open[i], lost = game.state === 'lost';
  cellPos(i, 0, _p);
  // Revealed picture
  if (open || (lost && (game.mine[i] || game.flag[i]))) {
    let t = open ? game.count[i] : 0;
    if (lost && i === game.boom) t = 9;
    if (lost && game.flag[i] && !game.mine[i]) t = 10;
    tileAttr.array[i] = t;
    _m.makeTranslation(_p.x, 0.0005, _p.z);
    tiles.setMatrixAt(i, _m);
  } else tiles.setMatrixAt(i, HIDDEN);
  // Block
  const showBlock = !open && !(lost && (game.mine[i] || (game.flag[i] && !game.mine[i])));
  if (showBlock && !anims.has(i)) { _m.makeTranslation(_p.x, 0, _p.z); blocks.setMatrixAt(i, _m); }
  else if (!anims.has(i)) blocks.setMatrixAt(i, HIDDEN);
  blocks.setColorAt(i, _col.setHex(blockColor(i)));
  // Flag
  const flagY = showBlock ? cell * BLOCK_H : 0;
  if (game.flag[i] && !(lost && !game.mine[i])) {
    _m.makeTranslation(_p.x - cell * 0.1, flagY, _p.z);
    flagPoles.setMatrixAt(i, _m); flagCloths.setMatrixAt(i, _m);
  } else { flagPoles.setMatrixAt(i, HIDDEN); flagCloths.setMatrixAt(i, HIDDEN); }
  // Mine, shown when the game is lost
  if (lost && game.mine[i] && !game.flag[i]) { _m.makeTranslation(_p.x, cell * 0.25, _p.z); minesMesh.setMatrixAt(i, _m); }
  else minesMesh.setMatrixAt(i, HIDDEN);
  for (const m of [tiles, blocks, flagPoles, flagCloths, minesMesh]) m.instanceMatrix.needsUpdate = true;
  if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  tileAttr.needsUpdate = true;
}

function blockColor(i) {
  const c = i % game.cols, r = (i / game.cols) | 0;
  const hovered = hovers.some((h) => h.cell === i && h.mesh && h.mesh.visible);
  if (hovered) return 0xc9c3ff;
  return (c + r) % 2 ? 0x6e72c4 : 0x7a7fd0; // raised squares: deeper than the pale dug ones, with a subtle checker
}

function syncAll() { for (let i = 0; i < game.n; i++) syncCell(i); }

function animateOpen(i, depth) { anims.set(i, performance.now() + depth * 22); syncCell(i); }

function updateAnims(now) {
  if (!anims.size) return;
  for (const [i, t0] of anims) {
    const k = (now - t0) / 140;
    cellPos(i, 0, _p);
    if (k < 0) { _m.makeTranslation(_p.x, 0, _p.z); blocks.setMatrixAt(i, _m); continue; }
    if (k >= 1) { blocks.setMatrixAt(i, HIDDEN); anims.delete(i); continue; }
    // Block pops up slightly then sinks away
    const lift = Math.sin(k * Math.PI) * cell * 0.25;
    _m.compose(_s.set(_p.x, lift, _p.z), _q.identity(), _p.set(1 - k * 0.6, Math.max(0.01, 1 - k), 1 - k * 0.6));
    blocks.setMatrixAt(i, _m);
  }
  blocks.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- panel: mine counter, face button, timer, levels
const PANEL_W = 1024, PANEL_H = 300;
const panelButtons = []; // {id, x, y, w, h}
function buildPanel() {
  panelCanvas = panelCanvas || document.createElement('canvas');
  panelCanvas.width = PANEL_W; panelCanvas.height = PANEL_H;
  panelTex = panelTex || new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  const pw = Math.max(0.42, Math.min(W, 0.62)), ph = pw * PANEL_H / PANEL_W;
  panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, toneMapped: false }));
  // Stands upright behind the far edge of the board
  panel.rotation.x = -TILT;
  panel.position.set(0, ph / 2 * Math.cos(TILT) + 0.02, -D / 2 - 0.04 - ph / 2 * Math.sin(TILT));
  boardG.add(panel);
}

function drawPanel() {
  if (!panelCanvas) return;
  const x = panelCanvas.getContext('2d');
  x.clearRect(0, 0, PANEL_W, PANEL_H);
  x.fillStyle = 'rgba(12,10,30,0.92)';
  x.beginPath(); x.roundRect(0, 0, PANEL_W, PANEL_H, 30); x.fill();
  x.strokeStyle = '#7f7cff'; x.lineWidth = 5; x.beginPath(); x.roundRect(3, 3, PANEL_W - 6, PANEL_H - 6, 28); x.stroke();
  panelButtons.length = 0;

  // Counters in a glowing segment style
  const counter = (v, cx) => {
    x.fillStyle = '#05040c'; x.beginPath(); x.roundRect(cx - 130, 24, 260, 120, 18); x.fill();
    x.font = 'bold 96px ui-monospace, Menlo, Consolas, monospace';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = 'rgba(55,224,255,0.12)'; x.fillText('888', cx, 88);
    x.fillStyle = '#37e0ff'; x.shadowColor = '#37e0ff'; x.shadowBlur = 18;
    x.fillText(String(Math.max(-99, Math.min(999, v))).padStart(3, '0'), cx, 88);
    x.shadowBlur = 0;
  };
  counter(game.mines - game.flags, 190);
  counter(Math.min(999, Math.floor(currentTime() / 1000)), PANEL_W - 190);

  // Face button
  const fx = PANEL_W / 2, fy = 84, fr = 60;
  x.fillStyle = '#ffd166'; x.beginPath(); x.arc(fx, fy, fr, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#3a2a00'; x.lineWidth = 6; x.stroke();
  x.fillStyle = '#3a2a00'; x.strokeStyle = '#3a2a00'; x.lineWidth = 6; x.lineCap = 'round';
  if (game.state === 'won') {
    x.fillRect(fx - 44, fy - 22, 36, 18); x.fillRect(fx + 8, fy - 22, 36, 18); x.fillRect(fx - 10, fy - 18, 20, 5);
    x.beginPath(); x.arc(fx, fy + 6, 30, 0.2 * Math.PI, 0.8 * Math.PI); x.stroke();
  } else if (game.state === 'lost') {
    for (const ex of [-22, 22]) { x.beginPath(); x.moveTo(fx + ex - 9, fy - 22); x.lineTo(fx + ex + 9, fy - 6); x.moveTo(fx + ex + 9, fy - 22); x.lineTo(fx + ex - 9, fy - 6); x.stroke(); }
    x.beginPath(); x.arc(fx, fy + 36, 22, 1.15 * Math.PI, 1.85 * Math.PI); x.stroke();
  } else {
    x.beginPath(); x.arc(fx - 22, fy - 14, 7, 0, Math.PI * 2); x.arc(fx + 22, fy - 14, 7, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(fx, fy + 4, 30, 0.2 * Math.PI, 0.8 * Math.PI); x.stroke();
  }
  panelButtons.push({ id: 'new', x: fx - fr, y: fy - fr, w: fr * 2, h: fr * 2 });

  // Level buttons (and Exit VR when in the headset)
  const items = [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['expert', 'Expert']];
  if (state.inXR) items.push(['exit', 'Exit VR']);
  const bw = (PANEL_W - 60 - (items.length - 1) * 16) / items.length;
  items.forEach(([id, label], k) => {
    const bx = 30 + k * (bw + 16), by = 176;
    const on = id === game.level, hot = panelHover === id;
    x.fillStyle = id === 'exit' ? (hot ? '#ff4d7d' : '#4a1730') : on ? '#8d86ff' : hot ? '#3a3480' : '#211c4a';
    x.beginPath(); x.roundRect(bx, by, bw, 92, 18); x.fill();
    x.fillStyle = on && id !== 'exit' ? '#0b0820' : '#ecebff';
    x.font = '600 36px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, bx + bw / 2, by + 47);
    panelButtons.push({ id, x: bx, y: by, w: bw, h: 92 });
  });
  if (game.state === 'won' && game.newBest) {
    x.fillStyle = '#ffd166'; x.font = 'bold 28px system-ui, sans-serif'; x.textAlign = 'center';
    x.fillText('New best time!', fx, 160);
  }
  panelTex.needsUpdate = true;
}
let panelHover = null;

function currentTime() {
  if (game.state === 'playing') return performance.now() - game.start;
  if (game.state === 'won' || game.state === 'lost') return game.elapsed;
  return 0;
}

function panelAction(id) {
  sfx.tick();
  if (id === 'new') newGame();
  else if (id === 'exit') renderer.xr.getSession()?.end();
  else if (LEVELS[id]) newGame(id);
}

// ---------------------------------------------------------------- placing the board
const state = { inXR: false, needsRecenter: false };
function placeBoard() {
  stand.position.set(0, 0.95 + heightOffset, -(D / 2) * Math.cos(TILT) - 0.32);
}
function recenter() {
  const cam = renderer.xr.getCamera();
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  cam.getWorldPosition(p); cam.getWorldQuaternion(q);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q); f.y = 0; f.normalize();
  rig.position.set(p.x, 0, p.z);
  rig.rotation.y = Math.atan2(-f.x, -f.z);
  // Sit the board a little below the eyes, whatever your height
  heightOffset = THREE.MathUtils.clamp(p.y - 1.55, -0.5, 0.5);
  placeBoard();
}

// ---------------------------------------------------------------- pointing (lasers, mouse, touch)
const hovers = [
  { id: 'right', color: 0x37e0ff, cell: -1, mesh: null },
  { id: 'left', color: 0xc9a4ff, cell: -1, mesh: null },
  { id: 'mouse', color: 0x37e0ff, cell: -1, mesh: null },
];
const raycaster = new THREE.Raycaster();
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _l = new THREE.Vector3();

// Returns {kind: 'cell', i} | {kind: 'panel', id} | null, plus the hit distance
function pick(origin, dir) {
  raycaster.set(origin, dir);
  const hits = raycaster.intersectObjects([hitPlane, panel], false);
  for (const h of hits) {
    if (h.object === panel) {
      const px = h.uv.x * PANEL_W, py = (1 - h.uv.y) * PANEL_H;
      const b = panelButtons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
      return { kind: 'panel', id: b ? b.id : null, dist: h.distance };
    }
    boardG.worldToLocal(_l.copy(h.point));
    const c = Math.floor(_l.x / cell + game.cols / 2), r = Math.floor(_l.z / cell + game.rows / 2);
    if (c >= 0 && r >= 0 && c < game.cols && r < game.rows) return { kind: 'cell', i: r * game.cols + c, dist: h.distance };
  }
  return null;
}

function setHover(h, target) {
  const i = target && target.kind === 'cell' ? target.i : -1;
  if (i === h.cell && h.mesh.visible === (i >= 0)) return false;
  const old = h.cell;
  h.cell = i;
  h.mesh.visible = i >= 0;
  if (i >= 0) { cellPos(i, cell * (game.open[i] ? 0.004 : BLOCK_H + 0.004), _p); h.mesh.position.copy(_p); }
  if (old >= 0 && old < game.n) syncCell(old);
  if (i >= 0) syncCell(i);
  return i >= 0;
}

function setPanelHover(id) {
  if (id === panelHover) return;
  panelHover = id;
  drawPanel();
}

// Dig, or clear around a number
function primary(i) {
  sfx.unlock();
  if (game.open[i]) return chord(i);
  return dig(i);
}

// ---------------------------------------------------------------- VR controllers
const ctl = {}; // handedness -> targetRay space
const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
for (let k = 0; k < 2; k++) {
  const c = renderer.xr.getController(k);
  c.addEventListener('connected', (e) => { c.userData.hand = e.data.handedness; c.userData.src = e.data; ctl[e.data.handedness] = c; });
  c.addEventListener('disconnected', () => { if (ctl[c.userData.hand] === c) delete ctl[c.userData.hand]; });
  const laser = new THREE.Line(laserGeo, new THREE.LineBasicMaterial({ color: 0xb9b0ff, transparent: true, opacity: 0.8, toneMapped: false }));
  c.add(laser);
  c.userData.laser = laser;
  // Hand tracking: a quick pinch digs, a long pinch flags
  c.addEventListener('selectstart', () => { if (c.userData.src && c.userData.src.hand) c.userData.pinchAt = performance.now(); });
  c.addEventListener('selectend', () => {
    const src = c.userData.src;
    if (!src || !src.hand || c.userData.target == null) return;
    const t = c.userData.target;
    if (t.kind === 'panel' && t.id) panelAction(t.id);
    else if (t.kind === 'cell') { if (performance.now() - c.userData.pinchAt > 450) toggleFlag(t.i); else primary(t.i); }
  });
  scene.add(c);
  // Simple controller body
  const grip = renderer.xr.getControllerGrip(k);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.1, 12), new THREE.MeshLambertMaterial({ color: 0x2a2840 }));
  body.rotation.x = -0.9; body.position.set(0, -0.015, 0.03);
  grip.add(body);
  scene.add(grip);
}

const prevPad = { left: {}, right: {} };
function buzz(src, s, ms) {
  const h = src && src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
  if (h && h.pulse) h.pulse(s, ms);
}
function buzzAll(s, ms) {
  const session = renderer.xr.getSession();
  if (session) for (const src of session.inputSources) buzz(src, s, ms);
}

function pollXR(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  let panelHot = null;
  for (const hand of ['right', 'left']) {
    const c = ctl[hand];
    const h = hovers.find((x) => x.id === hand);
    if (!c) { if (h.mesh) setHover(h, null); continue; }
    c.getWorldPosition(_o);
    c.getWorldQuaternion(_q);
    _d.set(0, 0, -1).applyQuaternion(_q);
    const t = pick(_o, _d);
    c.userData.target = t;
    c.userData.laser.scale.z = t ? t.dist : 0.5;
    if (setHover(h, t) && h.lastCell !== h.cell) buzz(c.userData.src, 0.08, 6);
    h.lastCell = h.cell;
    if (t && t.kind === 'panel' && t.id) panelHot = t.id;

    const src = c.userData.src;
    const gp = src && src.gamepad;
    if (!gp || src.hand) continue;
    const b = (n) => !!(gp.buttons[n] && (gp.buttons[n].pressed || gp.buttons[n].value > 0.5));
    const now = { trig: b(0), grip: b(1), ab: b(4), by: b(5), stick: b(3) };
    const prev = prevPad[hand];
    if (now.trig && !prev.trig && t) {
      if (t.kind === 'panel' && t.id) { panelAction(t.id); buzz(src, 0.4, 20); }
      else if (t.kind === 'cell' && primary(t.i)) buzz(src, game.state === 'lost' ? 1 : 0.35, game.state === 'lost' ? 300 : 25);
    }
    if (((now.grip && !prev.grip) || (now.ab && !prev.ab)) && t && t.kind === 'cell' && toggleFlag(t.i)) buzz(src, 0.25, 30);
    if (now.by && !prev.by) newGame();
    if (hand === 'left') {
      const ay = gp.axes[3] || 0;
      if (Math.abs(ay) > 0.3) {
        heightOffset = THREE.MathUtils.clamp(heightOffset - ay * 0.4 * dt, -0.6, 0.6);
        placeBoard();
      }
      if (now.stick && !prev.stick) recenter();
    }
    prevPad[hand] = now;
  }
  setPanelHover(panelHot);
}

// ---------------------------------------------------------------- flat screen: mouse and touch
const ndc = new THREE.Vector2();
let flagMode = false, touchTimer = null, touchStart = null, touchFlagged = false;
function pointerTarget(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return pick(raycaster.ray.origin, raycaster.ray.direction);
}
const mouseHover = hovers.find((h) => h.id === 'mouse');
renderer.domElement.addEventListener('pointermove', (e) => {
  if (state.inXR || !document.body.classList.contains('flat-play')) return;
  const t = pointerTarget(e);
  if (e.pointerType === 'mouse') setHover(mouseHover, t);
  setPanelHover(t && t.kind === 'panel' ? t.id : null);
  renderer.domElement.style.cursor = t && (t.kind === 'cell' || t.id) ? 'pointer' : 'default';
  if (touchStart && Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 14) { clearTimeout(touchTimer); touchStart = null; }
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (state.inXR || !document.body.classList.contains('flat-play')) return;
  sfx.unlock();
  const t = pointerTarget(e);
  if (!t) return;
  if (t.kind === 'panel') { if (t.id) panelAction(t.id); return; }
  if (e.pointerType === 'touch') {
    // Long press flags; a tap digs (or flags in flag mode)
    touchStart = { x: e.clientX, y: e.clientY, i: t.i };
    touchFlagged = false;
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => {
      if (!touchStart) return;
      touchFlagged = true;
      if (toggleFlag(touchStart.i)) { try { navigator.vibrate && navigator.vibrate(30); } catch {} }
    }, 380);
    return;
  }
  if (e.button === 2) toggleFlag(t.i);
  else if (e.button === 0 || e.button === 1) primary(t.i);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch' || !touchStart) return;
  clearTimeout(touchTimer);
  const s = touchStart;
  touchStart = null;
  if (touchFlagged) return;
  if (flagMode) toggleFlag(s.i); else { primary(s.i); try { navigator.vibrate && navigator.vibrate(game.state === 'lost' ? 200 : 8); } catch {} }
});
addEventListener('keydown', (e) => { if ((e.key === 'n' || e.key === 'F2') && document.body.classList.contains('flat-play')) newGame(); });
$('flag-mode').addEventListener('click', () => { flagMode = !flagMode; $('flag-mode').classList.toggle('on', flagMode); });

// Camera frames the board and its panel on any screen shape
const orbit = { zoom: 1 };
renderer.domElement.addEventListener('wheel', (e) => { orbit.zoom = THREE.MathUtils.clamp(orbit.zoom * (1 + e.deltaY * 0.001), 0.5, 2); }, { passive: true });
const _box = new THREE.Box3(), _sph = new THREE.Sphere();
function updateFlatCamera() {
  // Fit the whole board and its panel: look at it square-on (a little from below the panel)
  boardG.updateMatrixWorld(true);
  _box.makeEmpty().expandByObject(tiles).expandByObject(panel).expandByObject(blocks);
  _box.getBoundingSphere(_sph);
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const dist = _sph.radius / Math.sin(Math.min(halfV, halfH)) * (camera.aspect < 1 ? 0.76 : 0.86) * orbit.zoom;
  const n = new THREE.Vector3(0, 1, 0).applyQuaternion(boardG.getWorldQuaternion(_q));
  const dir = n.add(new THREE.Vector3(0, 0, 0.35)).normalize();
  camera.position.copy(_sph.center).addScaledVector(dir, dist);
  camera.lookAt(_sph.center);
}

// ---------------------------------------------------------------- loop
let last = 0, lastSecond = -1;
renderer.setAnimationLoop((time) => {
  const dt = last ? Math.min(time - last, 100) / 1000 : 0.016;
  last = time;
  if (state.needsRecenter && renderer.xr.isPresenting) {
    const p = new THREE.Vector3();
    renderer.xr.getCamera().getWorldPosition(p);
    if (p.lengthSq() > 0) { recenter(); state.needsRecenter = false; }
  }
  pollXR(dt);
  updateAnims(performance.now());
  const sec = Math.floor(currentTime() / 1000);
  if (sec !== lastSecond) { lastSecond = sec; drawPanel(); }
  if (!renderer.xr.isPresenting) updateFlatCamera();
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- start screen
function updateLevelButtons() {
  for (const b of document.querySelectorAll('#levels button')) b.classList.toggle('on', b.dataset.level === game.level);
}
function updateBest() {
  for (const lv of Object.keys(LEVELS)) {
    const v = store.get('ms-best-' + lv, null);
    $('best-' + lv).textContent = v ? v + 's' : '–';
  }
}
for (const b of document.querySelectorAll('#levels button')) b.addEventListener('click', () => newGame(b.dataset.level));

async function enterXR(mode) {
  try {
    sfx.unlock();
    const session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    world.visible = mode !== 'immersive-ar';
    scene.background = mode === 'immersive-ar' ? null : new THREE.Color(0x07060f);
    state.inXR = true;
    document.body.classList.add('in-xr');
    session.addEventListener('end', () => {
      state.inXR = false;
      world.visible = true;
      scene.background = new THREE.Color(0x07060f);
      rig.position.set(0, 0, 0); rig.rotation.y = 0;
      heightOffset = Number(store.get('ms-height', 0));
      placeBoard();
      document.body.classList.remove('in-xr');
      drawPanel();
    });
    await renderer.xr.setSession(session);
    state.needsRecenter = true;
    drawPanel();
  } catch (e) {
    alert('Could not start ' + (mode === 'immersive-ar' ? 'passthrough' : 'VR') + ': ' + e.message);
  }
}
$('enter-vr').addEventListener('click', () => enterXR('immersive-vr'));
$('enter-ar').addEventListener('click', () => enterXR('immersive-ar'));
$('play-flat').addEventListener('click', () => { sfx.unlock(); document.body.classList.add('flat-play'); });
$('menu-btn').addEventListener('click', () => document.body.classList.remove('flat-play'));

(async () => {
  const vr = navigator.xr && await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  const ar = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  $('enter-vr').hidden = !vr;
  $('enter-ar').hidden = !ar;
  $('no-xr').hidden = !!(vr || ar);
})();

newGame(game.level);
updateBest();
window.__ms = { game, newGame, dig, toggleFlag, chord, state, pick, boardG, camera };
