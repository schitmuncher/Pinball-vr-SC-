import * as THREE from './vendor/three.module.min.js';
import { PinballEngine, InputType } from './engine.js';
import { GameAudio } from './audio.js';
import { filesFromPicker, hasGameData, saveFiles, loadSavedFiles, forgetFiles } from './files.js';

// Game buttons, using the engine's own game-controller bindings
const BTN = { Plunger: 0, LeftFlipper: 9, RightFlipper: 10, NudgeUp: 11, NudgeLeft: 13, NudgeRight: 14 };
const KEYS = { z: 'z', '/': '/', ' ': ' ', x: 'x', '.': '.', ArrowUp: 'up' };
const SDLK = { z: 122, '/': 47, ' ': 32, x: 120, '.': 46, up: (1 << 30) | 82 };

const TILT = THREE.MathUtils.degToRad(6.5);
const UNIT = 0.035; // metres per table unit: the 16-unit-wide playfield becomes a 56 cm wide table
const PANEL = { x: 384, y: 10, w: 206, h: 400 }; // score panel area inside the 600x416 frame

const $ = (id) => document.getElementById(id);
const state = {
  engine: null, audio: null, files: null, info: null,
  running: false, paused: false, lastTime: 0,
  texts: { 1: '', 2: '' }, panelDirty: true, panelTimer: 0,
  held: new Set(), padPrev: new Map(), mode: 'flat',
  ballInPlunger: false, gameOver: false, needsRecenter: false, handPinch: new Set(),
  heightOffset: Number(localStorage.getItem('scvr-height') || 0),
};

// ---------------------------------------------------------------- three.js setup
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
const IS_QUEST = /OculusBrowser|Quest|Pacific/i.test(navigator.userAgent);
// Fixed foveation: full detail where you look (the table), cheaper at the edges of the lenses
renderer.xr.setFoveation(IS_QUEST ? 1 : 0.5);
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100);
camera.position.set(0, 1.55, 0.35);
scene.add(camera);

const world = new THREE.Group(); // room dressing, hidden in passthrough
scene.add(world);
const rig = new THREE.Group(); // the whole machine; moved when recentering
scene.add(rig);

scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x201830, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.6, 2.5, 1.2);
scene.add(sun);

buildRoom();
const envMap = buildEnvMap();

const gripByHand = {};
// Simple controller shapes so you can see your hands
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  const m = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.1, 16), new THREE.MeshLambertMaterial({ color: 0x2a2840 }));
  handle.rotation.x = -0.9;
  handle.position.set(0, -0.015, 0.03);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 24), new THREE.MeshLambertMaterial({ color: 0x8d86ff, emissive: 0x2a2266 }));
  ring.position.set(0, 0.01, -0.02);
  ring.rotation.x = 0.4;
  m.add(handle, ring);
  grip.add(m);
  grip.addEventListener('connected', (e) => { grip.userData.hand = e.data.handedness; gripByHand[e.data.handedness] = grip; });
  grip.addEventListener('disconnected', () => { if (gripByHand[grip.userData.hand] === grip) delete gripByHand[grip.userData.hand]; });
  scene.add(grip);
}

// Hand tracking: draw each tracked joint as a small glowing bead so you can see your hands
const hands = [0, 1].map((i) => { const h = renderer.xr.getHand(i); scene.add(h); return h; });
const jointGeo = new THREE.SphereGeometry(1, 10, 8);
const jointMat = new THREE.MeshLambertMaterial({ color: 0xc9c4ff, emissive: 0x3a2f99 });
function updateHands() {
  for (const h of hands) {
    if (!h.joints) continue;
    for (const name in h.joints) {
      const j = h.joints[name];
      if (j.userData.bead) continue;
      const bead = new THREE.Mesh(jointGeo, jointMat);
      const r = name.includes('tip') ? 0.0065 : 0.0075;
      bead.scale.setScalar(name === 'wrist' ? 0.012 : r);
      j.add(bead);
      j.userData.bead = bead;
    }
  }
}

// ---------------------------------------------------------------- the room
function buildRoom() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(8, 64),
    new THREE.MeshBasicMaterial({ color: 0x110e1b })
  );
  floor.rotation.x = -Math.PI / 2;
  world.add(floor);

  const grid = new THREE.GridHelper(16, 32, 0x3a2f66, 0x221b3d);
  grid.position.y = 0.002;
  world.add(grid);

  // Starfield dome
  const n = 2500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 30;
    const s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * s * r, Math.abs(u) * r * 0.9 + 1, Math.sin(a) * s * r], i * 3);
    const t = 0.6 + Math.random() * 0.4;
    col.set([t, t, t + Math.random() * 0.2], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  world.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.08, vertexColors: true, sizeAttenuation: true })));
  scene.background = new THREE.Color(0x07060f);
}

function buildEnvMap() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  const grad = x.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#d8e0ff'); grad.addColorStop(0.45, '#6b5fa8'); grad.addColorStop(0.55, '#2a2140'); grad.addColorStop(1, '#0b0814');
  x.fillStyle = grad; x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#ffffff';
  for (let i = 0; i < 6; i++) x.fillRect(20 + i * 40, 18, 18, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(tex).texture;
  pm.dispose();
  return env;
}

// ---------------------------------------------------------------- the machine
let playfield, colorTex, zsTex, bgzTex, ballMeshes = [], shadowMeshes = [], panelCanvas, tableGroup;

