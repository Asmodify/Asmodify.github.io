/* core.js — engine and shared API for the drivable portfolio world.
   Loads first. Exposes window.W. Modules (terrain, roads, buildings, foliage,
   stations, missions, audio) register themselves through this API and never
   touch the renderer directly. See CONTRACT.md. */
(() => {
  const T = THREE;
  const W = window.W = { T, version: 2 };

  /* ---------------- deterministic random ---------------- */
  let seed = 20261012 >>> 0;
  W.rng = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  W.rand = (a = 0, b = 1) => a + W.rng() * (b - a);
  W.reseed = s => { seed = s >>> 0; };
  W.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  W.lerp = (a, b, t) => a + (b - a) * t;
  W.smoothstep = (a, b, x) => { const t = W.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ---------------- DOM ---------------- */
  const $ = id => document.getElementById(id);
  const dom = W.dom = { canvas: $('scene'), intro: $('intro'), panel: $('panel'), panelBody: $('panelBody'), toast: $('toast'), hud: $('hud-extra'), buttons: $('hud-buttons'), mini: $('mini'), kmh: $('kmh'), fuelBar: $('fuelBar'), fuelL: $('fuelL'), touch: $('touch'), keys: $('keys') };

  /* ---------------- renderer / scene ---------------- */
  // Fill rate is the main GPU cost of this scene (full-screen lit terrain), so: pixel ratio capped at 1.5,
  // MSAA only on 1x displays with a few cores to spare, PCF (9 taps) rather than PCFSoft (16).
  const DPR = devicePixelRatio || 1, COARSE = matchMedia('(pointer: coarse)').matches;
  const renderer = W.renderer = new T.WebGLRenderer({ canvas: dom.canvas, antialias: DPR < 2 && (navigator.hardwareConcurrency || 8) > 4, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(DPR, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.info.autoReset = false; // reset at the top of frame() so calls/triangles include the shadow pass
  const scene = W.scene = new T.Scene();
  const camera = W.camera = new T.PerspectiveCamera(38, 1, 0.5, 900);
  const CAM_OFF = new T.Vector3(16, 26, 22);
  W.camZoom = 1;

  const DAY = { sky: '#cfe0ea', horizon: '#eef3f6', fog: '#d3e0e8', hemi: 0.5, sun: 0.62, ambientGround: '#8f9a68' };
  const NIGHT = { sky: '#0b1226', horizon: '#2a3356', fog: '#131b33', hemi: 0.14, sun: 0.08, ambientGround: '#1b2235' };
  scene.background = new T.Color(DAY.sky);
  scene.fog = new T.Fog(DAY.fog, 90, 260);

  // Sky dome: vertex-colour gradient on a big inverted sphere that follows the camera.
  const skyGeo = new T.SphereGeometry(600, 24, 12);
  const skyMat = new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new T.Color(DAY.sky) }, bottom: { value: new T.Color(DAY.horizon) } },
    vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ float t = smoothstep(-0.05, 0.45, h); gl_FragColor = vec4(mix(bottom, top, t), 1.0); }'
  });
  const sky = new T.Mesh(skyGeo, skyMat); sky.renderOrder = -10; scene.add(sky);

  const hemi = W.hemi = new T.HemisphereLight('#eef3f8', DAY.ambientGround, DAY.hemi);
  const sun = W.sun = new T.DirectionalLight('#fff3dc', DAY.sun);
  sun.castShadow = true; sun.shadow.mapSize.setScalar(COARSE || DPR >= 2 ? 1024 : 1536);
  const sc = sun.shadow.camera; sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 160;
  sun.shadow.bias = -0.0008;
  scene.add(hemi, sun, sun.target);
  const moonTint = new T.Color('#9fb3ff');

  // Clouds: flat blobs drifting high above, cheap and unlit.
  const clouds = [];
  {
    const cm = new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .85, fog: false });
    for (let i = 0; i < 26; i++) {
      const g = new T.Group();
      const n = 3 + Math.floor(W.rand(0, 3));
      for (let j = 0; j < n; j++) { const m = new T.Mesh(new T.SphereGeometry(W.rand(5, 10), 8, 6), cm); m.scale.y = .45; m.position.set(j * 7 - n * 3, W.rand(-1, 1), W.rand(-3, 3)); g.add(m); }
      g.position.set(W.rand(-300, 300), W.rand(70, 110), W.rand(-300, 300)); g.userData.v = W.rand(.6, 1.6); scene.add(g); clouds.push(g);
    }
  }

  /* ---------------- materials ---------------- */
  const matCache = new Map();
  W.mat = (color, o = {}) => {
    const key = color + '|' + (o.rough ?? .85) + '|' + (o.metal ?? 0) + '|' + (o.emissive || '') + '|' + (o.flat ? 1 : 0) + '|' + (o.side || 0) + '|' + (o.ei ?? 1);
    if (matCache.has(key)) return matCache.get(key);
    const m = new T.MeshStandardMaterial({ color, roughness: o.rough ?? .85, metalness: o.metal ?? 0, flatShading: !!o.flat, side: o.side || T.FrontSide });
    if (o.emissive) { m.emissive = new T.Color(o.emissive); m.emissiveIntensity = o.ei ?? 1; }
    matCache.set(key, m); return m;
  };
  W.M = {
    truck: W.mat('#f7bd0c'), cab: W.mat('#f6f7f9'), dark: W.mat('#1c1b19'), glass: W.mat('#2a3e66', { rough: .3, metal: .2 }), grey: W.mat('#8a8a8a'),
    blue: W.mat('#1f4fd1'), white: W.mat('#fbfbf7'), rock: W.mat('#9aa1a6', { flat: true }), red: W.mat('#d2473b'), crate: W.mat('#b98a52'), cone: W.mat('#f07a2a'),
    wood: W.mat('#8a5a2b'), concrete: W.mat('#b8b4ab'), brick: W.mat('#a9573f'), asphalt: W.mat('#3a3d42', { rough: 1 }), dirt: W.mat('#cbbd94', { rough: 1 }),
    steel: W.mat('#9da5ad', { rough: .5, metal: .6 }), rust: W.mat('#8c4a2b'), grassDark: W.mat('#6f8a44'), leaf: W.mat('#4f7a3a', { flat: true }), leafLight: W.mat('#7fa652', { flat: true }),
    trunk: W.mat('#6b4a2d'), snow: W.mat('#f4f7fa'), water: null, window: W.mat('#dfe9f5', { emissive: '#f6d87a', ei: 0 }), lamp: W.mat('#fff2c4', { emissive: '#ffd36b', ei: 0 }),
    sand: W.mat('#d9c99a'), pad: W.mat('#e6dcc0', { rough: 1 })
  };
  // Materials whose emissive turns on at night (windows, lamps). Modules can push their own.
  W.nightGlow = [W.M.window, W.M.lamp];

  /* ---------------- geometry helpers ---------------- */
  W.shadowed = o => { o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; };
  W.box = (w, h, d, m, x = 0, y = 0, z = 0) => { const b = new T.Mesh(new T.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b; };
  W.cyl = (rt, rb, h, m, x = 0, y = 0, z = 0, seg = 12) => { const c = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg), m); c.position.set(x, y, z); return c; };
  W.ring = (r, w, color, op = 1) => { const m = new T.Mesh(new T.RingGeometry(Math.max(0, r - w), r, 64), new T.MeshBasicMaterial({ color, transparent: op < 1, opacity: op, depthWrite: false })); m.rotation.x = -Math.PI / 2; return m; };

  W.textTex = (lines, { w = 1024, h = 256, bg = null, color = '#18202b', font = '800 120px Archivo', sub = '500 40px "IBM Plex Mono"', subColor = '#5a6573', align = 'center' } = {}) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
    x.textAlign = align; x.textBaseline = 'middle';
    const X = align === 'center' ? w / 2 : 40;
    x.fillStyle = color; x.font = font; x.fillText(lines[0], X, lines[1] ? h * .4 : h / 2);
    if (lines[1]) { x.fillStyle = subColor; x.font = sub; x.fillText(lines[1], X, h * .78); }
    const t = new T.CanvasTexture(c); t.anisotropy = 4; return t;
  };
  // Flat text on the ground (y is set by the caller after W.place).
  W.decal = (tex, w, h) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; return m; };
  // Camera-facing label. Returns a Sprite; scale is in world units.
  W.sprite = (text, { color = '#18202b', bg = 'rgba(251,252,253,.9)', size = 44, scale = 6 } = {}) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d');
    x.font = `600 ${size}px "IBM Plex Sans"`; const tw = Math.min(500, x.measureText(text).width + 40);
    x.fillStyle = bg; x.beginPath(); x.roundRect ? x.roundRect(256 - tw / 2, 24, tw, 80, 16) : x.rect(256 - tw / 2, 24, tw, 80); x.fill();
    x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 256, 64);
    const tex = new T.CanvasTexture(c); const s = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    s.scale.set(scale, scale / 4, 1); return s;
  };
  // Window texture: a grid of lit/unlit panes, used by buildings. Emissive map glows at night.
  W.windowTex = (cols, rows, { lit = .6, pane = '#cfe0f0', wall = '#b8b4ab' } = {}) => {
    const c = document.createElement('canvas'); c.width = cols * 32; c.height = rows * 32; const x = c.getContext('2d');
    x.fillStyle = wall; x.fillRect(0, 0, c.width, c.height);
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) { x.fillStyle = W.rng() < lit ? '#ffe9a8' : pane; x.fillRect(q * 32 + 7, r * 32 + 6, 18, 20); }
    const t = new T.CanvasTexture(c); t.anisotropy = 4; return t;
  };

  /* ---------------- terrain contract ---------------- */
  W.terrain = { height: () => 0, normal: () => new T.Vector3(0, 1, 0), waterLevel: -999, isWater: () => false, size: 320, driveRadius: 118, color: () => '#a9b878' };
  W.surfaces = [];
  W.addSurface = s => { W.surfaces.push(s); return s; };
  W.surfaceY = (x, z) => { let best = null; for (const s of W.surfaces) { const y = s.height(x, z); if (y != null && (best == null || y > best)) best = y; } return best; };
  W.groundY = (x, z) => { const t = W.terrain.height(x, z), s = W.surfaceY(x, z); return s != null && s > t ? s : t; };
  W.place = (obj, x, z, yOff = 0) => { obj.position.set(x, W.groundY(x, z) + yOff, z); return obj; };
  W.inWater = (x, z) => W.terrain.isWater(x, z) && W.surfaceY(x, z) == null;

  /* ---------------- colliders ---------------- */
  W.solids = []; // {x,z,r,tag}. Owners may move x/z each frame for dynamic solids (trains).
  W.solid = (x, z, r, tag) => { const s = { x, z, r, tag }; W.solids.push(s); return s; };
  W.bodies = [];
  W.pushable = (mesh, half, r, opts = {}) => {
    mesh.castShadow = mesh.receiveShadow = true; if (!mesh.parent) scene.add(mesh);
    const b = { mesh, v: new T.Vector3(), w: new T.Vector3(), half, r, rest: true, tag: opts.tag, home: mesh.position.clone(), homeRot: mesh.rotation.clone(), onHit: opts.onHit };
    if (opts.grounded !== false) mesh.position.y = W.groundY(mesh.position.x, mesh.position.z) + half;
    W.bodies.push(b); return b;
  };
  W.resetBody = b => { b.mesh.position.copy(b.home); b.mesh.position.y = W.groundY(b.home.x, b.home.z) + b.half; b.mesh.rotation.copy(b.homeRot); b.v.set(0, 0, 0); b.w.set(0, 0, 0); b.rest = true; };

  W.stations = []; W.places = {}; W.markers = [];
  W.addStation = s => { s.r = s.r || 5; s.y = W.groundY(s.x, s.z); W.stations.push(s); return s; };
  W.addPlace = (id, p) => { p.id = id; p.r = p.r || 10; W.places[id] = p; return p; };
  // Reserved ground: areas a module claims (ramps, a bowling lane) so later scatterers (foliage) keep off them.
  W.reserved = [];
  W.reserve = (x, z, r, tag) => { const a = { x, z, r, tag }; W.reserved.push(a); return a; };
  // True when nothing important is within r of (x,z): stations, places, reserved ground, solids, roads, water, the centre plaza.
  W.isClear = (x, z, r = 2) => {
    if (Math.hypot(x, z) < 24 + r) return false;
    if (W.inWater(x, z)) return false;
    for (const s of W.stations) if (Math.hypot(x - s.x, z - s.z) < s.r + r + 4) return false;
    for (const id in W.places) { const p = W.places[id]; if (Math.hypot(x - p.x, z - p.z) < p.r + r) return false; }
    for (const a of W.reserved) if (Math.hypot(x - a.x, z - a.z) < a.r + r) return false;
    if (W.roads && W.roads.distance(x, z) < 4.5 + r) return false;
    for (const s of W.solids) if (Math.hypot(x - s.x, z - s.z) < s.r + r) return false;
    return true;
  };

  /* ---------------- UI ---------------- */
  let toastT;
  W.toast = msg => { dom.toast.textContent = msg; dom.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => dom.toast.classList.remove('show'), 2400); };
  W.panelId = null; let panelSticky = false;
  W.openPanel = (html, { id = null, sticky = false, refresh = false } = {}) => {
    if (W.panelId === id && id) { if (refresh) dom.panelBody.innerHTML = html; return; }
    W.panelId = id; panelSticky = sticky; dom.panelBody.innerHTML = html; dom.panel.classList.add('open'); W.sfx('open');
  };
  W.closePanel = () => { if (!dom.panel.classList.contains('open')) return; W.panelId = null; panelSticky = false; dom.panel.classList.remove('open'); };
  dom.panel.querySelector('.close').addEventListener('click', () => { W.dismissed = W.insideStation; W.closePanel(); });
  W.hud = {
    set: (id, html) => { let el = dom.hud.querySelector(`[data-id="${id}"]`); if (!el) { el = document.createElement('div'); el.dataset.id = id; el.className = 'badge hud-item'; dom.hud.appendChild(el); } el.innerHTML = html; return el; },
    remove: id => { const el = dom.hud.querySelector(`[data-id="${id}"]`); if (el) el.remove(); },
    button: (label, onClick, { id = null, title = '' } = {}) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = label; if (id) b.id = id; if (title) b.title = title; b.addEventListener('click', onClick); dom.buttons.appendChild(b); return b; }
  };

  /* ---------------- audio stub (audio.js replaces) ---------------- */
  W.audio = { ready: false, muted: false, init() {}, sfx() {}, engine() {}, music() {}, setMuted() {} };
  W.sfx = (name, opts) => { try { W.audio.sfx(name, opts); } catch (e) { } };

  /* ---------------- input ---------------- */
  const keys = W.keys = {};
  const keymap = { ArrowUp: 'fwd', KeyW: 'fwd', ArrowDown: 'back', KeyS: 'back', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ShiftLeft: 'boost', ShiftRight: 'boost', Space: 'brake', KeyE: 'action', Enter: 'action', KeyH: 'horn' };
  const actionFns = []; W.onAction = fn => actionFns.push(fn);
  const fireAction = () => { for (const f of actionFns) if (f() === true) break; };
  const nightFns = []; W.onNight = fn => nightFns.push(fn);
  addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = keymap[e.code];
    if (k) { if (!keys[k] && k === 'action') fireAction(); if (!keys[k] && k === 'horn') W.sfx('horn'); keys[k] = true; if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); }
    if (e.code === 'KeyR') W.reset();
    if (e.code === 'Escape') { W.dismissed = W.insideStation; W.closePanel(); }
    if (e.code === 'KeyN') W.setNight(!W.night);
    if (e.code === 'KeyM') W.audio.setMuted(!W.audio.muted);
    if (e.code === 'KeyC') W.camZoom = W.camZoom > 1.2 ? 0.7 : W.camZoom > 0.85 ? 1.45 : 1;
  });
  addEventListener('keyup', e => { const k = keymap[e.code]; if (k) keys[k] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  addEventListener('wheel', e => { if (e.target === dom.canvas) { W.camZoom = W.clamp(W.camZoom * (e.deltaY > 0 ? 1.08 : .93), .6, 1.8); } }, { passive: true });
  document.querySelectorAll('#touch button').forEach(b => {
    const k = b.dataset.k;
    const on = e => { e.preventDefault(); if (k === 'action') { fireAction(); return; } if (k === 'horn') W.sfx('horn'); keys[k] = true; b.classList.add('on'); };
    const off = e => { e.preventDefault(); keys[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
  });

  /* ---------------- truck ---------------- */
  const truck = W.truck = new T.Group(); const body = W.truckBody = new T.Group(); truck.add(body);
  {
    const M = W.M;
    body.add(W.box(2.2, .5, 5.2, M.dark, 0, .75, 0), W.box(2.2, 1.8, 1.7, M.cab, 0, 1.85, 1.65), W.box(2.0, .75, .1, M.glass, 0, 2.25, 2.52),
      W.box(.06, .6, 1.0, M.glass, 1.12, 2.25, 1.75), W.box(.06, .6, 1.0, M.glass, -1.12, 2.25, 1.75),
      W.box(2.4, 2.3, 3.4, M.truck, 0, 2.1, -1.0), W.box(2.42, .25, 3.42, M.dark, 0, 1.4, -1.0),
      W.box(.9, .1, 1.2, M.grey, 0, 2.81, 1.65), W.box(2.3, .3, .35, M.dark, 0, .55, 2.55));
    W.truckCargo = new T.Group(); W.truckCargo.position.set(0, 3.25, -1.0); body.add(W.truckCargo);
    W.headlights = [-0.7, .7].map(x => { const l = new T.Mesh(new T.BoxGeometry(.4, .2, .08), new T.MeshBasicMaterial({ color: '#fff6c8' })); l.position.set(x, 1.15, 2.53); body.add(l); return l; });
    W.brakeLights = [-0.85, .85].map(x => { const l = new T.Mesh(new T.BoxGeometry(.35, .2, .08), new T.MeshBasicMaterial({ color: '#7a1d17' })); l.position.set(x, 1.15, -2.62); body.add(l); return l; });
    W.spots = [-0.7, .7].map(x => { const s = new T.SpotLight('#ffe9b0', 0, 60, .6, .5, 1); s.position.set(x, 1.3, 2.4); s.target.position.set(x, 0, 30); body.add(s, s.target); return s; });
    const wheelG = new T.CylinderGeometry(.55, .55, .45, 16); wheelG.rotateZ(Math.PI / 2);
    W.wheels = [[1.15, 1.6], [-1.15, 1.6], [1.15, -1.7], [-1.15, -1.7]].map(([x, z], i) => {
      const pivot = new T.Group(); pivot.position.set(x, .55, z);
      const w = new T.Mesh(wheelG, M.dark); const hub = new T.Mesh(new T.CylinderGeometry(.22, .22, .47, 8).rotateZ(Math.PI / 2), M.grey);
      w.add(hub); pivot.add(w); body.add(pivot); return { pivot, w, front: i < 2 };
    });
    truck.rotation.order = 'YXZ';
    scene.add(W.shadowed(truck));
  }
  const START = { x: 0, z: 6, h: Math.PI };
  const car = W.car = { x: START.x, z: START.z, y: 0, vy: 0, prevVy: 0, h: START.h, v: 0, steer: 0, fuel: 400, maxFuel: 400, airborne: false, airTime: 0, onRoad: false, inWater: false, kmh: 0, odometer: 0 };
  W.setStart = (x, z, h) => { START.x = x; START.z = z; START.h = h; };

  /* ---------------- effects ---------------- */
  const dustG = new T.SphereGeometry(.35, 6, 4), dust = [];
  for (let i = 0; i < 80; i++) { const m = new T.Mesh(dustG, new T.MeshBasicMaterial({ color: '#e6dcc0', transparent: true, opacity: 0, depthWrite: false })); m.visible = false; scene.add(m); dust.push({ m, life: 0, s: 1, vy: 1 }); }
  let dustI = 0;
  W.puff = (x, z, s = 1, color = null) => { const d = dust[dustI++ % dust.length]; d.m.position.set(x, W.groundY(x, z) + .3, z); d.life = 1; d.s = s; d.vy = .8 + W.rng(); d.m.material.color.set(color || '#e6dcc0'); d.m.visible = true; };

  // Guide arrow above the truck pointing at a target (missions use this).
  const arrow = new T.Mesh(new T.ConeGeometry(.6, 1.6, 4), new T.MeshBasicMaterial({ color: '#1f4fd1' })); arrow.rotation.x = Math.PI / 2; arrow.visible = false; scene.add(arrow);
  W.target = null;
  W.setTarget = t => { W.target = t; arrow.visible = !!t; if (t && t.color) arrow.material.color.set(t.color); };

  /* ---------------- night / day ---------------- */
  W.night = false;
  W.setNight = on => {
    W.night = !!on; const P = on ? NIGHT : DAY;
    scene.background.set(P.sky); scene.fog.color.set(P.fog); skyMat.uniforms.top.value.set(P.sky); skyMat.uniforms.bottom.value.set(P.horizon);
    hemi.intensity = P.hemi; hemi.groundColor.set(P.ambientGround); sun.intensity = P.sun; sun.color.copy(on ? moonTint : new T.Color('#fff3dc'));
    for (const m of W.nightGlow) m.emissiveIntensity = on ? 1 : 0;
    for (const s of W.spots) { s.intensity = on ? 2.2 : 0; s.visible = !!on; }
    W.headlights.forEach(l => l.material.color.set(on ? '#fffbe6' : '#fff6c8'));
    clouds.forEach(c => c.children.forEach(m => m.material.opacity = on ? .25 : .85));
    for (const f of nightFns) { try { f(W.night); } catch (e) { console.error(e); } }
    const b = $('nightBtn'); if (b) b.textContent = on ? '☀ Day' : '☾ Night';
  };

  /* ---------------- hooks ---------------- */
  const updateFns = [], readyFns = [], resetFns = [];
  W.onUpdate = fn => updateFns.push(fn);
  W.onReady = fn => readyFns.push(fn);
  W.onReset = fn => resetFns.push(fn);
  W.started = false;
  W.reset = () => { Object.assign(car, { x: START.x, z: START.z, h: START.h, v: 0, vy: 0, airborne: false, airTime: 0 }); car.y = W.groundY(car.x, car.z); for (const f of resetFns) f(); W.toast('Back at the start'); };

  /* ---------------- minimap ---------------- */
  const mini = dom.mini, mx = mini.getContext('2d');
  let miniBase = null;
  const MR = 132; const MS = () => MR / (W.terrain.driveRadius + 6);
  function buildMiniBase() {
    const c = document.createElement('canvas'); c.width = c.height = 264; const x = c.getContext('2d');
    const S = MS(); const step = 3;
    for (let py = 0; py < 264; py += step) for (let px = 0; px < 264; px += step) {
      const wx = (px - MR) / S, wz = (py - MR) / S;
      if (Math.hypot(wx, wz) > W.terrain.driveRadius + 6) continue;
      x.fillStyle = W.terrain.color(wx, wz); x.fillRect(px, py, step, step);
    }
    if (W.roads) {
      x.lineCap = 'round'; x.lineJoin = 'round';
      for (const road of W.roads.polylines || []) { x.strokeStyle = road.dirt ? 'rgba(203,189,148,.95)' : 'rgba(58,61,66,.9)'; x.lineWidth = road.dirt ? 2.5 : 3.5; x.beginPath(); road.points.forEach((p, i) => i ? x.lineTo(MR + p.x * S, MR + p.z * S) : x.moveTo(MR + p.x * S, MR + p.z * S)); if (road.closed) x.closePath(); x.stroke(); }
    }
    miniBase = c;
  }
  function drawMini() {
    const S = MS(); mx.clearRect(0, 0, 264, 264);
    mx.save(); mx.beginPath(); mx.arc(MR, MR, MR - 2, 0, 7); mx.clip();
    if (miniBase) mx.drawImage(miniBase, 0, 0); else { mx.fillStyle = 'rgba(169,184,120,.6)'; mx.fillRect(0, 0, 264, 264); }
    for (const id in W.places) { const p = W.places[id]; if (p.hidden) continue; mx.fillStyle = 'rgba(24,32,43,.85)'; mx.strokeStyle = 'rgba(255,255,255,.9)'; mx.lineWidth = 1.5; mx.beginPath(); mx.arc(MR + p.x * S, MR + p.z * S, 3.5, 0, 7); mx.fill(); mx.stroke(); }
    for (const s of W.stations) { mx.fillStyle = s.color; mx.beginPath(); mx.arc(MR + s.x * S, MR + s.z * S, 7, 0, 7); mx.fill(); }
    for (const m of W.markers) { mx.fillStyle = m.color || '#1f4fd1'; mx.beginPath(); mx.arc(MR + m.x * S, MR + m.z * S, m.big ? 8 : 5, 0, 7); mx.fill(); if (m.big) { mx.strokeStyle = '#fff'; mx.lineWidth = 2; mx.stroke(); } }
    if (W.target) { mx.strokeStyle = W.target.color || '#1f4fd1'; mx.lineWidth = 2.5; mx.beginPath(); mx.arc(MR + W.target.x * S, MR + W.target.z * S, 9 + 3 * Math.sin(performance.now() / 200), 0, 7); mx.stroke(); }
    mx.translate(MR + car.x * S, MR + car.z * S); mx.rotate(-car.h); mx.fillStyle = '#18202b';
    mx.beginPath(); mx.moveTo(0, 10); mx.lineTo(-6, -7); mx.lineTo(6, -7); mx.closePath(); mx.fill(); mx.restore();
  }

  /* ---------------- physics / loop ---------------- */
  const tmp = new T.Vector3(), tmp2 = new T.Vector3();
  let lowWarned = false, lastBonk = 0, skidT = 0;
  W.insideStation = null; W.dismissed = null;
  function step(dt, now) {
    const drive = W.started ? 1 : 0;
    const empty = car.fuel <= 0;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    car.onRoad = W.roads ? W.roads.distance(car.x, car.z) < 4.2 : true;
    car.inWater = W.inWater(car.x, car.z);
    const ground = W.groundY(car.x, car.z);
    const slopeF = car.airborne ? 0 : (W.groundY(car.x + fx * 2.2, car.z + fz * 2.2) - W.groundY(car.x - fx * 2.2, car.z - fz * 2.2)) / 4.4;

    const maxV = (keys.boost ? 30 : 20) * (empty ? .35 : 1) * (car.onRoad ? 1 : .78) * (car.inWater ? .28 : 1);
    let acc = keys.fwd ? 26 : keys.back ? -22 : 0;
    acc *= drive;
    if (!car.airborne) acc -= slopeF * 14;              // gravity along the slope
    car.v += acc * dt;
    if (keys.brake && !car.airborne) car.v *= Math.pow(.02, dt);
    if (!car.airborne) car.v *= Math.pow(keys.fwd || keys.back ? (car.inWater ? .3 : .7) : .35, dt);
    car.v = W.clamp(car.v, -9, maxV);
    const steerTarget = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    car.steer += (steerTarget * .55 - car.steer) * Math.min(1, dt * 8);
    if (!car.airborne) car.h += car.steer * car.v * dt * .18; else car.h += car.steer * car.v * dt * .04;
    car.x += fx * car.v * dt; car.z += fz * car.v * dt;
    car.odometer += Math.abs(car.v) * dt;
    car.fuel = Math.max(0, car.fuel - Math.abs(car.v) * dt * (keys.boost ? .9 : .45));
    if (car.fuel < 60 && !lowWarned) { lowWarned = true; W.toast('Fuel low: refuel at the fuel station'); }
    if (car.fuel > 100) lowWarned = false;

    // vertical: follow the ground, launch when it falls away, fall under gravity
    const g2 = W.groundY(car.x, car.z);
    if (car.airborne) {
      car.vy -= 30 * dt; car.y += car.vy * dt; car.airTime += dt;
      if (car.y <= g2) { car.y = g2; car.airborne = false; if (car.vy < -9) { W.sfx('land', { hard: true }); W.puff(car.x, car.z, 2.5); W.puff(car.x + 1, car.z, 2); W.puff(car.x - 1, car.z, 2); } else W.sfx('land'); if (car.airTime > 1.1) W.toast(`Big air: ${car.airTime.toFixed(1)} s`); W.lastAir = car.airTime; car.vy = 0; }
    } else {
      const climb = g2 - car.y;
      if (climb < -0.45 && Math.abs(car.v) > 5) { car.airborne = true; car.airTime = 0; car.vy = Math.max(0, car.prevVy); }
      else { car.prevVy = dt > 0 ? climb / dt : 0; car.y = g2; }
    }

    // world edge and water
    const R = W.terrain.driveRadius, dist = Math.hypot(car.x, car.z);
    if (dist > R) { car.x *= R / dist; car.z *= R / dist; car.v *= .5; if (now - lastBonk > 1500) { lastBonk = now; W.toast('The mountains are the border of this map'); } }

    // static and dynamic solids
    for (const s of W.solids) {
      const dx = car.x - s.x, dz = car.z - s.z, min = s.r + 1.6, d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 0 && (s.yMax == null || car.y < s.yMax)) { const d = Math.sqrt(d2); const impact = Math.abs(car.v); car.x = s.x + dx / d * min; car.z = s.z + dz / d * min; if (impact > 6 && now - lastBonk > 600) { lastBonk = now; W.sfx('bonk', { v: impact }); W.toast('Bonk.'); } car.v *= -.25; if (s.onHit) s.onHit(impact); }
    }

    // pushables
    for (const b of W.bodies) {
      const p = b.mesh.position, dx = p.x - car.x, dz = p.z - car.z, d = Math.hypot(dx, dz);
      if (d < b.r + 1.7 && Math.abs(p.y - car.y) < 3 && Math.abs(car.v) > .5) {
        const nx = dx / (d || 1), nz = dz / (d || 1), sp = Math.abs(car.v);
        b.v.set(nx * sp * .6 + fx * car.v * .5, Math.min(9, sp * .32), nz * sp * .6 + fz * car.v * .5);
        b.w.set((W.rng() - .5) * sp, (W.rng() - .5) * sp, (W.rng() - .5) * sp);
        if (b.rest) W.sfx('hit', { v: sp }); b.rest = false; car.v *= .97; if (b.onHit) b.onHit(b, sp);
      }
      if (!b.rest) {
        b.v.y -= 30 * dt; p.addScaledVector(b.v, dt);
        b.mesh.rotation.x += b.w.x * dt; b.mesh.rotation.y += b.w.y * dt; b.mesh.rotation.z += b.w.z * dt;
        const gy = W.groundY(p.x, p.z) + b.half;
        if (p.y < gy) { p.y = gy; b.v.y *= -.3; if (b.v.y < 30 * dt) b.v.y = 0; /* a bounce gravity would undo this frame is rest, at any frame rate */ b.v.x *= .82; b.v.z *= .82; b.w.multiplyScalar(.8); if (b.v.lengthSq() < .05) { b.rest = true; b.v.set(0, 0, 0); b.w.set(0, 0, 0); } }
        for (const s of W.solids) { const ex = p.x - s.x, ez = p.z - s.z, m = s.r + b.r, e2 = ex * ex + ez * ez; if (e2 < m * m && e2 > 0) { const e = Math.sqrt(e2); p.x = s.x + ex / e * m; p.z = s.z + ez / e * m; b.v.x *= -.4; b.v.z *= -.4; } }
        const pr = Math.hypot(p.x, p.z); if (pr > R + 4) { p.x *= (R + 4) / pr; p.z *= (R + 4) / pr; b.v.x *= -.4; b.v.z *= -.4; }
      }
    }

    // stations
    let inside = null;
    for (const s of W.stations) {
      const d = Math.hypot(car.x - s.x, car.z - s.z);
      if (s.glow) s.glow.material.opacity = .55 + .35 * Math.sin(now / 300 + s.x);
      if (d < s.r) inside = s;
    }
    if (inside !== W.insideStation) { if (W.insideStation && W.insideStation.onLeave) W.insideStation.onLeave(); if (inside && inside.onEnter) inside.onEnter(); W.insideStation = inside; }
    if (inside) {
      if (inside.html && inside !== W.dismissed && Math.abs(car.v) < 9 && !panelSticky) W.openPanel(inside.html, { id: inside.id });
      if (inside.onInside) inside.onInside(dt);
    } else { W.dismissed = null; if (W.panelId && !panelSticky && W.stations.some(s => s.id === W.panelId)) W.closePanel(); }

    // truck transform: yaw from heading, pitch/roll from the ground
    truck.position.set(car.x, car.y, car.z);
    const L = 2.2, Wd = 1.1;
    const hF = W.groundY(car.x + fx * L, car.z + fz * L), hB = W.groundY(car.x - fx * L, car.z - fz * L);
    const hR = W.groundY(car.x + fz * Wd, car.z - fx * Wd), hL = W.groundY(car.x - fz * Wd, car.z + fx * Wd);
    const pitchT = car.airborne ? W.clamp(-car.vy * .04, -.5, .5) : -Math.atan2(hF - hB, 2 * L);
    const rollT = car.airborne ? 0 : Math.atan2(hR - hL, 2 * Wd);
    truck.rotation.y = car.h;
    truck.rotation.x += (pitchT - truck.rotation.x) * Math.min(1, dt * 6);
    truck.rotation.z += (rollT - truck.rotation.z) * Math.min(1, dt * 6);
    body.rotation.z += (-car.steer * car.v * .012 - body.rotation.z) * Math.min(1, dt * 6);
    body.rotation.x += (-acc * .0012 - body.rotation.x) * Math.min(1, dt * 5);
    body.position.y = Math.abs(Math.sin(now / 70)) * Math.min(.04, Math.abs(car.v) * .003) * (car.onRoad ? .4 : 1);
    for (const w of W.wheels) { w.w.rotation.x += car.v * dt / .55; if (w.front) w.pivot.rotation.y = car.steer * .9; }
    const braking = keys.brake || (keys.back && car.v > 0);
    W.brakeLights.forEach(l => l.material.color.set(braking ? '#ff3b2f' : W.night ? '#c0251c' : '#7a1d17'));
    if (!car.airborne && Math.abs(car.v) > 8 && W.rng() < Math.abs(car.v) / (car.onRoad ? 120 : 40)) { tmp.set(-fx * 2.2 + (W.rng() - .5) * 1.6, 0, -fz * 2.2); W.puff(car.x + tmp.x, car.z + tmp.z, 1 + W.rng(), car.onRoad ? '#cfcfcf' : null); }
    for (const d of dust) if (d.life > 0) { d.life -= dt * 1.1; d.m.position.y += d.vy * dt; d.m.scale.setScalar(d.s * (1.8 - d.life)); d.m.material.opacity = Math.max(0, d.life * .5); if (d.life <= 0) d.m.visible = false; }
    // skid sound when steering hard at speed
    const skidding = !car.airborne && Math.abs(car.steer) > .35 && Math.abs(car.v) > 14;
    skidT = skidding ? skidT + dt : 0; if (skidT > .25) { W.sfx('skid'); skidT = -1.5; }

    // guide arrow
    if (W.target) { const ang = Math.atan2(W.target.x - car.x, W.target.z - car.z); arrow.position.set(car.x, car.y + 5.2 + Math.sin(now / 250) * .2, car.z); arrow.rotation.set(Math.PI / 2, ang, 0, 'YXZ'); }

    // camera: follow, keep above the ground, zoomable
    tmp.set(car.x + CAM_OFF.x * W.camZoom, car.y + CAM_OFF.y * W.camZoom, car.z + CAM_OFF.z * W.camZoom);
    tmp.y = Math.max(tmp.y, W.groundY(tmp.x, tmp.z) + 3);
    camera.position.lerp(tmp, Math.min(1, dt * 3));
    tmp2.set(car.x, car.y + 1, car.z); camera.lookAt(tmp2);
    sky.position.copy(camera.position);
    sun.position.set(car.x + 20, car.y + 40, car.z + 12); sun.target.position.set(car.x, car.y, car.z);
    for (const c of clouds) { c.position.x += c.userData.v * dt; if (c.position.x > 320) c.position.x = -320; }

    car.kmh = Math.abs(car.v) * 4;
    W.audio.engine(Math.abs(car.v) / 30, keys.fwd || keys.back ? 1 : 0, car.airborne);
    for (const f of updateFns) { try { f(dt, now); } catch (e) { if (!f._err) { f._err = true; console.error(e); } } }

    const kmh = Math.round(car.kmh), fuel = Math.round(car.fuel);
    if (kmh !== shown.kmh) { shown.kmh = kmh; dom.kmh.textContent = kmh; }
    if (fuel !== shown.fuel) { shown.fuel = fuel; dom.fuelBar.style.width = (fuel / car.maxFuel * 100) + '%'; dom.fuelBar.style.background = fuel < 60 ? '#d2473b' : '#f7bd0c'; dom.fuelL.textContent = fuel + ' L'; }
  }
  const shown = { kmh: -1, fuel: -1 };

  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w < 600 ? 50 : 38; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize);

  let last = performance.now(), frames = 0, fpsT = 0;
  W.fps = 0;
  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    frames++; fpsT += dt; if (fpsT >= 1) { W.fps = frames / fpsT; frames = 0; fpsT = 0; }
    renderer.info.reset();
    try { step(dt, now); } catch (e) { console.error(e); }
    drawMini(); renderer.render(scene, camera); requestAnimationFrame(frame);
  }

  /* ---------------- boot ---------------- */
  W.boot = () => {
    car.y = W.groundY(car.x, car.z);
    for (const f of readyFns) { try { f(); } catch (e) { console.error('ready hook failed', e); } }
    buildMiniBase(); resize();
    camera.position.set(car.x + CAM_OFF.x, car.y + CAM_OFF.y, car.z + CAM_OFF.z);
    // Warm both shader variants (night lights on / off) with a real render each, behind the intro overlay, so the first
    // N press does not stall. renderer.compile() would not do: programs compiled before the first shadow pass never sample it.
    W.setNight(true); renderer.render(scene, camera);
    W.setNight(false); renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  W.start = () => { if (W.started) return; W.started = true; dom.intro.hidden = true; W.audio.init(); W.audio.music(true); W.toast('Drive to a glowing ring, or open Missions'); };
  $('start').addEventListener('click', W.start);
  W.hud.button('☾ Night', () => W.setNight(!W.night), { id: 'nightBtn', title: 'Toggle night (N)' });
})();
