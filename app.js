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
  heightOffset: Number(localStorage.getItem('scvr-height') || 0),
};

// ---------------------------------------------------------------- three.js setup
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0.4);
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

// Simple controller shapes so you can see your hands
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  const m = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.1, 16), new THREE.MeshStandardMaterial({ color: 0x2a2840, roughness: 0.6 }));
  handle.rotation.x = -0.9;
  handle.position.set(0, -0.015, 0.03);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 24), new THREE.MeshStandardMaterial({ color: 0x8d86ff, emissive: 0x2a2266 }));
  ring.position.set(0, 0.01, -0.02);
  ring.rotation.x = 0.4;
  m.add(handle, ring);
  grip.add(m);
  scene.add(grip);
}

// ---------------------------------------------------------------- the room
function buildRoom() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(8, 64),
    new THREE.MeshStandardMaterial({ color: 0x14111f, roughness: 0.9 })
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
let playfield, colorTex, zsTex, bgzTex, ballMeshes = [], shadowMeshes = [], panelCanvas, panelTex, tableGroup;

function buildMachine(info, eng) {
  const W = info.width, H = info.height;
  const vsStride = eng.x.scp_vscreen_stride();
  const zsStride = eng.x.scp_zscreen_stride();

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

  // One vertex per pixel: depth comes from the original per-pixel depth maps
  const cols = tableW, rows = tableH;
  const pix = new Float32Array(cols * rows * 2);
  for (let y = 0, i = 0; y < rows; y++) for (let x = 0; x < cols; x++, i += 2) { pix[i] = x; pix[i + 1] = y; }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  for (let y = 0, k = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
    const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
    idx.set([a, c, b, b, c, d], k); k += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('pix', new THREE.BufferAttribute(pix, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cols * rows * 3), 3));
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

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function buildCabinet(machine, b, cx, cz) {
  const w = b.maxX - b.minX, len = b.maxZ - b.minZ;
  const body = new THREE.MeshStandardMaterial({ color: 0x15132e, roughness: 0.5, metalness: 0.3 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x8d92a6, roughness: 0.3, metalness: 0.85, envMap });
  const dark = new THREE.MeshStandardMaterial({ color: 0x08080c, roughness: 0.8 });

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

  // Flipper buttons on the cabinet sides (they light while pressed)
  const btnGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.012, 20);
  btnGeo.rotateZ(Math.PI / 2);
  state.flipButtons = [-1, 1].map((s) => {
    const m = new THREE.Mesh(btnGeo, new THREE.MeshStandardMaterial({ color: 0xff3366, emissive: 0x330011, roughness: 0.4 }));
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
  panelTex = new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  const glassH = 0.62, glassW = glassH * (PANEL.w / PANEL.h);
  const bbW = Math.max(w + wall * 2, glassW + 0.12), bbH = glassH + 0.1;
  const backbox = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(bbW, bbH, 0.16), body);
  backbox.add(shell);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(glassW, glassH), new THREE.MeshBasicMaterial({ map: panelTex, toneMapped: false }));
  glass.position.z = 0.081;
  backbox.add(glass);
  const trimTop = new THREE.Mesh(new THREE.BoxGeometry(bbW + 0.01, 0.02, 0.17), trim);
  trimTop.position.y = bbH / 2;
  backbox.add(trimTop);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(bbW * 0.9, 0.1, 0.12), body);
  neck.position.y = -bbH / 2 - 0.03;
  backbox.add(neck);
  backbox.position.set(0, backY - depthBelow + sideH + 0.06 + bbH / 2, -len / 2 * Math.cos(TILT) - 0.09);
  machine.add(backbox);

  // Help card on the left of the cabinet
  const help = makeHelpCard();
  help.position.set(-w / 2 - 0.32, 0.1, 0.05);
  help.rotation.set(-0.5, 0.45, 0);
  help.visible = false;
  machine.add(help);
  state.helpCard = help;
}