function buildMachine(info, eng) {
  const W = info.width, H = info.height;
  const vsStride = eng.x.scp_vscreen_stride();
  const zsStride = eng.x.scp_zscreen_stride();
  state.vsStride = vsStride;
  state.zsStride = zsStride;

  colorTex = new THREE.DataTexture(eng.pixels(W, H), vsStride, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  colorTex.flipY = false;
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.magFilter = THREE.LinearFilter;
  colorTex.minFilter = THREE.LinearFilter;
  colorTex.generateMipmaps = false;
  colorTex.needsUpdate = true;

  const intTex = (data, w, h) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RedIntegerFormat, THREE.UnsignedShortType);
    t.internalFormat = 'R16UI';
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  zsTex = intTex(eng.zscreen(H), zsStride, H);
  const bgz = eng.backgroundZ(info);
  bgzTex = intTex(bgz ? new Uint16Array(bgz) : new Uint16Array(4).fill(65535), bgz ? info.bgzStride : 2, bgz ? info.bgzHeight : 2);

  // Work out which part of the frame is the table so the mesh only covers that
  const tableW = Math.min(bgz ? info.bgzWidth + info.bgzOffsetX : PANEL.x - 10, PANEL.x - 4);
  const tableH = Math.min(H, bgz ? info.bgzHeight + info.bgzOffsetY : H);

  // A grid of vertices over the table; depth comes from the original per-pixel depth maps.
  // On Quest use every other pixel (a quarter of the vertices) to keep the frame rate up;
  // the art is still sampled per pixel so it stays just as sharp.
  const STEP = IS_QUEST ? 2 : 1;
  const cols = Math.ceil(tableW / STEP), rows = Math.ceil(tableH / STEP);
  const pix = new Float32Array(cols * rows * 2);
  for (let y = 0, i = 0; y < rows; y++) for (let x = 0; x < cols; x++, i += 2) {
    pix[i] = Math.min(x * STEP, tableW - 1); pix[i + 1] = Math.min(y * STEP, tableH - 1);
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  for (let y = 0, k = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
    const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
    idx.set([a, c, b, b, c, d], k); k += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('pix', new THREE.BufferAttribute(pix, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cols * rows * 3), 3)); // placeholder, computed in the shader
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

  const M = info.matrix;
  const rt = new THREE.Matrix3().set(M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]);
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uColor: { value: colorTex }, uZs: { value: zsTex }, uBgz: { value: bgzTex },
      uRT: { value: rt }, uT: { value: new THREE.Vector3(M[3], M[7], M[11]) },
      uProj: { value: new THREE.Vector4(info.d, info.cx, info.cy, 0) },
      uZ: { value: new THREE.Vector2(info.zmin, info.zscaler) },
      uBgzOff: { value: new THREE.Vector2(info.bgzOffsetX, info.bgzOffsetY) },
      uBgzSize: { value: new THREE.Vector2(bgz ? info.bgzWidth : 0, bgz ? info.bgzHeight : 0) },
      uSize: { value: new THREE.Vector2(vsStride, H) },
      uUnit: { value: UNIT },
      uLight: { value: new THREE.Vector3(0.35, 1, 0.5).normalize() },
    },
    vertexShader: /* glsl */`
      precision highp float; precision highp usampler2D;
      in vec2 pix;
      uniform usampler2D uZs, uBgz;
      uniform mat3 uRT; uniform vec3 uT; uniform vec4 uProj; uniform vec2 uZ, uBgzOff, uBgzSize, uSize; uniform float uUnit;
      out vec2 vUv; out float vValid; out vec3 vPos;
      void main() {
        ivec2 ip = ivec2(pix);
        uint z = texelFetch(uZs, ip, 0).r;
        ivec2 bp = ip - ivec2(uBgzOff);
        if (bp.x >= 0 && bp.y >= 0 && float(bp.x) < uBgzSize.x && float(bp.y) < uBgzSize.y)
          z = min(z, texelFetch(uBgz, bp, 0).r);
        vValid = z < 65535u ? 1.0 : 0.0;
        float dist = float(z) / uZ.y + uZ.x;
        vec3 v = vec3((pix.x - uProj.y) / uProj.x, (pix.y - uProj.z) / uProj.x, 1.0);
        vec3 cam = v * (dist / length(v));
        vec3 w = uRT * (cam - uT);
        // A few stray depth values in the original data would make spikes; nothing on the table is that tall
        if (w.z > 3.0 || w.z < -2.5) vValid = 0.0;
        vec3 p = vec3(-w.x, w.z, w.y) * uUnit;
        vPos = p;
        vUv = (pix + 0.5) / uSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uColor; uniform vec3 uLight;
      in vec2 vUv; in float vValid; in vec3 vPos;
      out vec4 fragColor;
      void main() {
        if (vValid < 0.999) discard;
        vec3 c = texture(uColor, vUv).bgr;
        vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
        if (n.y < 0.0) n = -n;
        float wall = 1.0 - smoothstep(0.35, 0.8, n.y);
        float lit = 0.8 + 0.3 * max(dot(n, uLight), 0.0);
        c *= mix(1.0, lit * 0.62, wall);
        fragColor = linearToOutputTexel(vec4(c, 1.0));
      }`,
  });
  mat.toneMapped = false;
  playfield = new THREE.Mesh(geo, mat);
  playfield.frustumCulled = false;

  // Table bounds in metres (measured from the depth map) for cabinet sizing
  const b = measureTable(info, bgz, tableW, tableH);
  tableGroup = new THREE.Group();
  tableGroup.add(playfield);

  // Ball(s): real spheres instead of the flat ball sprite
  const ballGeo = new THREE.SphereGeometry(info.ballRadius * UNIT, 32, 20);
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 1, roughness: 0.12, envMap, envMapIntensity: 1.3 });
  const shadowTex = radialTexture();
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(ballGeo, ballMat);
    m.visible = false;
    tableGroup.add(m);
    ballMeshes.push(m);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(info.ballRadius * UNIT * 3, info.ballRadius * UNIT * 3),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55 }));
    s.rotation.x = -Math.PI / 2;
    s.visible = false;
    tableGroup.add(s);
    shadowMeshes.push(s);
  }

  // Center the playfield in its tilted frame
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  tableGroup.position.set(-cx, 0, -cz);
  const tilt = new THREE.Group();
  tilt.rotation.x = TILT;
  tilt.add(tableGroup);

  const machine = new THREE.Group();
  machine.add(tilt);
  buildCabinet(machine, b, cx, cz);
  rig.add(machine);
  state.machine = machine;
  state.tableBounds = b;
  placeMachineDefault();
}

function measureTable(info, bgz, w, h) {
  const M = info.matrix;
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, maxY = -1e9;
  if (bgz) {
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const bx = x - info.bgzOffsetX, by = y - info.bgzOffsetY;
      if (bx < 0 || by < 0 || bx >= info.bgzWidth || by >= info.bgzHeight) continue;
      const z = bgz[by * info.bgzStride + bx];
      if (z === 65535) continue;
      const dist = z / info.zscaler + info.zmin;
      const vx = (x - info.cx) / info.d, vy = (y - info.cy) / info.d;
      const k = dist / Math.hypot(vx, vy, 1);
      const c = [vx * k - M[3], vy * k - M[7], k - M[11]];
      const wx = M[0] * c[0] + M[4] * c[1] + M[8] * c[2];
      const wy = M[1] * c[0] + M[5] * c[1] + M[9] * c[2];
      const wz = M[2] * c[0] + M[6] * c[1] + M[10] * c[2];
      minX = Math.min(minX, -wx); maxX = Math.max(maxX, -wx);
      minZ = Math.min(minZ, wy); maxZ = Math.max(maxZ, wy);
      if (wz < 4) maxY = Math.max(maxY, wz);
    }
  }
  if (minX > maxX) { minX = -8; maxX = 8; minZ = -14; maxZ = 13.5; maxY = 1.5; }
  return { minX: minX * UNIT, maxX: maxX * UNIT, minZ: minZ * UNIT, maxZ: maxZ * UNIT, maxY: maxY * UNIT };
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(120,90,255,0.55)'); g.addColorStop(0.5, 'rgba(60,140,255,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Original abstract side art: deep-space gradient, stars and a swoosh
function makeSideArt() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 160;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1024, 0);
  g.addColorStop(0, '#120c2e'); g.addColorStop(0.5, '#24135a'); g.addColorStop(1, '#0c1838');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 160);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const r = rnd() * 1.6 + 0.3;
    x.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.7})`;
    x.beginPath(); x.arc(rnd() * 1024, rnd() * 160, r, 0, Math.PI * 2); x.fill();
  }
  for (const [col, off, wdt] of [['rgba(154,123,255,0.85)', 0, 10], ['rgba(55,224,255,0.75)', 18, 5]]) {
    x.strokeStyle = col; x.lineWidth = wdt; x.lineCap = 'round';
    x.beginPath(); x.moveTo(30, 130 - off);
    x.bezierCurveTo(300, 150 - off, 520, 20 - off, 1000, 40 - off);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Merge a group's static meshes that share a material into one mesh each: same look, far fewer draw calls
function mergeStatic(group) {
  const byMat = new Map();
  for (const ch of group.children) {
    if (!ch.isMesh || ch.userData.dynamic) continue;
    if (!byMat.has(ch.material)) byMat.set(ch.material, []);
    byMat.get(ch.material).push(ch);
  }
  for (const [mat, list] of byMat) {
    if (list.length < 2) continue;
    const parts = list.map((m) => {
      m.updateMatrix();
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(m.matrix);
      return g;
    });
    const n = parts.reduce((t, g) => t + g.attributes.position.count, 0);
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const g of parts) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += c;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    for (const m of list) group.remove(m);
    group.add(new THREE.Mesh(geo, mat));
  }
}

function buildCabinet(machine, b, cx, cz) {
  const w = b.maxX - b.minX, len = b.maxZ - b.minZ;
  // Lambert shading: plenty for painted wood and brushed metal, and far cheaper than PBR on a Quest 2
  const body = new THREE.MeshLambertMaterial({ color: 0x1d1a3e, emissive: 0x0c0a22 });
  const trim = new THREE.MeshLambertMaterial({ color: 0x8a8fa6, emissive: 0x1a1a24, envMap, reflectivity: 0.35 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x08080c });

  // Everything that follows the playfield tilt
  const tilt = machine.children[0];
  const sideH = 0.16, wall = 0.025, depthBelow = 0.14;
  const tub = new THREE.Group();
  tilt.add(tub);
  const box = (sx, sy, sz, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.set(x, y, z); tub.add(o); return o; };
  box(w + wall * 2, 0.02, len + wall * 2, dark, 0, -0.012, 0);                 // floor under the art
  box(wall, sideH, len + wall * 2, body, -w / 2 - wall / 2, sideH / 2 - depthBelow, 0); // sides
  box(wall, sideH, len + wall * 2, body, w / 2 + wall / 2, sideH / 2 - depthBelow, 0);
  box(w + wall * 2, sideH, wall, body, 0, sideH / 2 - depthBelow, len / 2 + wall / 2); // front
  box(w + wall * 2, sideH, wall, body, 0, sideH / 2 - depthBelow, -len / 2 - wall / 2); // back
  box(wall * 1.3, 0.012, len + wall * 2.4, trim, -w / 2 - wall / 2, sideH - depthBelow + 0.006, 0); // rails
  box(wall * 1.3, 0.012, len + wall * 2.4, trim, w / 2 + wall / 2, sideH - depthBelow + 0.006, 0);
  box(w + wall * 3, 0.03, 0.06, trim, 0, sideH - depthBelow - 0.01, len / 2 + wall + 0.03); // lockdown bar

  // Side art and neon trim
  const sideArt = makeSideArt();
  for (const sx of [-1, 1]) {
    const art = new THREE.Mesh(new THREE.PlaneGeometry(len + wall * 2, sideH * 0.92),
      new THREE.MeshLambertMaterial({ map: sideArt, emissive: 0xffffff, emissiveMap: sideArt, emissiveIntensity: 0.45 }));
    art.position.set(sx * (w / 2 + wall + 0.0008), sideH / 2 - depthBelow, 0);
    art.rotation.y = sx * Math.PI / 2;
    tub.add(art);
  }
  const neon = (color) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const neonB = neon(0x37e0ff);
  const sideNeon = { left: neon(0x9a7bff), right: neon(0x9a7bff) };
  box(0.006, 0.006, len + wall * 2, sideNeon.left, -w / 2 - wall - 0.003, -depthBelow + 0.004, 0);
  box(0.006, 0.006, len + wall * 2, sideNeon.right, w / 2 + wall + 0.003, -depthBelow + 0.004, 0);
  // A brighter rail along the top of each side: lights up when your hand can grab that side
  for (const [side, sx] of [['left', -1], ['right', 1]]) {
    box(0.004, 0.004, len - 0.2, sideNeon[side], sx * (w / 2 + wall + 0.003), sideH - depthBelow - 0.006, -0.1);
  }
  state.cab = { w, len, sideH, depthBelow, wall, tub, sideNeon };
  box(w + wall * 2, 0.006, 0.006, neonB, 0, -depthBelow + 0.004, len / 2 + wall + 0.003);

  // Front panel: a lit coin door
  const door = new THREE.Group();
  const doorPlate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.006), trim);
  door.add(doorPlate);
  for (const dx of [-0.05, 0.05]) {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.006), body);
    bezel.position.set(dx, 0.01, 0.004);
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.026, 0.004), neon(0xff3355));
    slot.position.set(dx, 0.012, 0.008);
    door.add(bezel, slot);
  }
  const ret = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.006), dark);
  ret.position.set(0, -0.034, 0.004);
  door.add(ret);
  door.position.set(0, sideH / 2 - depthBelow - 0.005, len / 2 + wall + 0.004);
  tub.add(door);

  // Flipper buttons on the cabinet sides (they light while pressed)
  const btnGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.012, 20);
  btnGeo.rotateZ(Math.PI / 2);
  state.flipButtons = [-1, 1].map((s) => {
    const m = new THREE.Mesh(btnGeo, new THREE.MeshLambertMaterial({ color: 0xff3366, emissive: 0x330011 }));
    m.position.set(s * (w / 2 + wall + 0.004), sideH - depthBelow - 0.05, len / 2 - 0.08);
    tub.add(m);
    return m;
  });

  // Legs and backbox stay level
  const frontY = -Math.sin(TILT) * (len / 2), backY = Math.sin(TILT) * (len / 2);
  const legGeo = new THREE.BoxGeometry(0.05, 1, 0.05);
  const legs = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
  for (const [sx, sz] of legs) {
    const topY = (sz > 0 ? frontY : backY) - depthBelow;
    const h = 0.9 + topY;
    const leg = new THREE.Mesh(legGeo, trim);
    leg.scale.y = h;
    leg.position.set(sx * (w / 2), topY - h / 2, sz * (len / 2 - 0.03) * Math.cos(TILT));
    machine.add(leg);
  }

  // Backbox showing the original score panel as the backglass
  panelCanvas = document.createElement('canvas');
  panelCanvas.width = PANEL.w * 2;
  panelCanvas.height = PANEL.h * 2;
  const glassH = 0.62, glassW = glassH * (PANEL.w / PANEL.h);
  const bbW = Math.max(w + wall * 2, glassW + 0.12), bbH = glassH + 0.1;
  const backbox = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(bbW, bbH, 0.16), body);
  backbox.add(shell);
  // The backglass reads the score panel straight out of the table texture, so it costs no extra uploads
  const glassMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uColor: { value: colorTex },
      uRect: { value: new THREE.Vector4(PANEL.x / state.vsStride, PANEL.y / state.info.height, PANEL.w / state.vsStride, PANEL.h / state.info.height) },
    },
    vertexShader: `out vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float; uniform sampler2D uColor; uniform vec4 uRect; in vec2 vUv; out vec4 fragColor;
      void main() { vec2 t = uRect.xy + vec2(vUv.x, 1.0 - vUv.y) * uRect.zw; fragColor = linearToOutputTexel(vec4(texture(uColor, t).bgr, 1.0)); }`,
  });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(glassW, glassH), glassMat);
  glass.position.z = 0.081;
  backbox.add(glass);
  // Glowing frame around the backglass
  const frameMat = neon(0x9a7bff);
  for (const [fw, fh, fx, fy] of [[glassW + 0.02, 0.008, 0, glassH / 2 + 0.008], [glassW + 0.02, 0.008, 0, -glassH / 2 - 0.008],
    [0.008, glassH + 0.024, glassW / 2 + 0.008, 0], [0.008, glassH + 0.024, -glassW / 2 - 0.008, 0]]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.006), frameMat);
    f.position.set(fx, fy, 0.082);
    backbox.add(f);
  }

  const trimTop = new THREE.Mesh(new THREE.BoxGeometry(bbW + 0.01, 0.02, 0.17), trim);
  trimTop.position.y = bbH / 2;
  backbox.add(trimTop);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(bbW * 0.9, 0.1, 0.12), body);
  neck.position.y = -bbH / 2 - 0.03;
  backbox.add(neck);
  backbox.position.set(0, backY - depthBelow + sideH + 0.06 + bbH / 2, -len / 2 * Math.cos(TILT) - 0.09);
  machine.add(backbox);
  mergeStatic(tub);
  mergeStatic(door);
  mergeStatic(backbox);

  // Soft glow on the floor under the machine (its height is set in placeMachineDefault)
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.9, len + 0.9),
    new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  glow.rotation.x = -Math.PI / 2;
  machine.add(glow);
  state.floorGlow = glow;

  // Status sign floating just past the lockdown bar: launch hint, pause, game over
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 1024; signCanvas.height = 128;
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.055),
    new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false, toneMapped: false }));
  sign.position.set(0, frontY - depthBelow + sideH + 0.06, (len / 2) * Math.cos(TILT) + 0.02);
  sign.rotation.x = -0.55;
  sign.visible = false;
  machine.add(sign);
  state.sign = { mesh: sign, canvas: signCanvas, tex: signTex, text: '' };

  // Help card on the left of the cabinet
  const help = makeHelpCard();
  help.position.set(-w / 2 - 0.32, 0.1, 0.05);
  help.rotation.set(-0.5, 0.45, 0);
  help.visible = false;
  machine.add(help);
  state.helpCard = help;
  mergeStatic(machine); // the four legs
}

function makeHelpCard() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 492;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(12,10,30,0.86)';
  x.fillRect(0, 0, 512, 492);
  x.strokeStyle = '#7f7cff'; x.lineWidth = 4; x.strokeRect(2, 2, 508, 488);
  x.fillStyle = '#fff'; x.font = 'bold 34px system-ui, sans-serif';
  x.fillText('Controls', 24, 50);
  x.font = '25px system-ui, sans-serif';
  const lines = [
    ['Triggers', 'Flippers'],
    ['A or X (hold)', 'Pull plunger, let go to launch'],
    ['Grip on a side rail', 'Grab: move and turn the table'],
    ['Grip elsewhere', 'Nudge (both grips: nudge up)'],
    ['B', 'Pause'],
    ['Y', 'New game'],
    ['Left stick ↑↓', 'Table height'],
    ['Left stick click', 'Move table in front of you'],
    ['Hands only', 'Pinch to flip, both to launch'],
  ];
  x.fillStyle = '#8f8cc0'; x.font = '21px system-ui, sans-serif';
  x.fillText('Shows while paused. Too many nudges will tilt!', 24, 467);
  lines.forEach(([a, b], i) => {
    x.fillStyle = '#b9b6ff'; x.fillText(a, 24, 100 + i * 42);
    x.fillStyle = '#e8e8f0'; x.fillText(b, 230, 100 + i * 42);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.384), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false }));
}

function placeMachineDefault() {
  const b = state.tableBounds;
  const len = b.maxZ - b.minZ;
  state.machine.position.set(0, 0.9 + Math.sin(TILT) * len / 2 + state.heightOffset, -len / 2 - 0.22);
  if (state.floorGlow) state.floorGlow.position.y = -state.machine.position.y + 0.004;
}

// Recenter: put the machine in front of wherever the player is now standing and facing
function recenter() {
  const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  xrCam.getWorldPosition(p);
  xrCam.getWorldQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  fwd.y = 0; fwd.normalize();
  const yaw = Math.atan2(-fwd.x, -fwd.z);
  rig.position.set(p.x, 0, p.z);
  rig.rotation.y = yaw;
}

// ---------------------------------------------------------------- score panel (backglass)
function drawPanel() {
  const eng = state.engine, info = state.info;
  const ctx = panelCanvas.getContext('2d');
  const stride = eng.x.scp_vscreen_stride();
  const src = eng.pixels(info.width, info.height);
  const img = ctx.createImageData(PANEL.w, PANEL.h);
  for (let y = 0; y < PANEL.h; y++) {
    let si = ((PANEL.y + y) * stride + PANEL.x) * 4, di = y * PANEL.w * 4;
    for (let x = 0; x < PANEL.w; x++, si += 4, di += 4) {
      img.data[di] = src[si + 2]; img.data[di + 1] = src[si + 1]; img.data[di + 2] = src[si]; img.data[di + 3] = 255;
    }
  }
  const tmp = drawPanel.tmp || (drawPanel.tmp = document.createElement('canvas'));
  tmp.width = PANEL.w; tmp.height = PANEL.h;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, panelCanvas.width, panelCanvas.height);

  updateFlatHud();
}

function updateFlatHud() {
  if (state.mode !== 'flat') return;
  const hud = $('hud-panel');
  if (!hud.firstChild) hud.appendChild(panelCanvas);
}

// ---------------------------------------------------------------- engine wiring
async function startEngine(files) {
  const audio = new GameAudio(files);
  state.audio = audio;
  let highScore = Number(localStorage.getItem('scvr-highscore') || 0);
  const eng = new PinballEngine(files, {
    log: (m) => console.log('[engine]', m),
    loadSound: (p, d) => audio.loadSound(p, d),
    playSound: (id) => audio.playSound(id),
    stopSounds: () => audio.stopSounds(),
    soundVolume: (v) => audio.soundVolume(v),
    loadMusic: (p, d) => audio.loadMusic(p, d),
    playMusic: (id) => audio.playMusic(id),
    stopMusic: () => audio.stopMusic(),
    musicVolume: (v) => audio.musicVolume(v),
    getHighScore: () => highScore,
    text: (t, type) => { state.texts[type] = t; state.panelDirty = true; },
    event: (kind, value) => {
      if (kind === 4 && value > highScore) { highScore = value; localStorage.setItem('scvr-highscore', String(value)); }
      if (kind === 9) { state.texts[value] = ''; state.panelDirty = true; }
      if (kind === 5 || kind === 6 || kind === 7) state.panelDirty = true;
      if (kind === 3) { if (state.ballInPlunger && value === 0) state.hasLaunched = true; state.ballInPlunger = value === 1; }
      if (kind === 5) { state.score = value; updateMiniScore(); }
      if (kind === 6) { state.ball = value; updateMiniScore(); }
      if (kind === 2) {
        const over = value === 2;
        if (over && !state.gameOver) {
          localStorage.setItem('scvr-last', String(state.score || 0));
          updateStats();
        }
        state.gameOver = over;
      }
    },
  });
  const wasm = await WebAssembly.compileStreaming(fetch('engine.wasm'));
  await eng.load(wasm);
  const music = localStorage.getItem('scvr-music') === '1';
  if (eng.init(music) !== 0) throw new Error('The game could not read PINBALL.DAT');
  eng.x.scp_hide_2d_balls(1);
  state.engine = eng;
  state.info = eng.info();
  // A light buzz in both hands whenever the table makes a sound (bumpers, targets, kickers...)
  let lastBuzz = 0;
  audio.onSound = () => {
    const now = performance.now();
    if (now - lastBuzz < 60) return;
    lastBuzz = now;
    const session = renderer.xr.getSession();
    if (session) for (const src of session.inputSources) pulse(src, 0.18, 18);
  };
  buildMachine(state.info, eng);
  // The first start after loading only ends the attract light show; start a real game
  for (let i = 0; i < 10; i++) eng.frame(16);
  eng.x.scp_new_game();
  state.running = true;
  drawPanel();
}

function press(button, down) {
  const key = 'b' + button;
  if (down === state.held.has(key)) return;
  if (down) state.held.add(key); else state.held.delete(key);
  state.engine.input(InputType.Controller, button, down);
  if (button === BTN.LeftFlipper || button === BTN.RightFlipper) {
    const m = state.flipButtons && state.flipButtons[button === BTN.LeftFlipper ? 0 : 1];
    if (m) m.material.emissive.setHex(down ? 0xff2255 : 0x330011);
  }
}

function newGame() { if (state.paused) togglePause(false); state.pausedByMenu = false; state.engine.x.scp_new_game(); state.paused = false; state.gameOver = false; state.hasLaunched = false; state.texts = { 1: '', 2: '' }; state.panelDirty = true; }
function togglePause(force) {
  if (force !== undefined && force === state.paused) return;
  state.engine.x.scp_pause();
  state.paused = !!state.engine.x.scp_is_paused();
  if (state.paused) state.audio.ctx.suspend().catch(() => {}); else state.audio.resume();
  if (state.paused) for (const key of [...state.held]) press(Number(key.slice(1)), false);
}

// ---------------------------------------------------------------- XR controllers
// Triggers flip. Grips nudge: left grip nudges left, right grip right, both together nudge up.
// The right stick also nudges, for anyone who prefers it.
function pollXR() {
  const session = renderer.xr.getSession();
  if (!session) return;
  const sources = {};
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp || src.hand || (src.handedness !== 'left' && src.handedness !== 'right')) continue;
    const left = src.handedness === 'left';
    const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
    const prev = state.padPrev.get(src.handedness) || {};
    const ax = gp.axes[2] || 0, ay = gp.axes[3] || 0;
    const now = {
      flip: b(0), grip: b(1), plunge: b(4), menu: b(5), stick: b(3),
      sl: !left && ax < -0.75, sr: !left && ax > 0.75, su: !left && ay < -0.75,
    };
    sources[src.handedness] = { src, now, prev };

    if ((now.flip && !prev.flip) || (now.plunge && !prev.plunge) || (now.grip && !prev.grip)) state.audio.resume();
    press(left ? BTN.LeftFlipper : BTN.RightFlipper, now.flip);
    if (now.flip && !prev.flip) pulse(src, 0.35, 25);
    if (!now.plunge && prev.plunge) pulse(src, 0.8, 60);

    if (left) {
      if (Math.abs(ay) > 0.3) {
        state.heightOffset = THREE.MathUtils.clamp(state.heightOffset - ay * 0.004, -0.4, 0.4);
        placeMachineDefault();
        localStorage.setItem('scvr-height', state.heightOffset.toFixed(3));
      }
      if (now.stick && !prev.stick) recenter();
      if (now.menu && !prev.menu) newGame();
    } else if (now.menu && !prev.menu) togglePause();
    state.padPrev.set(src.handedness, now);
  }

  const L = sources.left, R = sources.right;
  updateGrab(L, R);
  const gl = !!(L && L.now.grip && state.gripMode.left === 'nudge');
  const gr = !!(R && R.now.grip && state.gripMode.right === 'nudge');
  const stick = R ? R.now : {};
  const nudge = { left: (gl && !gr) || !!stick.sl, right: (gr && !gl) || !!stick.sr, up: (gl && gr) || !!stick.su };
  const was = state.nudgeHeld || {};
  press(BTN.NudgeLeft, nudge.left);
  press(BTN.NudgeRight, nudge.right);
  press(BTN.NudgeUp, nudge.up);
  if ((nudge.left && !was.left) || (nudge.right && !was.right) || (nudge.up && !was.up)) {
    for (const h of [L, R]) if (h) pulse(h.src, 0.7, 70);
    shakeTable(nudge.left ? -1 : nudge.right ? 1 : 0, nudge.up ? 1 : 0);
  }
  state.plungeHeld = !!((L && L.now.plunge) || (R && R.now.plunge));
  press(BTN.Plunger, state.plungeHeld || state.handPinch.size === 2);
  state.nudgeHeld = nudge;
}

function updateShake(dt) {
  const tilt = state.machine && state.machine.children[0];
  if (!tilt) return;
  const sh = state.shake;
  if (!sh) { tilt.position.set(0, 0, 0); return; }
  sh.t += dt;
  const k = Math.max(0, 1 - sh.t / 180) * Math.sin(sh.t / 180 * Math.PI);
  tilt.position.set(sh.dx * 0.006 * k, 0, -sh.dz * 0.008 * k);
  if (sh.t >= 180) state.shake = null;
}

// ---------------------------------------------------------------- grabbing the table
// Squeeze a grip with your hand on a side rail to hold the table. One hand carries and turns it like
// any object you'd pick up; two hands move it and turn it between them. It always stays level.
const _hp = new THREE.Vector3(), _lp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _fw = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _off = new THREE.Vector3();
const YAXIS = new THREE.Vector3(0, 1, 0);
state.gripMode = { left: null, right: null };
state.grabHands = new Set();
state.hover = { left: null, right: null };

function handPos(hand, out) {
  const g = gripByHand[hand];
  return g ? g.getWorldPosition(out) : null;
}
function handYaw(hand) {
  const g = gripByHand[hand];
  g.getWorldQuaternion(_hq);
  _fw.set(0, 0, -1).applyQuaternion(_hq);
  return Math.atan2(-_fw.x, -_fw.z);
}
// Which side rail (if any) a hand is close enough to grab
function sideInReach(hand) {
  const c = state.cab;
  if (!c || !handPos(hand, _hp)) return null;
  const p = c.tub.worldToLocal(_lp.copy(_hp));
  const edge = c.w / 2 + c.wall, ax = Math.abs(p.x);
  if (ax < edge - 0.07 || ax > edge + 0.13) return null;
  if (p.z < -c.len / 2 - 0.08 || p.z > c.len / 2 - 0.22) return null; // not the front, where you play
  if (p.y < -c.depthBelow - 0.12 || p.y > c.sideH - c.depthBelow + 0.16) return null;
  return p.x < 0 ? 'left' : 'right';
}

function anchorGrab() {
  const hs = [...state.grabHands];
  const g = { hands: hs, rigPos: rig.position.clone(), rigYaw: rig.rotation.y };
  if (hs.length === 1) {
    g.p0 = handPos(hs[0], new THREE.Vector3());
    g.yaw0 = handYaw(hs[0]);
  } else if (hs.length === 2) {
    handPos('left', _a); handPos('right', _b);
    g.p0 = _a.clone().add(_b).multiplyScalar(0.5);
    g.yaw0 = Math.atan2(-(_b.z - _a.z), _b.x - _a.x);
  }
  state.grab = hs.length ? g : null;
}

function updateGrab(L, R) {
  for (const [hand, h] of [['left', L], ['right', R]]) {
    const down = !!(h && h.now.grip), was = !!(h && h.prev.grip);
    const reach = h && gripByHand[hand] ? sideInReach(hand) : null;
    if (reach && reach !== state.hover[hand] && !down && h) pulse(h.src, 0.15, 12);
    state.hover[hand] = reach;
    if (down && !was) {
      if (reach) {
        state.gripMode[hand] = 'grab';
        state.grabHands.add(hand);
        pulse(h.src, 0.5, 40);
        anchorGrab();
      } else state.gripMode[hand] = 'nudge';
    } else if (!down && state.gripMode[hand]) {
      if (state.gripMode[hand] === 'grab') { state.grabHands.delete(hand); anchorGrab(); }
      state.gripMode[hand] = null;
    }
  }
  // Drop a grab if a controller vanished mid-grab
  for (const hand of state.grabHands) if (!gripByHand[hand]) { state.grabHands.delete(hand); anchorGrab(); }

  const g = state.grab;
  if (g) {
    let p, yaw;
    if (g.hands.length === 1) {
      p = handPos(g.hands[0], _a);
      yaw = handYaw(g.hands[0]);
    } else {
      handPos('left', _a); handPos('right', _b);
      yaw = Math.atan2(-(_b.z - _a.z), _b.x - _a.x);
      p = _a.add(_b).multiplyScalar(0.5);
    }
    const dyaw = yaw - g.yaw0;
    _off.copy(g.rigPos).sub(g.p0).applyAxisAngle(YAXIS, dyaw);
    rig.position.copy(p).add(_off);
    rig.position.y = THREE.MathUtils.clamp(rig.position.y, -0.6, 0.8);
    rig.rotation.y = g.rigYaw + dyaw;
  }

  // Rails: purple normally, white when in reach, cyan while held
  const c = state.cab;
  if (c) for (const side of ['left', 'right']) {
    const hover = state.hover.left === side || state.hover.right === side;
    c.sideNeon[side].color.setHex(state.grabHands.size && hover ? 0x37e0ff : hover ? 0xffffff : 0x9a7bff);
  }
}

// A small visible bump of the cabinet when you nudge it
function shakeTable(dx, dz) {
  if (!state.machine) return;
  state.shake = { t: 0, dx, dz };
}

function releaseAll() {
  for (const key of [...state.held]) press(Number(key.slice(1)), false);
  state.padPrev.clear();
  state.handPinch.clear();
}

// Hand tracking: pinch with a hand to flip that side, pinch with both hands to pull the plunger
function handPinch(e, down) {
  const src = e.inputSource;
  if (!src.hand || (src.handedness !== 'left' && src.handedness !== 'right')) return;
  if (down) state.handPinch.add(src.handedness); else state.handPinch.delete(src.handedness);
  state.audio.resume();
  press(src.handedness === 'left' ? BTN.LeftFlipper : BTN.RightFlipper, down);
  press(BTN.Plunger, state.handPinch.size === 2);
}

function updateHelpCard(dt) {
  const card = state.helpCard;
  if (!card) return;
  const want = renderer.xr.isPresenting && (state.paused || !state.hasLaunched || state.gameOver);
  const m = card.material;
  m.opacity = THREE.MathUtils.clamp(m.opacity + (want ? 1 : -1) * dt / 300, 0, 1);
  card.visible = m.opacity > 0.01;
}

function updateSign() {
  const sg = state.sign;
  if (!sg) return;
  const xr = renderer.xr.isPresenting;
  const handsOnly = xr && state.handsOnly;
  let text = '';
  if (state.paused) text = 'Paused \u00b7 press B to carry on';
  else if (state.gameOver) text = 'Game over \u00b7 press Y for a new game';
  else if (state.ballInPlunger) text = handsOnly ? 'Pinch with both hands, then let go to launch' : 'Hold A or X, then let go to launch';
  sg.mesh.visible = xr && !!text;
  if (!xr) {
    const touch = matchMedia('(pointer: coarse)').matches;
    let flat = '';
    if (state.paused) flat = touch ? 'Paused \u00b7 tap to carry on' : 'Paused \u00b7 press P to carry on';
    else if (state.gameOver) flat = touch ? 'Game over \u00b7 open Menu for a new game' : 'Game over \u00b7 F2 for a new game';
    else if (state.ballInPlunger) flat = touch ? 'Hold the middle, then let go to launch' : 'Hold Space, then let go to launch';
    const banner = $('banner');
    if (banner.textContent !== flat) banner.textContent = flat;
  }
  if (text === sg.text) return;
  sg.text = text;
  const x = sg.canvas.getContext('2d');
  x.clearRect(0, 0, 1024, 128);
  if (!text) return;
  x.font = 'bold 54px system-ui, sans-serif';
  const w = Math.min(1000, x.measureText(text).width + 70);
  x.fillStyle = 'rgba(12,10,30,0.82)';
  x.beginPath(); x.roundRect((1024 - w) / 2, 14, w, 100, 50); x.fill();
  x.fillStyle = '#ecebff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 512, 66);
  sg.tex.needsUpdate = true;
}

function pulse(src, strength, ms) {
  const h = src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
  if (h && h.pulse) h.pulse(strength, ms);
  else if (src.gamepad && src.gamepad.vibrationActuator) src.gamepad.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength });
}

// ---------------------------------------------------------------- per-frame update
const tmpV = new THREE.Vector3();
// Upload just the changed rectangle of a texture straight from the engine's memory.
// Full-frame uploads stall the Quest's GPU; a small patch is close to free.
const gl = renderer.getContext();
function uploadPatch(tex, data, stride, x0, y0, x1, y1, format, type) {
  const props = renderer.properties.get(tex);
  if (!props.__webglTexture || props.__version !== tex.version) { tex.image.data = data; tex.needsUpdate = true; return; }
  renderer.state.activeTexture(gl.TEXTURE0);
  renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, format, type, data);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

function updateTable() {
  const eng = state.engine, info = state.info;
  const d = eng.takeDirty();
  if (d[2] > d[0] && d[3] > d[1]) {
    const x0 = Math.max(0, d[0]), y0 = Math.max(0, d[1]);
    const x1 = Math.min(state.vsStride, d[2]), y1 = Math.min(info.height, d[3]);
    if (x1 > x0 && y1 > y0) {
      uploadPatch(colorTex, eng.pixels(info.width, info.height), state.vsStride, x0, y0, x1, y1, gl.RGBA, gl.UNSIGNED_BYTE);
      uploadPatch(zsTex, eng.zscreen(info.height), state.zsStride, x0, y0, x1, y1, gl.RED_INTEGER, gl.UNSIGNED_SHORT);
      if (x1 > PANEL.x) state.panelDirty = true;
    }
  }

  const balls = eng.balls();
  const r = info.ballRadius;
  for (let i = 0; i < ballMeshes.length; i++) {
    const b = i < balls.count ? balls[i] : null, m = ballMeshes[i], s = shadowMeshes[i];
    const vis = !!(b && b.visible);
    m.visible = s.visible = vis;
    if (!vis) continue;
    m.position.set(-b.x * UNIT, b.z * UNIT, b.y * UNIT);
    s.position.set(-b.x * UNIT + 0.002, (b.z - r) * UNIT + 0.0015, b.y * UNIT + 0.003);
  }
}

let acc = 0;
function loop(time) {
  const dt = state.lastTime ? Math.min(time - state.lastTime, 100) : 16;
  state.lastTime = time;
  if (state.needsRecenter && renderer.xr.isPresenting) {
    // Wait for a real head pose, then put the table in front of wherever the player is facing
    const p = new THREE.Vector3();
    renderer.xr.getCamera().getWorldPosition(p);
    if (p.lengthSq() > 0) { recenter(); state.needsRecenter = false; }
  }
  if (state.running) {
    pollXR();
    if (!state.paused) {
      // Step the physics in small slices like the original 120 updates/sec
      acc += dt;
      while (acc > 0) {
        const step = Math.min(acc, 1000 / 120);
        state.engine.frame(step);
        acc -= step;
      }
    }
    updateTable();
    updateSign();
    updateShake(dt);
    updateHelpCard(dt);
    updateHands();
    state.panelTimer += dt;
    // The flat-screen score panel is a 2D canvas; in VR the backglass shows it for free
    if (!renderer.xr.isPresenting && state.panelDirty && state.panelTimer > 100) { state.panelTimer = 0; state.panelDirty = false; drawPanel(); }
  }
  if (!renderer.xr.isPresenting) updateFlatCamera(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop);
window.__scvr = state;
state.debug = { THREE, gripByHand, updateGrab, sideInReach, rig, renderer };

// ---------------------------------------------------------------- flat-screen view
// The camera frames the whole table on any screen shape; drag and scroll adjust from there
const orbit = { yaw: 0, pitch: null, zoom: 1, drag: null };
state.orbit = orbit;
function updateFlatCamera() {
  if (!state.machine) return;
  const target = new THREE.Vector3();
  state.machine.getWorldPosition(target);
  target.y -= 0.02;
  target.z += 0.08;
  const aspect = camera.aspect;
  if (orbit.pitch === null) orbit.pitch = aspect < 1 ? 1.2 : 0.95;
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const fitWidth = 0.37 / (Math.tan(halfFov) * aspect);
  const d = Math.max(0.95, fitWidth) * orbit.zoom;
  camera.position.set(target.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * d,
    target.y + Math.sin(orbit.pitch) * d, target.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * d);
  camera.lookAt(target);
}
renderer.domElement.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') orbit.drag = [e.clientX, e.clientY]; });
addEventListener('pointerup', () => (orbit.drag = null));
addEventListener('pointermove', (e) => {
  if (!orbit.drag) return;
  orbit.yaw -= (e.clientX - orbit.drag[0]) * 0.005;
  orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (e.clientY - orbit.drag[1]) * 0.005, 0.1, 1.45);
  orbit.drag = [e.clientX, e.clientY];
});
renderer.domElement.addEventListener('wheel', (e) => { orbit.zoom = THREE.MathUtils.clamp(orbit.zoom * (1 + e.deltaY * 0.001), 0.5, 2.5); }, { passive: true });

addEventListener('keydown', (e) => {
  if (!state.running) return;
  if (e.key === 'F2') { newGame(); e.preventDefault(); return; }
  if (e.key === 'F3' || e.key === 'p') { togglePause(); return; }
  const k = KEYS[e.key];
  if (!k || e.repeat) return;
  state.audio.resume();
  state.engine.input(InputType.Keyboard, SDLK[k], true);
  if (k === 'x') shakeTable(-1, 0); else if (k === '.') shakeTable(1, 0); else if (k === 'up') shakeTable(0, 1);
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (!state.running) return;
  const k = KEYS[e.key];
  if (k) state.engine.input(InputType.Keyboard, SDLK[k], false);
});

// Touch controls for phones: left/right flip, hold the middle to launch, swipe to nudge
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
let touchCount = 0;
function tapNudge(btn, dx, dz) {
  press(btn, true);
  setTimeout(() => press(btn, false), 120);
  shakeTable(dx, dz);
  buzz(35);
}
for (const [id, btn] of [['t-left', BTN.LeftFlipper], ['t-right', BTN.RightFlipper], ['t-plunge', BTN.Plunger]]) {
  const el = $(id);
  const starts = new Map();
  const up = (e) => { starts.delete(e.pointerId); el.classList.remove('on'); press(btn, false); };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    state.audio && state.audio.resume();
    if (state.paused) { togglePause(false); return; }
    el.setPointerCapture(e.pointerId);
    starts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), done: false });
    el.classList.add('on');
    press(btn, true);
    if (btn !== BTN.Plunger) buzz(8);
    if (++touchCount > 6) $('touch').classList.remove('hint');
  });
  el.addEventListener('pointermove', (e) => {
    const st = starts.get(e.pointerId);
    if (!st || st.done || performance.now() - st.t > 350) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (Math.hypot(dx, dy) < 45) return;
    st.done = true;
    if (-dy > Math.abs(dx)) tapNudge(BTN.NudgeUp, 0, 1);
    else if (dx < 0) tapNudge(BTN.NudgeLeft, -1, 0);
    else tapNudge(BTN.NudgeRight, 1, 0);
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
// Belt and braces for browsers that still start a selection on long press during play
document.addEventListener('selectstart', (e) => { if (document.body.classList.contains('flat-play')) e.preventDefault(); });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- UI
async function enterXR(mode) {
  const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };
  try {
    // Performance mode trades a little sharpness for steadier frames on older headsets
    renderer.xr.setFramebufferScaleFactor(localStorage.getItem('scvr-perf') === '1' ? 0.8 : 1);
    const session = await navigator.xr.requestSession(mode, sessionInit);
    state.audio.resume();
    const passthrough = mode === 'immersive-ar';
    world.visible = !passthrough;
    scene.background = passthrough ? null : new THREE.Color(0x07060f);
    state.mode = mode;
    document.body.classList.add('in-xr');
    session.addEventListener('end', () => {
      releaseAll();
      world.visible = true;
      scene.background = new THREE.Color(0x07060f);
      state.mode = 'flat';
      rig.position.set(0, 0, 0); rig.rotation.y = 0;
      document.body.classList.remove('in-xr');
    });
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') togglePause(true);
    });
    // Some browsers keep audio suspended until a press inside the headset; unlock on any controller press
    const unlock = () => state.audio && state.audio.resume();
    session.addEventListener('selectstart', unlock);
    session.addEventListener('squeezestart', unlock);
    session.addEventListener('selectstart', (e) => handPinch(e, true));
    session.addEventListener('selectend', (e) => handPinch(e, false));
    session.addEventListener('inputsourceschange', () => {
      releaseAll();
      state.handsOnly = [...session.inputSources].some((s) => s.hand);
    });
    state.needsRecenter = true;
    await renderer.xr.setSession(session);
  } catch (e) {
    showError('Could not start ' + (mode === 'immersive-ar' ? 'passthrough' : 'VR') + ': ' + e.message);
  }
}

function showError(msg) { const el = $('error'); el.textContent = msg; el.hidden = false; }

async function begin(files) {
  $('load-step').hidden = true;
  $('loading').hidden = false;
  try {
    await startEngine(files);
    $('loading').hidden = true;
    $('play-step').hidden = false;
    document.body.classList.add('ready');
    state.audio.master.gain.value = savedVolume / 100;
    updateStats();
  } catch (e) {
    $('loading').hidden = true;
    $('load-step').hidden = false;
    showError(e.message);
  }
}

async function setupXRButtons() {
  const vr = navigator.xr && await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  const ar = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  $('enter-vr').hidden = !vr;
  $('enter-ar').hidden = !ar;
  if (!vr && !ar) $('no-xr').hidden = false;
}

$('file-input').addEventListener('change', async (e) => {
  $('error').hidden = true;
  try {
    const files = await filesFromPicker(e.target.files);
    if (!hasGameData(files)) throw new Error('PINBALL.DAT wasn’t in those files. Pick the Pinball APK, a zip of the game folder, or the game files themselves.');
    await saveFiles(files);
    begin(files);
  } catch (err) { showError(err.message); }
});
$('folder-input').addEventListener('change', async (e) => {
  try {
    const files = await filesFromPicker(e.target.files);
    if (!hasGameData(files)) throw new Error('PINBALL.DAT wasn’t in that folder.');
    await saveFiles(files);
    begin(files);
  } catch (err) { showError(err.message); }
});

$('enter-vr').addEventListener('click', () => enterXR('immersive-vr'));
$('enter-ar').addEventListener('click', () => enterXR('immersive-ar'));
$('play-flat').addEventListener('click', () => {
  state.audio.resume();
  document.body.classList.add('flat-play');
  if (state.pausedByMenu) { state.pausedByMenu = false; togglePause(false); }
  state.menuFromFlat = false;
});
$('menu-btn').addEventListener('click', () => {
  document.body.classList.remove('flat-play');
  state.menuFromFlat = true;
  if (!state.paused) { state.pausedByMenu = true; togglePause(true); }
  updateStats();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.running && !renderer.xr.isPresenting && !state.paused) togglePause(true);
});
addEventListener('keydown', (e) => { if (state.paused && state.running && KEYS[e.key]) togglePause(false); });

function updateMiniScore() {
  const el = $('mini-score');
  if (el) el.textContent = `Ball ${state.ball || 1} \u00b7 ${(state.score || 0).toLocaleString()}`;
}

function updateStats() {
  const best = Math.max(Number(localStorage.getItem('scvr-highscore') || 0), 0);
  const last = localStorage.getItem('scvr-last');
  $('best').textContent = best.toLocaleString();
  $('last').textContent = last === null ? '\u2013' : Number(last).toLocaleString();
  $('stats').hidden = !state.running;
}
$('perf').checked = localStorage.getItem('scvr-perf') === '1';
$('perf').addEventListener('change', (e) => localStorage.setItem('scvr-perf', e.target.checked ? '1' : '0'));
const savedVolume = Number(localStorage.getItem('scvr-volume') ?? 80);
$('volume').value = String(savedVolume);
$('volume').addEventListener('input', (e) => {
  localStorage.setItem('scvr-volume', e.target.value);
  if (state.audio) state.audio.master.gain.value = Number(e.target.value) / 100;
});
$('new-game').addEventListener('click', () => {
  newGame();
  if (state.menuFromFlat) { state.menuFromFlat = false; document.body.classList.add('flat-play'); }
});
$('players').addEventListener('change', (e) => { state.engine.x.scp_set_players(Number(e.target.value)); });
$('music').checked = localStorage.getItem('scvr-music') === '1';
$('music').addEventListener('change', (e) => {
  localStorage.setItem('scvr-music', e.target.checked ? '1' : '0');
  state.engine && state.engine.x.scp_set_music(e.target.checked ? 1 : 0);
});
$('forget').addEventListener('click', async () => { await forgetFiles(); location.reload(); });

setupXRButtons();
loadSavedFiles().then((files) => { if (hasGameData(files)) begin(files); });