function makeHelpCard() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 400;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(12,10,30,0.86)';
  x.fillRect(0, 0, 512, 400);
  x.strokeStyle = '#7f7cff'; x.lineWidth = 4; x.strokeRect(2, 2, 508, 396);
  x.fillStyle = '#fff'; x.font = 'bold 34px system-ui, sans-serif';
  x.fillText('Controls', 24, 50);
  x.font = '25px system-ui, sans-serif';
  const lines = [
    ['Triggers / grips', 'Flippers'],
    ['A or X (hold)', 'Pull plunger, let go to launch'],
    ['Right stick', 'Nudge left / right / up'],
    ['B', 'Pause'],
    ['Y', 'New game'],
    ['Left stick ↑↓', 'Table height'],
    ['Left stick click', 'Move table in front of you'],
  ];
  lines.forEach(([a, b], i) => {
    x.fillStyle = '#b9b6ff'; x.fillText(a, 24, 100 + i * 42);
    x.fillStyle = '#e8e8f0'; x.fillText(b, 230, 100 + i * 42);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.31), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false }));
}

function placeMachineDefault() {
  const b = state.tableBounds;
  const len = b.maxZ - b.minZ;
  state.machine.position.set(0, 0.9 + Math.sin(TILT) * len / 2 + state.heightOffset, -len / 2 - 0.22);
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

  panelTex.needsUpdate = true;
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
    },
  });
  const wasm = await WebAssembly.compileStreaming(fetch('engine.wasm'));
  await eng.load(wasm);
  const music = localStorage.getItem('scvr-music') !== '0';
  if (eng.init(music) !== 0) throw new Error('The game could not read PINBALL.DAT');
  eng.x.scp_hide_2d_balls(1);
  state.engine = eng;
  state.info = eng.info();
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

function newGame() { state.engine.x.scp_new_game(); state.paused = false; state.texts = { 1: '', 2: '' }; state.panelDirty = true; }
function togglePause() { state.engine.x.scp_pause(); state.paused = !!state.engine.x.scp_is_paused(); }

// ---------------------------------------------------------------- XR controllers
function pollXR() {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp || (src.handedness !== 'left' && src.handedness !== 'right')) continue;
    const left = src.handedness === 'left';
    const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
    const prev = state.padPrev.get(src.handedness) || {};
    const now = { flip: b(0) || b(1), plunge: b(4), menu: b(5), stick: b(3) };

    press(left ? BTN.LeftFlipper : BTN.RightFlipper, now.flip);
    if (now.flip && !prev.flip) pulse(src, 0.35, 25);

    const otherPlunge = state.padPrev.get(left ? 'right' : 'left');
    press(BTN.Plunger, now.plunge || !!(otherPlunge && otherPlunge.plunge));
    if (!now.plunge && prev.plunge) pulse(src, 0.8, 60);

    const ax = gp.axes[2] || 0, ay = gp.axes[3] || 0;
    if (left) {
      if (Math.abs(ay) > 0.3) {
        state.heightOffset = THREE.MathUtils.clamp(state.heightOffset - ay * 0.004, -0.4, 0.4);
        placeMachineDefault();
        localStorage.setItem('scvr-height', state.heightOffset.toFixed(3));
      }
      if (now.stick && !prev.stick) recenter();
      if (now.menu && !prev.menu) newGame();
    } else {
      press(BTN.NudgeLeft, ax < -0.75);
      press(BTN.NudgeRight, ax > 0.75);
      press(BTN.NudgeUp, ay < -0.75);
      if ((ax < -0.75 && !prev.nl) || (ax > 0.75 && !prev.nr) || (ay < -0.75 && !prev.nu)) pulse(src, 0.6, 50);
      now.nl = ax < -0.75; now.nr = ax > 0.75; now.nu = ay < -0.75;
      if (now.menu && !prev.menu) togglePause();
    }
    state.padPrev.set(src.handedness, now);
  }
}

function pulse(src, strength, ms) {
  const h = src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
  if (h && h.pulse) h.pulse(strength, ms);
  else if (src.gamepad && src.gamepad.vibrationActuator) src.gamepad.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength });
}

// ---------------------------------------------------------------- per-frame update
const tmpV = new THREE.Vector3();
function updateTable() {
  const eng = state.engine, info = state.info;
  colorTex.image.data = eng.pixels(info.width, info.height);
  colorTex.needsUpdate = true;
  zsTex.image.data = eng.zscreen(info.height);
  zsTex.needsUpdate = true;

  const balls = eng.balls();
  const r = info.ballRadius;
  for (let i = 0; i < ballMeshes.length; i++) {
    const b = balls[i], m = ballMeshes[i], s = shadowMeshes[i];
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
    state.panelTimer += dt;
    if (state.panelDirty || state.panelTimer > 100) { state.panelTimer = 0; state.panelDirty = false; drawPanel(); }
  }
  if (!renderer.xr.isPresenting) updateFlatCamera(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop);
window.__scvr = state;

// ---------------------------------------------------------------- flat-screen view
const orbit = { yaw: 0, pitch: 0.95, dist: 0.95, drag: null };
function updateFlatCamera() {
  if (!state.machine) return;
  const target = new THREE.Vector3();
  state.machine.getWorldPosition(target);
  target.y -= 0.02;
  target.z += 0.08;
  const d = orbit.dist;
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
renderer.domElement.addEventListener('wheel', (e) => { orbit.dist = THREE.MathUtils.clamp(orbit.dist * (1 + e.deltaY * 0.001), 0.5, 3); }, { passive: true });

addEventListener('keydown', (e) => {
  if (!state.running) return;
  if (e.key === 'F2') { newGame(); e.preventDefault(); return; }
  if (e.key === 'F3' || e.key === 'p') { togglePause(); return; }
  const k = KEYS[e.key];
  if (!k || e.repeat) return;
  state.audio.resume();
  state.engine.input(InputType.Keyboard, SDLK[k], true);
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (!state.running) return;
  const k = KEYS[e.key];
  if (k) state.engine.input(InputType.Keyboard, SDLK[k], false);
});

// Touch buttons for phones
for (const [id, btn] of [['t-left', BTN.LeftFlipper], ['t-right', BTN.RightFlipper], ['t-plunge', BTN.Plunger]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); state.audio && state.audio.resume(); el.setPointerCapture(e.pointerId); press(btn, true); });
  el.addEventListener('pointerup', () => press(btn, false));
  el.addEventListener('pointercancel', () => press(btn, false));
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- UI
async function enterXR(mode) {
  const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };
  try {
    const session = await navigator.xr.requestSession(mode, sessionInit);
    state.audio.resume();
    const passthrough = mode === 'immersive-ar';
    world.visible = !passthrough;
    scene.background = passthrough ? null : new THREE.Color(0x07060f);
    state.mode = mode;
    if (state.helpCard) state.helpCard.visible = true;
    document.body.classList.add('in-xr');
    session.addEventListener('end', () => {
      world.visible = true;
      scene.background = new THREE.Color(0x07060f);
      state.mode = 'flat';
      if (state.helpCard) state.helpCard.visible = false;
      rig.position.set(0, 0, 0); rig.rotation.y = 0;
      document.body.classList.remove('in-xr');
    });
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible' && !state.paused) togglePause();
    });
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
$('play-flat').addEventListener('click', () => { state.audio.resume(); document.body.classList.add('flat-play'); });
$('menu-btn').addEventListener('click', () => document.body.classList.remove('flat-play'));
$('new-game').addEventListener('click', newGame);
$('players').addEventListener('change', (e) => { state.engine.x.scp_set_players(Number(e.target.value)); });
$('music').checked = localStorage.getItem('scvr-music') !== '0';
$('music').addEventListener('change', (e) => {
  localStorage.setItem('scvr-music', e.target.checked ? '1' : '0');
  state.engine && state.engine.x.scp_set_music(e.target.checked ? 1 : 0);
});
$('forget').addEventListener('click', async () => { await forgetFiles(); location.reload(); });

setupXRButtons();
loadSavedFiles().then((files) => { if (hasGameData(files)) begin(files); });
