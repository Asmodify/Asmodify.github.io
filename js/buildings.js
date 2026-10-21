/* buildings.js — every man-made structure in the world: the town of Khuslen Khot, the power
   plant, the open-pit mine, the bus terminal, the railway with its shuttling freight train,
   the wind farm, a telecom mast, extra gers and the Open T billboard, plus their places,
   colliders and night lighting. Static geometry is merged per material into a handful of
   vertex-coloured meshes (one per site); sleepers, fence posts and lamp poles are
   InstancedMesh; the train, rotors and smoke move. Everything goes through W (CONTRACT.md). */
(() => {
  const W = window.W; if (!W || !W.T) return;
  const T = W.T, PI = Math.PI, hyp = Math.hypot;

  /* ---------------- places: registered at load time so every later module sees them ---------------- */
  const PLACES = [
    ['town', 28, -100, 22, 'Khuslen Khot'], ['mine', 92, 42, 18, 'Mine'], ['powerplant', -86, -26, 16, 'Power plant'],
    ['busTerminal', 62, -22, 12, 'Bus terminal'], ['railStation', 6, 98, 14, 'Rail station'],
    ['windfarm', -70, 78, 18, 'Wind farm'], ['lake', -92, 52, 13, 'Lake']
  ];
  for (const [id, x, z, r, label] of PLACES) if (!W.places[id]) W.addPlace(id, { x, z, r, label });

  const RAIL_Z = 94, RAIL_X0 = -110, RAIL_X1 = 110, TRAIN_LEN = 80;
  const BLD = W.buildings = { ready: false, train: { x: 0, dir: 1, speed: 9, wait: 1.5, length: TRAIN_LEN, cars: [] }, turbines: [], lights: [], meshes: [] };

  /* ---------------- palette (flat colours, W.M values where they exist) ---------------- */
  const C = {
    asphalt: '#3d4046', walk: '#b8b1a3', pavers: '#c6bda9', concrete: '#b8b4ab', dark: '#1c1b19', steel: '#9da5ad', rust: '#8c4a2b',
    white: '#fbfbf7', yellow: '#f7bd0c', blue: '#1f4fd1', red: '#d2473b', wood: '#8a5a2b', roof: '#55585e', glass: '#1e2a44',
    gravel: '#8e8577', coal: '#2b2b2e', ore: '#5e5651', pole: '#4b5058', grey: '#8a8f96', cream: '#e8e0cf', sand: '#d9c99a'
  };

  /* ---------------- geometry merger: many parts, one mesh, colour per vertex ---------------- */
  const VC = new T.MeshStandardMaterial({ vertexColors: true, roughness: .82, metalness: 0, flatShading: true });
  const colCache = new Map();
  const rgb = hex => { let c = colCache.get(hex); if (!c) { const k = new T.Color(hex); c = [k.r, k.g, k.b]; colCache.set(hex, c); } return c; };
  class Bucket {
    constructor(mat, name) { this.mat = mat; this.name = name || ''; this.parts = []; this.nv = 0; this.ni = 0; }
    add(geo, m, color) {
      const g = geo.clone(); if (m) g.applyMatrix4(m);
      if (!g.index) { const n = g.attributes.position.count, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new T.BufferAttribute(idx, 1)); }
      this.parts.push({ g, color }); this.nv += g.attributes.position.count; this.ni += g.index.count; return g;
    }
    build(shadow = true) {
      if (!this.nv) return null;
      const pos = new Float32Array(this.nv * 3), nor = new Float32Array(this.nv * 3), uv = new Float32Array(this.nv * 2), col = new Float32Array(this.nv * 3);
      const idx = this.nv > 65535 ? new Uint32Array(this.ni) : new Uint16Array(this.ni);
      let vo = 0, io = 0;
      for (const { g, color } of this.parts) {
        const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, ca = g.attributes.color, n = pa.count;
        pos.set(pa.array, vo * 3); if (na) nor.set(na.array, vo * 3); if (ua) uv.set(ua.array, vo * 2);
        if (color != null) { const c = rgb(color); for (let i = vo; i < vo + n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; } }
        else if (ca) col.set(ca.array, vo * 3); else col.fill(1, vo * 3, (vo + n) * 3);
        const ia = g.index.array; for (let i = 0; i < ia.length; i++) idx[io + i] = ia[i] + vo;
        vo += n; io += ia.length;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new T.BufferAttribute(uv, 2)); geo.setAttribute('color', new T.BufferAttribute(col, 3));
      geo.setIndex(new T.BufferAttribute(idx, 1)); geo.computeBoundingSphere();
      const mesh = new T.Mesh(geo, this.mat); mesh.castShadow = mesh.receiveShadow = shadow; mesh.name = 'bld-' + this.name;
      this.parts = []; this.nv = this.ni = 0; return mesh;
    }
  }

  /* ---------------- small helpers ---------------- */
  const G = (x, z) => W.groundY(x, z);
  const _p = new T.Vector3(), _q = new T.Quaternion(), _e = new T.Euler(), _s = new T.Vector3(), _a = new T.Vector3(), _b = new T.Vector3(), _up = new T.Vector3();
  const M4 = (x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => { _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz); return new T.Matrix4().compose(_p, _q, _s); };
  const UBOX = new T.BoxGeometry(1, 1, 1), PLANE = new T.PlaneGeometry(1, 1);
  const cylGeo = (rt, rb, h, seg = 12) => new T.CylinderGeometry(rt, rb, h, seg);
  // y is the centre for box/cyl, the bottom for boxB/cylB
  const box = (B, hex, x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) => B.add(UBOX, M4(x, y, z, ry, sx, sy, sz, rx, rz), hex);
  const boxB = (B, hex, x, yb, z, sx, sy, sz, ry = 0) => box(B, hex, x, yb + sy / 2, z, sx, sy, sz, ry);
  const cyl = (B, hex, x, y, z, rt, rb, h, seg = 12, ry = 0, rx = 0, rz = 0) => B.add(cylGeo(rt, rb, h, seg), M4(x, y, z, ry, 1, 1, 1, rx, rz), hex);
  const cylB = (B, hex, x, yb, z, rt, rb, h, seg = 12, ry = 0) => cyl(B, hex, x, yb + h / 2, z, rt, rb, h, seg, ry);
  const cone = (B, hex, x, yb, z, r, h, seg = 12, ry = 0) => B.add(new T.ConeGeometry(r, h, seg), M4(x, yb + h / 2, z, ry), hex);
  // A beam (box, or a round pipe) from a to b.
  function beam(B, hex, ax, ay, az, bx, by, bz, w, h = w, round = false) {
    _a.set(ax, ay, az); _b.set(bx, by, bz); const L = _a.distanceTo(_b); if (L < 1e-4) return;
    _up.set(0, 1, 0); if (Math.abs(by - ay) / L > .995) _up.set(1, 0, 0);
    const m = new T.Matrix4().lookAt(_a, _b, _up); m.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    const g = round ? cylGeo(w / 2, w / 2, L, 8).rotateX(PI / 2) : new T.BoxGeometry(w, h, L);
    B.add(g, m, hex);
  }
  // Local frame: origin (cx,cz), u along (ux,uz), v along the box's local +x when rotated by ry.
  const frame = (cx, cz, ux, uz) => {
    const l = hyp(ux, uz) || 1; ux /= l; uz /= l;
    return { cx, cz, ux, uz, ry: Math.atan2(ux, uz), to: (u, v) => ({ x: cx + u * ux + v * uz, z: cz + u * uz - v * ux }), ang: (du, dv) => Math.atan2(du * ux + dv * uz, du * uz - dv * ux) };
  };
  // Frame-relative box/cylinder: w along v, d along u, yb = bottom (absolute); ry = extra yaw.
  const fbox = (B, hex, F, u, v, yb, w, h, d, ry = 0) => { const p = F.to(u, v); return box(B, hex, p.x, yb + h / 2, p.z, w, h, d, F.ry + ry); };
  const fcyl = (B, hex, F, u, v, yb, rt, rb, h, seg = 12) => { const p = F.to(u, v); return cyl(B, hex, p.x, yb + h / 2, p.z, rt, rb, h, seg); };
  const fG = (F, u, v) => { const p = F.to(u, v); return G(p.x, p.z); };

  // Colliders: a rectangle approximated by a row of circles along its long side.
  function solidBox(x, z, a, w, d, tag) {
    const long = Math.max(w, d), short = Math.min(w, d), r = Math.max(short / 2, 1.2);
    const dx = w >= d ? Math.cos(a) : Math.sin(a), dz = w >= d ? -Math.sin(a) : Math.cos(a);
    const span = Math.max(0, long - 2 * r), n = Math.max(1, Math.ceil(span / (r * 1.1)) + 1), out = [];
    for (let i = 0; i < n; i++) { const t = n === 1 ? 0 : -span / 2 + span * i / (n - 1); out.push(W.solid(x + dx * t, z + dz * t, r, tag)); }
    return out;
  }
  const fsolid = (F, u, v, w, d, tag, ry = 0) => { const p = F.to(u, v); return solidBox(p.x, p.z, F.ry + ry, w, d, tag); };

  // A ground-hugging plane (street, apron, pad) built on a grid so it follows W.groundY.
  function groundGrid(B, F, u0, u1, v0, v1, step, hex, lift = .04) {
    const nu = Math.max(1, Math.ceil((u1 - u0) / step)), nv = Math.max(1, Math.ceil((v1 - v0) / step));
    const pos = new Float32Array((nu + 1) * (nv + 1) * 3), idx = new Uint32Array(nu * nv * 6);
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const p = F.to(u0 + (u1 - u0) * i / nu, v0 + (v1 - v0) * j / nv), k = (j * (nu + 1) + i) * 3;
      pos[k] = p.x; pos[k + 1] = G(p.x, p.z) + lift; pos[k + 2] = p.z;
    }
    let w = 0;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; idx[w++] = a; idx[w++] = c; idx[w++] = b; idx[w++] = b; idx[w++] = c; idx[w++] = d; }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setIndex(new T.BufferAttribute(idx, 1)); g.computeVertexNormals();
    if (g.attributes.normal.getY(0) < 0) { const ia = g.index.array; for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; } g.computeVertexNormals(); }
    B.add(g, null, hex);
  }

  // Faces of a w×h×d box (0 px, 1 nx, 2 py, 3 ny, 4 pz, 5 nz) as their own geometry, with optional window UV tiling.
  function boxFaces(w, h, d, faces, tile) {
    const bg = new T.BoxGeometry(w, h, d), bp = bg.attributes.position, bn = bg.attributes.normal, bu = bg.attributes.uv, bi = bg.index.array;
    const nF = faces.length, pos = new Float32Array(nF * 12), nor = new Float32Array(nF * 12), uv = new Float32Array(nF * 8), idx = new Uint16Array(nF * 6);
    faces.forEach((f, k) => {
      let cols = 1, rows = 1, ox = 0, oy = 0;
      if (tile) { const fw = f < 2 ? d : w; cols = Math.max(1, Math.round(fw / tile.pitch)); rows = Math.max(1, Math.round(h / tile.floor)); ox = Math.floor(W.rng() * 8); oy = Math.floor(W.rng() * 8); }
      for (let i = 0; i < 4; i++) {
        const s = f * 4 + i, t = k * 4 + i;
        pos[t * 3] = bp.getX(s); pos[t * 3 + 1] = bp.getY(s); pos[t * 3 + 2] = bp.getZ(s);
        nor[t * 3] = bn.getX(s); nor[t * 3 + 1] = bn.getY(s); nor[t * 3 + 2] = bn.getZ(s);
        uv[t * 2] = (bu.getX(s) * cols + ox) / 8; uv[t * 2 + 1] = (bu.getY(s) * rows + oy) / 8;
      }
      for (let i = 0; i < 6; i++) idx[k * 6 + i] = bi[f * 6 + i] - f * 4 + k * 4;
    });
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setIndex(new T.BufferAttribute(idx, 1));
    return g;
  }

  // Window-grid facade material from W.windowTex, with an emissive map of the lit panes only (glows at night).
  function facadeMat(wall, pane, lit) {
    const tex = W.windowTex(8, 8, { lit, pane, wall }); tex.wrapS = tex.wrapT = T.RepeatWrapping;
    let em = null;
    try {
      const src = tex.image, w = src.width, h = src.height, d = src.getContext('2d').getImageData(0, 0, w, h).data;
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'), img = x.createImageData(w, h);
      for (let i = 0; i < d.length; i += 4) { const on = d[i] === 255 && d[i + 1] === 233 && d[i + 2] === 168; img.data[i] = on ? 255 : 0; img.data[i + 1] = on ? 190 : 0; img.data[i + 2] = on ? 90 : 0; img.data[i + 3] = 255; }
      x.putImageData(img, 0, 0); em = new T.CanvasTexture(c); em.wrapS = em.wrapT = T.RepeatWrapping; em.anisotropy = 4;
    } catch (e) { em = null; }
    const m = new T.MeshStandardMaterial({ map: tex, roughness: .92, metalness: 0 });
    if (em) { m.emissiveMap = em; m.emissive = new T.Color('#ffffff'); m.emissiveIntensity = 0; W.nightGlow.push(m); }
    return m;
  }

  /* ---------------- sign atlas: every sign in the world shares one canvas and one draw call ---------------- */
  const atlas = (() => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 1024; const x = c.getContext('2d'); // 16 slots of 512x128, drawn at 1024x256 through a 0.5 scale
    const tex = new T.CanvasTexture(c); tex.anisotropy = 4; const specs = [];
    const SW = 1024, SH = 256;
    function draw(sp, i) {
      const sx = (i % 2) * SW / 2, sy = Math.floor(i / 2) * SH / 2, o = sp.o;
      x.save(); x.translate(sx, sy); x.scale(.5, .5); x.clearRect(0, 0, SW, SH);
      x.fillStyle = o.bg || C.blue; x.fillRect(0, 0, SW, SH);
      if (o.border !== false) { x.strokeStyle = o.border || 'rgba(255,255,255,.85)'; x.lineWidth = 10; x.strokeRect(16, 16, SW - 32, SH - 32); }
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = o.fg || '#ffffff';
      let size = o.size || (sp.sub ? 120 : 150); x.font = `800 ${size}px Archivo, "IBM Plex Sans", sans-serif`;
      while (x.measureText(sp.title).width > SW - 140 && size > 40) { size -= 6; x.font = `800 ${size}px Archivo, "IBM Plex Sans", sans-serif`; }
      x.fillText(sp.title, SW / 2, sp.sub ? SH * .39 : SH / 2);
      if (sp.sub) { x.fillStyle = o.sub || 'rgba(255,255,255,.78)'; x.font = '500 46px "IBM Plex Mono", monospace'; x.fillText(sp.sub, SW / 2, SH * .76); }
      x.restore();
    }
    const redraw = () => { specs.forEach(draw); tex.needsUpdate = true; };
    return {
      tex, redraw,
      slot(title, sub, o = {}) {
        if (specs.length >= 16) return null;
        const i = specs.length; specs.push({ title, sub, o }); draw(specs[i], i); tex.needsUpdate = true;
        const sx = (i % 2) * SW / 2, sy = Math.floor(i / 2) * SH / 2;
        return { u0: sx / 1024, u1: (sx + SW / 2) / 1024, vTop: 1 - sy / 1024, vBot: 1 - (sy + SH / 2) / 1024, aspect: SW / SH };
      }
    };
  })();

  /* ---------------- shared buckets, lists and state ---------------- */
  let SIGNS, WIN, LAMP, BEACON, MISC, FAC = [];
  const lampPosts = [], fencePosts = [], lights = [], smoke = { items: [], mesh: null };
  const beaconMat = new T.MeshStandardMaterial({ color: '#6a1a14', emissive: '#ff4a3a', emissiveIntensity: 0, roughness: .6 });

  // A sign face w metres wide centred at (x, y, z), facing world yaw ry; backing board, optional posts.
  function sign(slot, x, y, z, w, ry, o = {}) {
    if (!slot) return;
    const h = w / slot.aspect, g = PLANE.clone(), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, slot.u0 + uv.getX(i) * (slot.u1 - slot.u0), slot.vBot + uv.getY(i) * (slot.vTop - slot.vBot));
    const B = o.bucket || MISC, nx = Math.sin(ry), nz = Math.cos(ry);
    SIGNS.add(g, M4(x, y, z, ry, w, h, 1), null);
    SIGNS.add(g.clone(), M4(x - nx * .13, y, z - nz * .13, ry + PI, w, h, 1), null); // same face on the back, so a sign reads from the chase camera whichever way it was turned
    if (o.back !== false) box(B, o.backColor || '#2b2e33', x - nx * .06, y, z - nz * .06, w + .14, h + .14, .1, ry);
    if (o.posts) {
      const px = Math.cos(ry), pz = -Math.sin(ry), off = w / 2 - .35, top = y - h / 2 + .1;
      for (const s of [-1, 1]) { const qx = x + px * off * s - nx * .1, qz = z + pz * off * s - nz * .1; const y0 = G(qx, qz); boxB(B, o.postColor || C.pole, qx, y0 - .2, qz, .12, top - y0 + .2, .12, ry); }
      if (o.solid !== false) W.solid(x, z, Math.max(.6, w * .3), 'sign');
    }
  }
  const lamp = (x, z, ry, h = 6) => { const y = G(x, z); lampPosts.push({ x, y, z, ry, h }); box(LAMP, null, x + Math.sin(ry) * 1.15, y + h - .06, z + Math.cos(ry) * 1.15, .78, .16, .34, ry); };
  const light = (x, y, z, color = '#ffd58a', dist = 30) => { if (lights.length >= 6) return null; const l = new T.PointLight(color, 0, dist, 1.2); l.position.set(x, y, z); l.visible = false; W.scene.add(l); lights.push(l); return l; };
  // Fence along world points: instanced posts every ~2.5 m, three rails between them; o.skip(xm, zm) leaves a gap.
  function fence(B, pts, closed, o = {}) {
    const hex = o.color || C.steel, n = pts.length, segs = closed ? n : n - 1, gap = o.gap || 2.5, rails = o.rails || [.5, 1.0, 1.5];
    for (let s = 0; s < segs; s++) {
      const a = pts[s], b = pts[(s + 1) % n], L = hyp(b.x - a.x, b.z - a.z), k = Math.max(1, Math.round(L / gap));
      for (let i = 0; i < k; i++) {
        const x0 = a.x + (b.x - a.x) * i / k, z0 = a.z + (b.z - a.z) * i / k, x1 = a.x + (b.x - a.x) * (i + 1) / k, z1 = a.z + (b.z - a.z) * (i + 1) / k;
        if (o.skip && o.skip((x0 + x1) / 2, (z0 + z1) / 2)) continue;
        const y0 = G(x0, z0), y1 = G(x1, z1);
        fencePosts.push({ x: x0, y: y0, z: z0 });
        for (const hh of rails) beam(B, hex, x0, y0 + hh, z0, x1, y1 + hh, z1, .05, .05);
        if (o.solid !== false && i % 2 === 0) W.solid((x0 + x1) / 2, (z0 + z1) / 2, Math.max(.6, L / k * .55), 'fence');
      }
    }
    if (!closed) { const e = pts[n - 1]; fencePosts.push({ x: e.x, y: G(e.x, e.z), z: e.z }); }
  }
  const rect = (F, u0, u1, v0, v1) => [F.to(u0, v0), F.to(u1, v0), F.to(u1, v1), F.to(u0, v1)];

  // An apartment block: textured facade on the chosen faces, plinth down to the lowest corner, roof details, doors.
  function block(B, F, u, v, w, d, h, o = {}) {
    const ys = [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]].map(([a, b]) => fG(F, u + b, v + a));
    const yTop = Math.max(...ys), yLow = Math.min(...ys), yb = yTop + .05, wall = o.wall || C.concrete, roof = o.roof || C.roof;
    const faces = o.faces || [0, 1, 4, 5], blank = [0, 1, 4, 5].filter(f => !faces.includes(f)), p = F.to(u, v);
    fbox(B, o.plinth || '#8d877c', F, u, v, yLow - .6, w + .2, yb - yLow + 1.0, d + .2);
    (o.fac || FAC[0]).add(boxFaces(w, h, d, faces, { pitch: o.pitch || 3, floor: o.floor || 3 }), M4(p.x, yb + h / 2, p.z, F.ry), null);
    if (blank.length) B.add(boxFaces(w, h, d, blank), M4(p.x, yb + h / 2, p.z, F.ry), wall);
    fbox(B, roof, F, u, v, yb + h, w + .12, .28, d + .12);
    const yp = yb + h + .28;
    fbox(B, wall, F, u, v - w / 2 + .12, yp, .24, .4, d); fbox(B, wall, F, u, v + w / 2 - .12, yp, .24, .4, d);
    fbox(B, wall, F, u - d / 2 + .12, v, yp, w, .4, .24); fbox(B, wall, F, u + d / 2 - .12, v, yp, w, .4, .24);
    fbox(B, o.hood || '#9a9388', F, u + (W.rng() - .5) * d * .35, v + (W.rng() - .5) * w * .3, yp, 2.2, 1.3, 2.6);
    fcyl(B, '#6c7076', F, u - d * .3, v + w * .28, yp, .22, .22, 1.1, 8);
    if (o.door) { const n = Math.max(1, Math.round(d / 6)); for (let i = 0; i < n; i++) { const du = -d / 2 + d * (i + .5) / n; fbox(B, '#2f3237', F, u + du, v + o.door * (w / 2 + .05), yb, .12, 2.2, 1.3); fbox(B, '#b5aea2', F, u + du, v + o.door * (w / 2 + .55), yb + 2.45, 1.25, .14, 2.0); } }
    fsolid(F, u, v, w + .4, d + .4, 'building');
    return yb;
  }

  // Chimney with red bands, a cap and a blinking beacon; returns the top for smoke.
  function chimney(B, x, z, h, rb = 1.6, rt = 1.1) {
    const y = G(x, z); cylB(B, '#d9d2c8', x, y - .5, z, rt, rb, h + .5, 16);
    for (const f of [.56, .76, .96]) { const r = rb + (rt - rb) * f; cyl(B, '#c7342a', x, y + h * f, z, r + .05, r + .05, h * .06, 16); }
    cyl(B, '#4a4d52', x, y + h + .2, z, rt + .14, rt + .08, .45, 16); box(BEACON, null, x, y + h + .62, z, .36, .36, .36);
    W.solid(x, z, rb + .4, 'chimney'); return { x, z, top: y + h + .25 };
  }
  const smokeAt = (x, z, y, n) => { for (let i = 0; i < n; i++) smoke.items.push({ x, z, y, t: i / n, life: 6.5 + W.rng() * 2.5, jx: (W.rng() - .5) * .9, jz: (W.rng() - .5) * .9, s: .9 + W.rng() * .5, w: W.rng() * 6.28 }); };

  // A ger through W.ger, re-baked into a bucket so it costs no draw calls (fallback shape when W.ger is missing).
  function ger(B, x, z, s = 1, rot = 0) {
    if (typeof W.ger === 'function') {
      const g = W.ger(x, z, s, rot); if (!g) return; g.updateMatrixWorld(true);
      g.traverse(m => { if (m.isMesh && m.geometry && m.material) B.add(m.geometry, m.matrixWorld, '#' + (m.material.color ? m.material.color.getHexString() : 'fbfbf7')); });
      W.scene.remove(g); return;
    }
    const y = G(x, z);
    cylB(B, C.white, x, y, z, 2.4 * s, 2.4 * s, 1.8 * s, 20); cyl(B, C.blue, x, y + 1.55 * s, z, 2.42 * s, 2.42 * s, .25 * s, 20);
    cone(B, C.white, x, y + 1.8 * s, z, 2.7 * s, 1.3 * s, 20); cyl(B, C.red, x, y + 3.1 * s, z, .35 * s, .35 * s, .2 * s, 8);
    box(B, C.red, x + Math.sin(rot) * 2.38 * s, y + .65 * s, z + Math.cos(rot) * 2.38 * s, .9 * s, 1.3 * s, .2 * s, rot);
    W.solid(x, z, 2.5 * s, 'ger');
  }
  // Wheel geometry with its axle along x.
  const wheelGeo = (r, w, seg = 12) => cylGeo(r, r, w, seg).rotateZ(PI / 2);
  const wheel = (B, x, y, z, r, w, ry = 0, hex = C.dark) => { B.add(wheelGeo(r, w), M4(x, y, z, ry), hex); B.add(wheelGeo(r * .45, w + .04, 8), M4(x, y, z, ry), '#8a8a8a'); };

  /* ======================================================================================
     THE SITES
     ====================================================================================== */

  /* ---------- Khuslen Khot: 12 blocks, a shop, a square with an obelisk, streetlights, parked cars ---------- */
  function buildTown() {
    const B = new Bucket(VC, 'town'), F = frame(28, -100, .486, -.874); // u runs NNE along the main street, +v is WNW (away from the camera)
    // streets and pavements (ground-following), the square
    groundGrid(B, F, -8.5, 21, -4.5, 4.5, 2, C.asphalt, .03);
    groundGrid(B, F, -8.5, 21, 4.5, 6.6, 2, C.walk, .05); groundGrid(B, F, -8.5, 21, -6.6, -4.5, 2, C.walk, .05);
    groundGrid(B, F, 4, 8.5, 6.6, 24, 2, C.asphalt, .06); groundGrid(B, F, 4, 8.5, -24, -6.6, 2, C.asphalt, .06);
    groundGrid(B, F, 21, 31, -8.5, 8.5, 2, C.pavers, .05);
    // apartment blocks (u, v, w across, d along the street, height); tall ones on the +v side, low ones on the camera side
    const facA = FAC[0], facB = FAC[1], facC = FAC[2];
    block(B, F, -3, 10, 7, 12, 12.5, { faces: [0, 1], door: -1, fac: facA });
    block(B, F, 14, 10, 7, 12, 12.5, { faces: [0, 1], door: -1, fac: facB, wall: '#d8cfc0' });
    block(B, F, -3, 19, 8, 8, 20, { fac: facC, plinth: '#7d7a76', roof: '#4a4d52' });
    block(B, F, 14, 19.5, 7, 10, 12.5, { faces: [0, 1], fac: facA });
    block(B, F, -14, 10, 7, 8, 9.5, { faces: [0, 1], door: -1, fac: facB });
    block(B, F, 4, 27.5, 7, 12, 12.5, { faces: [0, 1], fac: facB, wall: '#d8cfc0' });
    block(B, F, 22, 12, 8, 8, 15.5, { fac: facC, plinth: '#7d7a76' });
    block(B, F, -3, -11, 7, 12, 6.5, { faces: [0, 1], door: 1, fac: facA });
    block(B, F, -3, -19, 7, 12, 9.5, { faces: [0, 1], fac: facB });
    block(B, F, 14, -19, 8, 8, 12.5, { fac: facC });
    block(B, F, 22, -12, 8, 8, 9.5, { fac: facA });
    block(B, F, 4, -27.5, 8, 8, 9.5, { fac: facC });
    // the shop: low, glass front on the street, a sign
    { const u = 14, v = -10.5, w = 6, d = 12, y = fG(F, u, v) + .05;
      fbox(B, '#8d877c', F, u, v, y - .5, w + .2, .6, d + .2); fbox(B, C.cream, F, u, v, y, w, 4.6, d); fbox(B, C.roof, F, u, v, y + 4.6, w + .3, .3, d + .3);
      fbox(B, '#9a9388', F, u + 2, v - 1, y + 4.9, 1.6, .8, 1.2);
      for (const du of [-4, -1.2, 1.6]) fbox(WIN, null, F, u + du, v + w / 2 + .04, y + .5, .08, 2.2, 2.4);
      fbox(B, '#2f3237', F, u + 4.2, v + w / 2 + .05, y, .1, 2.4, 1.4); fbox(B, C.red, F, u, v + w / 2 + .5, y + 3.0, 1.1, .16, 11.6);
      const p = F.to(u, v + w / 2 + .12); sign(atlas.slot('DELGUUR', 'дэлгүүр · shop · 24 h', { bg: C.red, fg: '#ffffff', sub: 'rgba(255,255,255,.85)' }), p.x, y + 3.9, p.z, 7, F.ang(0, 1), { bucket: B, backColor: '#8d2a21' });
      fsolid(F, u, v, w + .4, d + .4, 'building'); }
    // the square: a stepped obelisk with a gold tip, benches, flagpole
    { const u = 26, v = 0, y = fG(F, u, v) + .05, p = F.to(u, v);
      fbox(B, '#d6d0c2', F, u, v, y, 5, .45, 5); fbox(B, '#c9c2b2', F, u, v, y + .45, 3.6, .45, 3.6);
      B.add(cylGeo(.38, .8, 9, 4), M4(p.x, y + .9 + 4.5, p.z, F.ry + PI / 4), '#e2dcd0'); cone(B, C.yellow, p.x, y + 9.9, p.z, .62, 1.0, 4, F.ry + PI / 4);
      W.solid(p.x, p.z, 1.8, 'obelisk');
      for (const [du, dv] of [[-3.5, -3.5], [-3.5, 3.5], [3.5, -3.5], [3.5, 3.5]]) { fbox(B, C.wood, F, u + du, v + dv, y + .45, .5, .1, 2.2); fbox(B, C.dark, F, u + du, v + dv - .9, y, .4, .45, .3); fbox(B, C.dark, F, u + du, v + dv + .9, y, .4, .45, .3); }
      fcyl(B, C.white, F, u - 3.5, v, y, .06, .08, 8, 6); fbox(B, C.blue, F, u - 3.5, v + .6, y + 7.2, 1.2, .8, .04);
      fbox(B, C.red, F, u - 3.5, v + .2, y + 7.2, .4, .8, .04); }
    // bus stop near the entrance (camera side, low)
    { const u = -8.5, v = -6, y = fG(F, u, v) + .05;
      fbox(B, C.blue, F, u, v, y + 2.6, 1.8, .16, 4.2); fbox(B, C.glass, F, u, v - .85, y + .4, .06, 2.1, 4.2);
      for (const du of [-1.95, 1.95]) fbox(B, C.pole, F, u + du, v - .8, y, .1, 2.6, .1);
      fbox(B, C.wood, F, u, v - .3, y + .5, .45, .1, 3.2); fbox(B, C.dark, F, u - 1.3, v - .3, y, .3, .5, .3); fbox(B, C.dark, F, u + 1.3, v - .3, y, .3, .5, .3);
      const p = F.to(u + 2.7, v + .4); sign(atlas.slot('BUS', 'автобус · stop', { bg: C.blue }), p.x, y + 2.9, p.z, 1.6, F.ang(0, 1), { bucket: B, posts: true, solid: false });
      fsolid(F, u, v - .6, 1.6, 4.4, 'busstop'); }
    // welcome sign facing arriving traffic
    { const p = F.to(-8, 7.6); sign(atlas.slot('KHUSLEN KHOT', 'Хүслэн хот · town · pop. 1 200', { bg: C.blue }), p.x, G(p.x, p.z) + 2.9, p.z, 5.2, F.ang(-1, 0), { bucket: B, posts: true }); }
    // streetlights along the main street and around the square, three point lights for the night
    for (const u of [-6, 2, 10, 18]) { const a = F.to(u, 5.4), b = F.to(u, -5.4); lamp(a.x, a.z, F.ang(0, -1)); lamp(b.x, b.z, F.ang(0, 1)); }
    for (const dv of [-7, 7]) { const p = F.to(29.5, dv); lamp(p.x, p.z, F.ang(0, -Math.sign(dv))); }
    for (const u of [-2, 14, 26]) { const p = F.to(u, 0); light(p.x, G(p.x, p.z) + 5.6, p.z, '#ffd58a', 30); }
    // parked cars: pushable, one merged mesh each
    const cars = [[-5, 3.3, C.red], [0, -3.3, C.white], [11, 3.3, C.blue], [16, -3.3, '#6b7280'], [19.5, 3.3, '#2b7a4b']];
    for (const [u, v, hex] of cars) {
      const CB = new Bucket(VC, 'car');
      box(CB, hex, 0, -.1, 0, 1.7, .55, 3.9); box(CB, hex, 0, .42, -.2, 1.5, .5, 2.0); box(CB, C.glass, 0, .42, .83, 1.4, .42, .08); box(CB, C.glass, 0, .42, -1.23, 1.4, .42, .08);
      box(CB, C.glass, .76, .42, -.2, .06, .4, 1.7); box(CB, C.glass, -.76, .42, -.2, .06, .4, 1.7); box(CB, '#fff6c8', .55, -.1, 1.96, .35, .18, .06); box(CB, '#fff6c8', -.55, -.1, 1.96, .35, .18, .06);
      box(CB, '#7a1d17', .6, -.1, -1.96, .35, .18, .06); box(CB, '#7a1d17', -.6, -.1, -1.96, .35, .18, .06);
      for (const [wx, wz] of [[.85, 1.25], [-.85, 1.25], [.85, -1.25], [-.85, -1.25]]) CB.add(wheelGeo(.32, .22, 10), M4(wx, -.48, wz), C.dark);
      const m = CB.build(); const p = F.to(u, v); m.position.set(p.x, 0, p.z); m.rotation.y = F.ry + (u > 5 ? PI : 0) + (W.rng() - .5) * .1;
      W.breakable(W.pushable(m, .8, 1.3, { tag: 'car' }), { at: 11, colors: [hex, hex, C.glass, C.dark, '#2b2e33'], n: 16, size: [.18, .55], kind: 'metal' }); BLD.meshes.push(m);
    }
    BLD.meshes.push(finish(B));
  }

  /* ---------- power plant: three banded chimneys, boiler house, turbine hall, pylons, fence, smoke ---------- */
  function buildPlant() {
    const B = new Bucket(VC, 'plant'), F = frame(-86, -26, -.916, -.4); // gate at u = -13 (the dirt track ends there), +u and -v lead away from the camera
    groundGrid(B, F, -14, 1, -7, 7, 2, C.asphalt, .03); groundGrid(B, F, -1, 14, -2, 2, 2, C.asphalt, .03);
    // boiler house (tall) with vertical window strips on the camera side (+v), turbine hall (long) with a roof monitor beyond
    { const u = 5, v = 5.5, y = fG(F, u, v) + .05;
      fbox(B, '#b3ada3', F, u, v, y, 9, 13, 12); fbox(B, '#6e6a63', F, u, v, y - .3, 9.3, 1.3, 12.3); fbox(B, C.roof, F, u, v, y + 13, 9.3, .3, 12.3);
      for (const dv of [-2.6, -1.0, .6, 2.2]) fbox(WIN, null, F, u - 6.05, v + dv, y + 3, .9, 8, .08);
      for (const du of [-3, 0, 3]) fbox(WIN, null, F, u + du, v - 4.55, y + 9, .08, 1.6, 2);
      fbox(B, '#4a4d52', F, u - 6.06, v + 3.4, y, 2.6, 3.4, .1);
      fsolid(F, u, v, 9.4, 12.4, 'plant'); }
    { const u = 7, v = -6.5, y = fG(F, u, v) + .05;
      fbox(B, '#cdc5b7', F, u, v, y, 8, 8.5, 16); fbox(B, '#6e6a63', F, u, v, y - .3, 8.3, 1.2, 16.3); fbox(B, C.roof, F, u, v, y + 8.5, 8.3, .3, 16.3);
      fbox(B, C.grey, F, u, v, y + 8.8, 3, 1.2, 13); fbox(B, C.roof, F, u, v, y + 10, 3.4, .2, 13.4);
      for (const du of [-6, -3.6, -1.2, 1.2, 3.6, 6]) fbox(WIN, null, F, u + du, v + 4.05, y + 4.6, .08, 1.3, 1.7);
      fbox(B, '#4a4d52', F, u - 8.05, v, y, 4.5, 5.2, .1);
      // a pipe rack along the hall's yard-side wall
      for (const ph of [6.4, 7.1]) { const a = F.to(-1.5, -2.15), b = F.to(15.5, -2.15); beam(B, C.steel, a.x, y + ph, a.z, b.x, y + ph, b.z, .44, .44, true); }
      for (const du of [1, 7, 13]) { const p = F.to(du, -2.15); boxB(B, C.steel, p.x, y, p.z, .22, 7.3, .22, F.ry); fbox(B, C.steel, F, du, -2.3, y + 7.2, .5, .12, .12); }
      fsolid(F, u, v, 8.4, 16.4, 'plant'); }
    // chimneys beside the boiler house, smoke drifting with the wind
    for (const [u, h] of [[-1, 24], [5, 28], [11, 26]]) { const p = F.to(u, 11.2); const c = chimney(B, p.x, p.z, h); smokeAt(c.x, c.z, c.top, 11); }
    // coal heap and an inclined stacker conveyor up into the boiler house
    { const p = F.to(-8, -3.5), y = G(p.x, p.z); cone(B, C.coal, p.x, y - .2, p.z, 3.6, 2.6, 12); W.solid(p.x, p.z, 3.2, 'coal'); // heap on the camera-facing side so the stacker runs across the view, not along it
      const a = F.to(-10, -4.5), b = F.to(-.6, 5.2); beam(B, C.grey, a.x, y + 1.2, a.z, b.x, y + 8.4, b.z, 1.1, .5);
      for (const t of [.3, .65]) { const q = F.to(-10 + 9.4 * t, -4.5 + 9.7 * t), yq = G(q.x, q.z); boxB(B, C.steel, q.x, yq, q.z, .2, 1.2 + 7.2 * t - .4, .2, F.ry); } }
    // transformer yard and two pylons with wires leaving the site
    { for (const [du, dv] of [[-6.5, -9], [-3.5, -9], [-6.5, -12], [-3.5, -12]]) { const y = fG(F, du, dv) + .05; fbox(B, '#5f666e', F, du, dv, y, 1.8, 2.2, 1.4); for (const k of [-.5, 0, .5]) fcyl(B, '#d9d2c8', F, du + k, dv, y + 2.2, .08, .08, .7, 6); fsolid(F, du, dv, 2, 1.6, 'transformer'); }
      const pylon = (u, v, h) => { const p = F.to(u, v), y = G(p.x, p.z), s = Math.sin(F.ry), c = Math.cos(F.ry);
        for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) beam(B, C.steel, p.x + (a * 1.6 * c + b * 1.6 * s), y - .2, p.z + (-a * 1.6 * s + b * 1.6 * c), p.x + (a * .45 * c + b * .45 * s), y + h, p.z + (-a * .45 * s + b * .45 * c), .16, .16);
        for (const hh of [h * .55, h * .75, h * .95]) box(B, C.steel, p.x, y + hh, p.z, .14, .14, 7, F.ry);
        for (const hh of [h * .4, h * .7]) { box(B, C.steel, p.x, y + hh, p.z, 2.4, .12, .12, F.ry); box(B, C.steel, p.x, y + hh, p.z, .12, .12, 2.4, F.ry); }
        W.solid(p.x, p.z, 1.9, 'pylon'); return { p, y, h }; };
      const A = pylon(-10.5, -10.5, 16), Bp = pylon(-10.5, -29, 15);
      for (const k of [-3, 0, 3]) { const sx = Math.sin(F.ry) * k, sz = Math.cos(F.ry) * k, f = k ? .75 : .95;
        beam(B, '#2b2e33', A.p.x + sx, A.y + A.h * f - .3, A.p.z + sz, Bp.p.x + sx, Bp.y + Bp.h * f - .3, Bp.p.z + sz, .05, .05); }
    }
    // gate: pillars, raised barrier, guard hut, sign; fence with a gap at the gate
    { const yg = fG(F, -13, 0);
      for (const dv of [-3.6, 3.6]) fbox(B, C.concrete, F, -13, dv, yg, .5, 2.2, .5);
      const a = F.to(-13, 3.3), b = F.to(-13, .2); beam(B, C.red, a.x, yg + 1.1, a.z, b.x, yg + 4.6, b.z, .12, .12); beam(B, C.white, a.x, yg + 1.1, a.z, (a.x + b.x) / 2, yg + 2.85, (a.z + b.z) / 2, .13, .13);
      fbox(B, C.concrete, F, -13, 3.3, yg, .4, 1.1, .4);
      const yh = fG(F, -11.3, 5.6) + .05; fbox(B, C.cream, F, -11.3, 5.6, yh, 2.6, 2.7, 2.6); fbox(B, C.roof, F, -11.3, 5.6, yh + 2.7, 3, .2, 3); fbox(WIN, null, F, -12.65, 5.6, yh + 1.1, .08, 1.1, 1.6); fsolid(F, -11.3, 5.6, 2.8, 2.8, 'hut');
      const p = F.to(-13.6, -6); sign(atlas.slot('POWER PLANT', 'ТЭЦ · tsakhilgaan stants', { bg: '#f6f4ee', fg: '#18202b', sub: '#5a6573', border: '#18202b' }), p.x, G(p.x, p.z) + 2.7, p.z, 5, F.ang(-1, 0), { bucket: B, posts: true });
      fence(B, rect(F, -13, 13, -13, 13), true, { skip: (x, z) => { const d = hyp(x - F.to(-13, 0).x, z - F.to(-13, 0).z); return d < 3.6; } }); }
    for (const [u, v] of [[-12.5, -6.5], [-12.5, 6.5], [-6, -6.5], [-2.5, 2.4]]) { const p = F.to(u, v); lamp(p.x, p.z, F.ang(0, -Math.sign(v))); }
    BLD.meshes.push(finish(B));
  }

  /* ---------- the mine: a stepped open pit, an excavator, a huge dump truck, a conveyor and stockpile, ore rocks ---------- */
  function buildMine() {
    const B = new Bucket(VC, 'mine'), F = frame(92, 42, 6, 5); // the east spur arrives at u ≈ -8
    groundGrid(B, F, -12, 12, -1, 13, 2, C.gravel, .03);
    // the pit: a lathe profile (floor, four terraces, rim, skirt into the ground), faces coloured by orientation
    { const pc = F.to(6, -12), y = G(pc.x, pc.z);
      const prof = [[0, .06], [3.2, .06], [3.2, .9], [5.2, .9], [5.2, 1.7], [7, 1.7], [7, 2.5], [8.8, 2.5], [8.8, 3.2], [10.6, 3.2], [12.8, .5], [13.6, -1.4]].map(([r, h]) => new T.Vector2(r, h));
      let g = new T.LatheGeometry(prof, 30).toNonIndexed(); const pa = g.attributes.position, n = pa.count, col = new Float32Array(n * 3);
      const A = new T.Vector3(), Bv = new T.Vector3(), Cv = new T.Vector3(), N = new T.Vector3();
      for (let i = 0; i < n; i += 3) {
        A.fromBufferAttribute(pa, i); Bv.fromBufferAttribute(pa, i + 1); Cv.fromBufferAttribute(pa, i + 2);
        N.subVectors(Bv, A).cross(Cv.clone().sub(A)); const cx = (A.x + Bv.x + Cv.x) / 3, cz = (A.z + Bv.z + Cv.z) / 3, cy = (A.y + Bv.y + Cv.y) / 3, rc = hyp(cx, cz);
        const horiz = Math.abs(N.y) > .6 * N.length();
        // orient: tops face up, inner walls face the axis, the outer skirt faces away
        const want = horiz ? N.y > 0 : (rc < 10.6 ? (N.x * cx + N.z * cz) < 0 : (N.x * cx + N.z * cz) > 0);
        if (!want) { pa.setXYZ(i + 1, Cv.x, Cv.y, Cv.z); pa.setXYZ(i + 2, Bv.x, Bv.y, Bv.z); }
        const j = (Math.sin(cx * 12.9 + cz * 7.3) * .5 + .5) * .12;
        const hex = horiz ? (cy < .5 ? '#7d6a5b' : rc > 10 ? '#a89470' : '#b08c62') : (rc > 10.8 ? '#8f7f6a' : '#6e6055');
        const c = rgb(hex); for (let k = 0; k < 3; k++) { col[(i + k) * 3] = Math.min(1, c[0] * (1 - j)); col[(i + k) * 3 + 1] = Math.min(1, c[1] * (1 - j)); col[(i + k) * 3 + 2] = Math.min(1, c[2] * (1 - j)); }
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3)); g.computeVertexNormals();
      B.add(g, M4(pc.x, y, pc.z), null);
      for (let i = 0; i < 12; i++) { const a = i / 12 * PI * 2; W.solid(pc.x + Math.cos(a) * 9.6, pc.z + Math.sin(a) * 9.6, 2.5, 'pit'); }
      // excavator on the pit floor
      const ex = frame(pc.x + 1.2, pc.z - .6, .6, -.8), ey = y + .06;
      fbox(B, '#3a3d42', ex, 0, 0, ey, 2.6, .9, 3.2); fbox(B, C.yellow, ex, 0, 0, ey + .9, 2.4, 1.3, 2.6); fbox(B, C.yellow, ex, .9, -.8, ey + .9, .9, 1.5, 1.0); fbox(B, C.glass, ex, 1.42, -.8, ey + 1.5, .06, .8, .9);
      const b0 = ex.to(1.2, .4), b1 = ex.to(4.0, .4), b2 = ex.to(5.6, .4);
      beam(B, C.yellow, b0.x, ey + 2.1, b0.z, b1.x, ey + 4.0, b1.z, .45, .5); beam(B, C.yellow, b1.x, ey + 4.0, b1.z, b2.x, ey + 1.6, b2.z, .32, .4); box(B, C.dark, b2.x, ey + 1.1, b2.z, 1.1, .9, .8, ex.ry); }
    // a huge dump truck (wheels 1.45 m)
    { const p = F.to(-1.5, 6.5), y = G(p.x, p.z), ry = F.ry + .25, K = frame(p.x, p.z, Math.sin(ry), Math.cos(ry));
      for (const [v, u, w] of [[2.1, 2.6, 1.0], [-2.1, 2.6, 1.0], [2.3, -2.0, 1.6], [-2.3, -2.0, 1.6], [2.3, -3.9, 1.6], [-2.3, -3.9, 1.6]]) { const q = K.to(u, v); wheel(B, q.x, y + 1.45, q.z, 1.45, w, ry, '#26262a'); }
      fbox(B, C.coal, K, 0, 0, y + 1.5, 4.2, 1.0, 8.4); fbox(B, C.coal, K, 2.9, 0, y + 2.5, 4.6, .3, 2.8); fbox(B, C.yellow, K, 3.1, 1.0, y + 2.8, 2.3, 1.3, 2.0);
      fbox(B, C.yellow, K, 2.9, -1.3, y + 2.8, 2.0, 1.9, 2.0); fbox(B, C.glass, K, 3.9, -1.3, y + 3.5, 1.7, .9, .08); fbox(B, C.glass, K, 2.9, -2.31, y + 3.5, .08, .9, 1.6);
      fbox(B, C.yellow, K, -1.4, 0, y + 2.6, 4.8, 2.4, 5.6); fbox(B, C.yellow, K, 2.6, 0, y + 4.9, 4.8, .35, 2.6); fbox(B, C.yellow, K, 1.5, 0, y + 2.6, 4.8, 2.6, .35);
      fbox(B, C.ore, K, -1.4, 0, y + 5.0, 4.2, .9, 4.6); fbox(B, C.dark, K, 4.25, 0, y + 1.6, 4.4, .5, .3); fbox(B, '#fff6c8', K, 4.25, 1.5, y + 2.4, .5, .25, .1); fbox(B, '#fff6c8', K, 4.25, -1.5, y + 2.4, .5, .25, .1);
      for (let i = 0; i < 5; i++) fbox(B, C.dark, K, 3.1, 2.3, y + .4 + i * .5, .5, .06, .06);
      solidBox(p.x, p.z, ry, 5.0, 9.2, 'dumptruck'); }
    // conveyor from the rim to a stockpile, ore rocks that can be knocked about
    { const a = F.to(10, -1.5), b = F.to(7, 10), ya = G(a.x, a.z) + 3.4, yb = G(b.x, b.z) + 7.2;
      const dx = b.x - a.x, dz = b.z - a.z, L = hyp(dx, dz), px = dz / L, pz = -dx / L; // px,pz: across the belt
      beam(B, C.grey, a.x, ya, a.z, b.x, yb, b.z, 1.4, .5); beam(B, '#2f3237', a.x, ya + .35, a.z, b.x, yb + .35, b.z, 1.1, .1);
      for (const t of [.2, .5, .8]) { const x = a.x + dx * t, z = a.z + dz * t, yt = ya + (yb - ya) * t, yg = G(x, z);
        beam(B, C.steel, x + px * 1.2, yg - .2, z + pz * 1.2, x, yt - .3, z, .14, .14); beam(B, C.steel, x - px * 1.2, yg - .2, z - pz * 1.2, x, yt - .3, z, .14, .14); W.solid(x, z, 1.2, 'conveyor'); }
      beam(B, C.dark, b.x - px * .9, yb + .1, b.z - pz * .9, b.x + px * .9, yb + .1, b.z + pz * .9, 1.0, 1.0, true);
      const s = F.to(6.5, 13), ys = G(s.x, s.z); cone(B, C.ore, s.x, ys - .3, s.z, 4.6, 3.8, 11); W.solid(s.x, s.z, 4.0, 'stockpile');
      const mats = ['#8c7b6a', '#6f6a66', '#a08a6a'].map(h => W.mat(h, { flat: true }));
      const oreG = new T.DodecahedronGeometry(.7, 0); for (let i = 0; i < 8; i++) { const sc = .65 + W.rng() * .45, m = new T.Mesh(oreG, mats[i % 3]); m.scale.setScalar(sc); const q = F.to(3.5 + W.rng() * 2.5, 1.5 + W.rng() * 2.5); m.position.set(q.x, 0, q.z); /* the pocket clear of the conveyor legs */ m.rotation.set(W.rng() * 3, W.rng() * 3, 0); W.breakable(W.pushable(m, .6 * sc, .75 * sc, { tag: 'ore' }), { at: 9, colors: ['#8c7b6a', '#6f6a66', '#a08a6a'], n: 8, size: [.1, .3 * sc], kind: 'rock' }); BLD.meshes.push(m); } }
    // site office (an Open T blue container), workshop, floodlight mast, sign
    { const y = fG(F, -9, 9.5) + .05; fbox(B, C.blue, F, -9, 9.5, y, 2.6, 2.7, 6.2); fbox(B, C.white, F, -9, 9.5, y + 2.7, 2.8, .15, 6.4); fbox(WIN, null, F, -9, 8.17, y + 1.1, .08, 1.0, 1.4); fbox(WIN, null, F, -7.5, 8.17, y + 1.1, .08, 1.0, 1.4); fbox(B, C.dark, F, -11, 8.17, y, .1, 2.0, .9); fsolid(F, -9, 9.5, 2.8, 6.4, 'office'); }
    { const y = fG(F, -2, 14) + .05; fbox(B, C.grey, F, -2, 14, y, 4.5, 4.2, 9); fbox(B, C.roof, F, -2, 14, y + 4.2, 4.8, .3, 9.3); fbox(B, '#3a3d42', F, -2, 11.72, y, .1, 3.2, 3.4); fsolid(F, -2, 14, 4.7, 9.2, 'workshop'); }
    { const p = F.to(-5, 3), y = G(p.x, p.z); cylB(B, C.pole, p.x, y - .2, p.z, .1, .16, 9.2, 8); box(B, C.pole, p.x, y + 9, p.z, 1.8, .14, .14, F.ry); for (const k of [-.6, 0, .6]) box(LAMP, null, p.x + Math.cos(F.ry) * k, y + 8.75, p.z - Math.sin(F.ry) * k, .5, .3, .4, F.ry); W.solid(p.x, p.z, .5, 'mast'); light(p.x, y + 8.4, p.z, '#fff1c9', 34); }
    { const p = F.to(-10.5, -6.8); sign(atlas.slot('OPEN PIT MINE', 'уурхай · hard hats beyond this point', { bg: C.yellow, fg: '#18202b', sub: '#4a3d12', border: '#18202b' }), p.x, G(p.x, p.z) + 2.6, p.z, 5, F.ang(-1, 0), { bucket: B, posts: true }); }
    { const p = F.to(-8, 7); lamp(p.x, p.z, F.ang(0, -1)); }
    BLD.meshes.push(finish(B));
  }

  /* ---------- bus terminal: hall with a roof sign, canopy platform, three buses nose-in ---------- */
  function buildBus() {
    const B = new Bucket(VC, 'bus'), F = frame(62, -22, .9, -.43); // the ring road is 14 m along -u
    groundGrid(B, F, -14.5, 2, -12, 12, 2, C.asphalt, .03);
    { const u = 5.5, v = 0, y = fG(F, u, v) + .05;
      fbox(B, '#8d877c', F, u, v, y - .5, 14.2, .6, 6.2); fbox(B, '#eef0f2', F, u, v, y, 14, 5.4, 6); fbox(B, C.blue, F, u, v, y + 4.5, 14.3, .5, 6.3); fbox(B, C.roof, F, u, v, y + 5.4, 14.3, .3, 6.3);
      for (const dv of [-5, -2.5, 2.5, 5]) fbox(WIN, null, F, u - 3.05, v + dv, y + 1.1, 2.2, 2.8, .08);
      fbox(B, C.glass, F, u - 3.06, v, y, 2.2, 2.6, .08); fbox(B, '#9a9388', F, u + 1, v + 4, y + 5.7, 2, 1, 1.6);
      const p = F.to(u - 3.0, v); sign(atlas.slot('Mongol BUS terminal', 'автобусны буудал · tickets · 06:00–22:00', { bg: C.blue }), p.x, y + 6.9, p.z, 11, F.ang(-1, 0), { bucket: B, backColor: '#13348f' });
      for (const dv of [-5.2, 5.2]) fbox(B, C.pole, F, u - 3.1, v + dv, y + 5.7, .12, 2.2, .12);
      fsolid(F, u, v, 14.4, 6.4, 'terminal'); }
    { const u = .6, v = 0, y = fG(F, u, v) + .05;
      fbox(B, '#c9c3b8', F, u, v, y - .1, 14, .45, 2.2); fbox(B, C.yellow, F, u - 1.0, v, y + .35, 14, .02, .25);
      fbox(B, C.blue, F, u + .2, v, y + 3.6, 15, .2, 4.4); fbox(B, '#9a9388', F, u + .2, v, y + 3.8, 15.2, .1, 4.6);
      for (const [du, dv] of [[-.3, -6], [-.3, 6], [1.4, -6], [1.4, 6]]) fbox(B, C.pole, F, du, dv, y + .35, .14, 3.25, .14);
      for (const dv of [-4, 0, 4]) { fbox(B, C.wood, F, u + .4, v + dv, y + .8, 2.2, .1, .45); fbox(B, C.dark, F, u + .4, v + dv - .9, y + .35, .3, .45, .3); fbox(B, C.dark, F, u + .4, v + dv + .9, y + .35, .3, .45, .3); }
      fsolid(F, u, v, 14, 2.4, 'platform'); light(F.to(u - 1, 0).x, y + 3.3, F.to(u - 1, 0).z, '#ffe2a8', 24); }
    // three buses nose-in to the platform
    const buses = [[-5, C.blue], [0, C.yellow], [5, C.red]];
    for (const [dv, hex] of buses) {
      const c = F.to(-5.4, dv), y = G(c.x, c.z), a = F.ry + (W.rng() - .5) * .06, K = frame(c.x, c.z, Math.sin(a), Math.cos(a));
      fbox(B, hex, K, 0, 0, y + .6, 2.6, 2.5, 10); fbox(B, C.white, K, 0, 0, y + 3.1, 2.5, .22, 10); fbox(B, C.dark, K, 4.95, 0, y + .7, 2.6, .35, .25); fbox(B, C.dark, K, -4.95, 0, y + .7, 2.6, .35, .25);
      fbox(WIN, null, K, 0, 1.32, y + 1.9, .06, .9, 7.8); fbox(WIN, null, K, 0, -1.32, y + 1.9, .06, .9, 7.8); fbox(WIN, null, K, 5.02, 0, y + 1.9, 2.3, 1.1, .06);
      fbox(B, C.glass, K, 3.0, 1.32, y + .7, .06, 2.1, 1.1); fbox(B, '#fff6c8', K, 5.02, .9, y + 1.0, .4, .2, .06); fbox(B, '#fff6c8', K, 5.02, -.9, y + 1.0, .4, .2, .06);
      for (const [u, v] of [[3.3, 1.15], [3.3, -1.15], [-3.1, 1.15], [-3.1, -1.15]]) { const q = K.to(u, v); wheel(B, q.x, y + .55, q.z, .55, .35, K.ry); }
      fsolid(K, 0, 0, 2.8, 10.2, 'bus');
    }
    for (const dv of [-10, 10]) { const p = F.to(-9, dv); lamp(p.x, p.z, F.ang(0, -Math.sign(dv))); }
    { const p = F.to(-10.5, 8.5); sign(atlas.slot('BUS', 'терминал · buses only', { bg: C.blue }), p.x, G(p.x, p.z) + 2.6, p.z, 1.5, F.ang(-1, 0), { bucket: B, posts: true, solid: false }); }
    BLD.meshes.push(finish(B));
  }

  /* ---------- railway: ballast, instanced sleepers, rails, a station with platform, a goods yard, the freight train ---------- */
  function buildRail() {
    const B = new Bucket(VC, 'rail'), y0 = G(0, RAIL_Z), railTop = y0 + .53;
    box(B, '#8a857b', 0, y0 + .14, RAIL_Z, 234, .28, 3.8); for (const dz of [-.76, .76]) box(B, '#6c7076', 0, railTop - .09, RAIL_Z + dz, 234, .18, .12);
    for (const sx of [-1, 1]) { box(B, C.red, 112 * sx, y0 + 1.0, RAIL_Z, .6, 1.0, 2.0); box(B, C.white, 112 * sx, y0 + 1.0, RAIL_Z, .62, .2, 2.02); box(B, C.dark, 112.6 * sx, y0 + .9, RAIL_Z, .6, .6, 1.2); }
    box(B, C.wood, 0, y0 + .5, RAIL_Z, 3, .1, 2.6);
    const sleepers = []; for (let x = -116.5; x <= 116.5; x += .7) sleepers.push({ x, y: y0 + .36, z: RAIL_Z });
    const sm = new T.InstancedMesh(new T.BoxGeometry(2.5, .16, .28), W.mat('#5b4634'), sleepers.length);
    sleepers.forEach((s, i) => sm.setMatrixAt(i, M4(s.x, s.y, s.z))); sm.instanceMatrix.needsUpdate = true; sm.frustumCulled = false; sm.castShadow = sm.receiveShadow = true; sm.name = 'bld-sleepers'; W.scene.add(sm); BLD.meshes.push(sm);
    // the station building north of the track, platform along the track, canopy
    const F = frame(14, 87.3, 0, 1), y = G(14, 87.3) + .05;
    groundGrid(B, frame(10, 87, 1, 0), -12, 12, -3, 2.3, 2, C.asphalt, .03);
    fbox(B, '#8d877c', F, 0, 0, y - .5, 10.2, .6, 5.2); fbox(B, C.sand, F, 0, 0, y, 10, 4.2, 5); fbox(B, C.white, F, 0, 0, y + 3.9, 10.3, .3, 5.3);
    fbox(B, '#6e8a6a', F, 0, 0, y + 4.2, 10.8, .5, 5.8); fbox(B, '#6e8a6a', F, 0, 0, y + 4.7, 8.6, .5, 4.4); fbox(B, '#5c7558', F, 0, 0, y + 5.2, 5.4, .4, 2.6); fcyl(B, '#9a9388', F, -1.5, 2.5, y + 5.4, .3, .3, 1.2, 8);
    for (const dv of [-3.5, -1.2, 1.2, 3.5]) fbox(WIN, null, F, 2.55, dv, y + 1.1, 1.2, 1.6, .08); for (const dv of [-3.5, 3.5]) fbox(WIN, null, F, -2.55, dv, y + 1.1, 1.2, 1.6, .08);
    fbox(B, '#2f3237', F, 2.55, 0, y, 1.3, 2.3, .1); fbox(B, '#2f3237', F, -2.55, 0, y, 1.3, 2.3, .1);
    { const p = F.to(2.62, 0); sign(atlas.slot('KHUSLEN STATION', 'Хүслэн өртөө · km 404', { bg: '#1d4b3a' }), p.x, y + 3.3, p.z, 6.5, 0, { bucket: B, backColor: '#13352a' }); }
    { const p = F.to(-2.62, 0); sign(atlas.slot('RAIL STATION', 'галт тэрэгний буудал · freight & passengers', { bg: '#1d4b3a' }), p.x, y + 3.3, p.z, 7, PI, { bucket: B, backColor: '#13352a' }); }
    fsolid(F, 0, 0, 10.4, 5.4, 'station');
    box(B, '#c9c3b8', 8, y0 + .2, 91.05, 28, .5, 2.5); box(B, C.yellow, 8, y0 + .46, 92.15, 28, .02, .2);
    box(B, '#6e8a6a', 10, y0 + 4.5, 91.2, 18, .18, 2.6); box(B, '#5c7558', 10, y0 + 4.62, 91.2, 18.3, .1, 2.8);
    for (const x of [2, 10, 18]) box(B, C.pole, x, y0 + 2.5, 92.0, .14, 4.1, .14);
    for (const x of [-2, 4]) { box(B, C.wood, x, y0 + .95, 90.6, 2.2, .1, .45); box(B, C.dark, x - .9, y0 + .67, 90.6, .3, .45, .3); box(B, C.dark, x + .9, y0 + .67, 90.6, .3, .45, .3); }
    box(B, C.white, 20.5, y0 + 3.0, 91.0, .8, .8, .1); box(B, C.pole, 20.5, y0 + 2.2, 91.0, .08, 1.3, .08);
    solidBox(8, 91.05, 0, 28, 2.5, 'platform');
    for (const x of [-4, 8, 21]) lamp(x, 89.9, 0, 5.5); light(10, y0 + 4.6, 91.3, '#ffe2a8', 26);
    // goods yard south of the track: shed, water tower, containers, a signal
    { const K = frame(-4, 101, 1, 0), ys = G(-4, 101) + .05; fbox(B, C.grey, K, 0, 0, ys, 6, 4.5, 12); fbox(B, C.roof, K, 0, 0, ys + 4.5, 6.4, .3, 12.4); fbox(B, '#3a3d42', K, -2, 3.04, ys + .8, .1, 2.8, 3.6); fbox(B, '#c9c3b8', K, 0, 3.8, ys, 1.6, .8, 10); fsolid(K, 0, .4, 7.2, 12.4, 'shed');
      const p = K.to(-2, 3.05); sign(atlas.slot('FREIGHT', 'ачаа тээш · goods shed', { bg: '#f6f4ee', fg: '#18202b', sub: '#5a6573', border: '#18202b' }), p.x, ys + 3.5, p.z, 3.2, PI, { bucket: B }); }
    { const x = 20, z = 101.5, yt = G(x, z); for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) beam(B, C.steel, x + a * 1.6, yt - .2, z + b * 1.6, x + a * 1.0, yt + 6, z + b * 1.0, .16, .16);
      box(B, C.steel, x, yt + 3, z, 2.4, .12, .12); box(B, C.steel, x, yt + 3, z, .12, .12, 2.4); cylB(B, C.rust, x, yt + 6, z, 1.8, 1.8, 3, 14); cone(B, '#5c3a2a', x, yt + 9, z, 1.95, .9, 14); W.solid(x, z, 2.2, 'watertower'); }
    { const yc = G(-14, 100.5) + .05; box(B, C.blue, -14, yc + 1.3, 100.5, 6.1, 2.6, 2.5, .1); box(B, C.yellow, -14.3, yc + 3.9, 100.8, 6.1, 2.6, 2.5, .1); solidBox(-14, 100.5, .1, 6.2, 2.6, 'container'); }
    { const x = -12, z = 96.5, ysg = G(x, z); cylB(B, C.pole, x, ysg, z, .08, .1, 3.6, 6); box(B, C.dark, x, ysg + 3.4, z, .4, .9, .25); box(BEACON, null, x, ysg + 3.6, z, .2, .2, .3); W.solid(x, z, .3, 'signal'); }
    BLD.meshes.push(finish(B));
    // the train: one merged mesh moving along x, cars are moving solids
    const TB = new Bucket(VC, 'train'), st = BLD.train;
    const carSolid = (cx, n) => { for (let i = 0; i < n; i++) { const off = cx + (n === 1 ? 0 : -2.6 + 5.2 * i / (n - 1)); st.cars.push({ off, s: W.solid(off, RAIL_Z, 1.7, 'train') }); } };
    const bogies = (cx) => { for (const bx of [cx - 3.4, cx + 3.4]) { box(TB, C.dark, bx, .55, 0, 2.8, .5, 2.4); for (const wx of [bx - .9, bx + .9]) for (const wz of [-.76, .76]) TB.add(wheelGeo(.5, .2, 10), M4(wx, .5, wz), '#2f3237'); } box(TB, C.dark, cx, 1.0, 0, 10.4, .16, 2.6); };
    // loco at the +x end (centre 33), six wagons behind it
    { const cx = 33; for (const bx of [cx - 4.4, cx + 4.4]) { box(TB, C.dark, bx, .55, 0, 3.6, .5, 2.4); for (const wx of [bx - 1.2, bx, bx + 1.2]) for (const wz of [-.76, .76]) TB.add(wheelGeo(.5, .2, 10), M4(wx, .5, wz), '#2f3237'); }
      box(TB, C.dark, cx, 1.0, 0, 14, .3, 3.0); box(TB, '#2a4d9b', cx, 2.4, 0, 13.2, 2.5, 2.9); box(TB, C.yellow, cx, 2.0, 0, 13.3, .35, 2.95); box(TB, '#9aa0a8', cx, 3.75, 0, 12.8, .25, 2.7);
      for (const sx of [-1, 1]) { box(TB, C.glass, cx + sx * 6.5, 2.95, 0, .3, .8, 2.4); box(TB, C.glass, cx + sx * 5.6, 2.95, 1.46, 1.6, .8, .06); box(TB, C.glass, cx + sx * 5.6, 2.95, -1.46, 1.6, .8, .06); box(TB, '#fff6c8', cx + sx * 6.7, 3.6, 0, .2, .3, .5); box(TB, C.red, cx + sx * 7.0, 1.2, 0, .3, .5, 2.6); }
      for (const ex of [-2, 1.5]) cyl(TB, '#4a4d52', cx + ex, 4.05, .5, .22, .22, .4, 8); box(TB, '#4a4d52', cx - .5, 4.0, -.6, 5, .3, 1.0); carSolid(cx, 3); }
    const wagons = ['hopper', 'tank', 'hopper', 'flat', 'tank', 'hopper'];
    wagons.forEach((kind, j) => {
      const cx = 20 - 11 * j; bogies(cx); box(TB, C.dark, cx - 5.4, 1.0, 0, .5, .25, .5); box(TB, C.dark, cx + 5.4, 1.0, 0, .5, .25, .5);
      if (kind === 'hopper') { const hex = j === 2 ? '#6e3b2a' : '#4a4d52'; box(TB, hex, cx, 2.25, 0, 10, 2.3, 2.9); for (const rx of [-3.5, -1.2, 1.2, 3.5]) for (const rz of [-1.5, 1.5]) box(TB, j === 2 ? '#8a4a36' : '#5a5e66', cx + rx, 2.25, rz, .18, 2.3, .12); box(TB, C.coal, cx, 3.5, 0, 9.4, .5, 2.5); box(TB, C.coal, cx - 2, 3.95, .2, 3, .5, 1.6); box(TB, C.coal, cx + 2.4, 3.9, -.3, 2.6, .5, 1.4); }
      else if (kind === 'tank') { box(TB, C.dark, cx, 1.25, 0, 10, .3, 2.6); TB.add(cylGeo(1.3, 1.3, 9.4, 14).rotateZ(PI / 2), M4(cx, 2.65, 0), j === 4 ? '#b5b9bd' : '#8f949a'); cyl(TB, '#6c7076', cx, 3.95, 0, .5, .5, .5, 10); for (const sx of [-4.9, 4.9]) TB.add(cylGeo(1.32, 1.32, .16, 14).rotateZ(PI / 2), M4(cx + sx, 2.65, 0), '#4a4d52'); }
      else { box(TB, C.dark, cx, 1.25, 0, 10, .4, 2.8); box(TB, C.blue, cx - 2.45, 2.65, 0, 4.7, 2.4, 2.5); box(TB, C.yellow, cx + 2.45, 2.65, 0, 4.7, 2.4, 2.5); }
      carSolid(cx, 2);
    });
    const train = TB.build(); train.position.set(st.x, railTop, RAIL_Z); train.name = 'bld-train'; W.scene.add(train); BLD.meshes.push(train); BLD.trainMesh = train;
    for (const c of st.cars) { c.s.x = st.x + c.off; }
  }

  /* ---------- wind farm: five turbines with spinning rotors, a small substation, a sign ---------- */
  function buildWind() {
    const B = new Bucket(VC, 'wind'), RB = new Bucket(W.M.white, 'rotor');
    cyl(RB, null, 0, 0, 0, .55, .55, 1.5, 10, 0, PI / 2); RB.add(new T.ConeGeometry(.55, 1.0, 10).rotateX(PI / 2), M4(0, 0, 1.2), null);
    for (let k = 0; k < 3; k++) { const a = k * PI * 2 / 3, dx = -Math.sin(a), dy = Math.cos(a); RB.add(cylGeo(.1, .42, 8.5, 5), M4(dx * 4.6, dy * 4.6, 0, 0, 1, 1, 1, 0, a), null); }
    const rotorGeo = RB.build().geometry;
    // turbines north and east of the dirt track, off the chase camera's (16, 22) sightline band so a tower never hides the truck
    const spots = [[-62, 90], [-46, 86], [-34, 68], [-42, 102], [-20, 76]];
    const rm = new T.InstancedMesh(rotorGeo, W.M.white, spots.length); rm.frustumCulled = false; rm.castShadow = true; rm.name = 'bld-rotors'; W.scene.add(rm); BLD.meshes.push(rm); BLD.rotorMesh = rm;
    spots.forEach(([x, z], i) => {
      const y = G(x, z), yaw = .75 + (W.rng() - .5) * .25, H = 17;
      cylB(B, '#b6ad9c', x, y - .3, z, 2.2, 2.4, .5, 16); cylB(B, '#eef1f4', x, y, z, .42, .85, H, 12);
      box(B, '#eef1f4', x + Math.sin(yaw) * .2, y + H + .8, z + Math.cos(yaw) * .2, 1.6, 1.6, 4.2, yaw); box(B, '#8a8f96', x - Math.sin(yaw) * 1.7, y + H + .8, z - Math.cos(yaw) * 1.7, 1.3, 1.3, 1.0, yaw);
      box(B, '#2f3237', x + Math.sin(yaw + PI / 2) * .87, y + 1.0, z + Math.cos(yaw + PI / 2) * .87, .06, 1.9, .8, yaw);
      box(B, '#5f666e', x + Math.sin(yaw - PI / 2) * 3.4, y + .7, z + Math.cos(yaw - PI / 2) * 3.4, 1.2, 1.4, 1.0, yaw);
      W.solid(x, z, 1.6, 'turbine'); W.solid(x + Math.sin(yaw - PI / 2) * 3.4, z + Math.cos(yaw - PI / 2) * 3.4, .9, 'kiosk');
      BLD.turbines.push({ x, z, hubY: y + H + .8, yaw, angle: W.rng() * 6.28, speed: 1.1 + W.rng() * .4 });
    });
    // substation at the end of the dirt track
    { const F = frame(-67, 80, 1, 0), y = G(-67, 80) + .05;
      fence(B, rect(F, -4, 4, -4, 4), true, { gap: 2.0, solid: false }); W.solid(-67, 80, 4.2, 'substation');
      for (const [u, v] of [[-1.6, -1.2], [1.6, -1.2]]) { fbox(B, '#5f666e', F, u, v, y, 1.8, 2.2, 1.4); for (const k of [-.5, 0, .5]) fcyl(B, '#d9d2c8', F, u + k, v, y + 2.2, .08, .08, .7, 6); }
      fbox(B, C.cream, F, 0, 2.2, y, 3, 2.5, 2); fbox(B, C.roof, F, 0, 2.2, y + 2.5, 3.3, .2, 2.3); fbox(B, '#2f3237', F, 0, 1.19, y, .1, 1.9, .8);
      sign(atlas.slot('WIND FARM', 'салхин парк · 5 × 2 MW', { bg: '#f6f4ee', fg: '#18202b', sub: '#5a6573', border: '#18202b' }), -61.5, G(-61.5, 76.5) + 2.5, 76.5, 4.6, -2.55, { bucket: B, posts: true }); }
    BLD.meshes.push(finish(B));
  }

  /* ---------- odds and ends: telecom mast, Open T billboard, extra gers ---------- */
  function buildMisc() {
    const B = MISC;
    // GPS / telecom mast on the rise east of the ring
    { const x = 72, z = -52, y = G(x, z), H = 24;
      for (let k = 0; k < 3; k++) { const r0 = 1.2 - k * .32, r1 = 1.2 - (k + 1) * .32; B.add(cylGeo(r1, r0, H / 3, 4), M4(x, y + H / 6 + k * H / 3, z, PI / 4), k % 2 ? '#f4f7fa' : C.red); }
      box(B, C.steel, x, y + H + .4, z, .25, 1.0, .25); box(BEACON, null, x, y + H + 1.1, z, .4, .4, .4);
      for (let k = 0; k < 3; k++) { const a = k * PI * 2 / 3; box(B, C.white, x + Math.sin(a) * .45, y + H - 1.2, z + Math.cos(a) * .45, .3, 1.8, .12, a); }
      for (const [a, h] of [[.4, 12], [2.6, 15.5]]) B.add(cylGeo(.75, .75, .18, 12).rotateX(PI / 2), M4(x + Math.sin(a) * .95, y + h, z + Math.cos(a) * .95, a, 1, 1, 1, .25), '#dfe3e8');
      for (let k = 0; k < 3; k++) { const a = PI / 2 + k * PI * 2 / 3, ax = x + Math.sin(a) * 12, az = z + Math.cos(a) * 12, ay = G(ax, az); beam(B, '#2b2e33', x, y + H - 2, z, ax, ay + .4, az, .05, .05); box(B, C.concrete, ax, ay + .2, az, .8, .5, .8); W.solid(ax, az, .5, 'anchor'); }
      W.solid(x, z, 1.7, 'mast');
      boxB(B, C.concrete, x + 4.5, G(x + 4.5, z + 1) - .3, z + 1, 3, 2.7, 2.4, .2); boxB(B, C.roof, x + 4.5, G(x + 4.5, z + 1) + 2.4, z + 1, 3.2, .2, 2.6, .2); boxB(B, C.grey, x + 6.2, G(x + 6.2, z + 1.5), z + 1.5, .6, .6, .6, .2); solidBox(x + 4.5, z + 1, .2, 3.2, 2.6, 'hut');
      fence(B, [{ x: x - 6, z: z - 6 }, { x: x + 8, z: z - 6 }, { x: x + 8, z: z + 6 }, { x: x - 6, z: z + 6 }], true, { gap: 2.2, solid: false });
      W.solid(x - 6, z, 1.2, 'fence'); W.solid(x + 8, z, 1.2, 'fence'); W.solid(x + 1, z - 6, 1.2, 'fence'); W.solid(x + 1, z + 6, 1.2, 'fence');
      sign(atlas.slot('GPS RELAY', 'Open T tracking · fuel & tracker alerts', { bg: '#18202b', fg: C.yellow, sub: 'rgba(255,255,255,.7)', border: C.yellow }), x - 1, G(x - 1, z + 6.4) + 2.4, z + 6.4, 4.2, 0, { posts: true, solid: false }); }
    // Open T billboard outside the north bend of the ring: two faces, one toward the plaza, one toward the bridge road
    { const x = 16, z = -49, ry = -.28, y = G(x, z), px = Math.cos(ry), pz = -Math.sin(ry);
      const tex = new T.TextureLoader().load('img/opent-illustration.webp'); tex.anisotropy = 4;
      const imgMat = new T.MeshBasicMaterial({ map: tex }), slot = atlas.slot('OPEN T', 'fleet platform · tracking · fuel · dispatch', { bg: C.yellow, fg: '#18202b', sub: '#4a3d12', border: '#18202b' });
      box(B, '#2b2e33', x, y + 6.4, z, 8.4, 8.6, .16, ry);
      for (const f of [0, PI]) { const a = ry + f, nx = Math.sin(a), nz = Math.cos(a);
        const img = new T.Mesh(new T.PlaneGeometry(8, 6), imgMat); img.position.set(x + nx * .1, y + 7.4, z + nz * .1); img.rotation.y = a; img.name = 'bld-billboard'; W.scene.add(img); BLD.meshes.push(img);
        sign(slot, x + nx * .1, y + 3.2, z + nz * .1, 8, a, { back: false });
        for (const s of [-2.6, 0, 2.6]) { box(B, C.pole, x + px * s + nx * .5, y + 10.9, z + pz * s + nz * .5, .08, .08, 1.0, a); box(LAMP, null, x + px * s + nx * 1.0, y + 10.85, z + pz * s + nz * 1.0, .4, .22, .3, a); } }
      for (const s of [-1, 1]) { const qx = x + px * 3 * s, qz = z + pz * 3 * s; cylB(B, C.yellow, qx, G(qx, qz) - .3, qz, .16, .2, y + 2.4 - G(qx, qz), 8); W.solid(qx, qz, .5, 'billboard'); } }
    // extra gers by the lake and on the hills, each with a wood pile and a hitching post
    for (const [x, z, s, r] of [[-70, 58, 1, .3], [-76, 66, .9, -.5], [40, 72, 1.1, 2.6], [-34, -98, 1, 1.2]]) {
      ger(B, x, z, s, r);
      const wx = x + Math.sin(r + 2.2) * 4.2, wz = z + Math.cos(r + 2.2) * 4.2, wy = G(wx, wz); box(B, C.wood, wx, wy + .35, wz, 1.6, .7, 1.0, r); box(B, '#6b4a2d', wx, wy + .85, wz, 1.2, .3, .8, r);
      const hx = x + Math.sin(r - 1.4) * 4.5, hz = z + Math.cos(r - 1.4) * 4.5, hy = G(hx, hz); box(B, C.wood, hx, hy + .6, hz, .12, 1.2, .12); box(B, C.wood, hx, hy + 1.1, hz, 2.0, .08, .08, r);
    }
  }

  /* ---------------- build order and finishing ---------------- */
  function finish(B) { const m = B.build(); if (m) W.scene.add(m); return m; }

  W.onReady(() => {
    W.reseed(772031);
    SIGNS = new Bucket(new T.MeshBasicMaterial({ map: atlas.tex }), 'signs'); WIN = new Bucket(W.M.window, 'windows'); LAMP = new Bucket(W.M.lamp, 'lamps');
    BEACON = new Bucket(beaconMat, 'beacons'); MISC = new Bucket(VC, 'misc');
    FAC = [facadeMat('#cfc7b9', '#bcd3e6', .55), facadeMat('#dbc3ad', '#c9dceb', .5), facadeMat('#b9c0c8', '#dfe9f5', .6)].map((m, i) => new Bucket(m, 'facade' + i));
    for (const [name, fn] of [['town', buildTown], ['plant', buildPlant], ['mine', buildMine], ['bus', buildBus], ['rail', buildRail], ['wind', buildWind], ['misc', buildMisc]]) {
      try { fn(); } catch (e) { console.error('buildings: ' + name + ' failed', e); }
    }
    try {
      for (const Bk of [MISC, ...FAC, SIGNS, WIN, LAMP, BEACON]) { const m = Bk.build(Bk !== SIGNS); if (m) { W.scene.add(m); BLD.meshes.push(m); } }
      try { if (document.fonts && document.fonts.load && !(document.fonts.check('800 120px Archivo') && document.fonts.check('500 46px "IBM Plex Mono"'))) Promise.all([document.fonts.load('500 46px "IBM Plex Mono"', 'Хүслэн өртөө'), document.fonts.load('800 120px Archivo', 'KHUSLEN')]).then(() => atlas.redraw()).catch(() => { }); } catch (e) { }
    } catch (e) { console.error('buildings: finish failed', e); }
    try {
      if (lampPosts.length) {
        const PB = new Bucket(W.mat(C.pole), 'pole'); cyl(PB, null, 0, 3, 0, .07, .11, 6, 8); box(PB, null, 0, 5.92, .62, .1, .1, 1.3); box(PB, null, 0, 5.55, .25, .07, .55, .07, 0, .55);
        const pg = PB.build().geometry, pm = new T.InstancedMesh(pg, W.mat(C.pole), lampPosts.length);
        lampPosts.forEach((p, i) => pm.setMatrixAt(i, M4(p.x, p.y, p.z, p.ry, 1, p.h / 6, 1))); pm.instanceMatrix.needsUpdate = true; pm.frustumCulled = false; pm.castShadow = true; pm.name = 'bld-poles'; W.scene.add(pm); BLD.meshes.push(pm);
      }
      if (fencePosts.length) {
        const fm = new T.InstancedMesh(new T.BoxGeometry(.12, 1.75, .12), W.mat(C.grey), fencePosts.length);
        fencePosts.forEach((p, i) => fm.setMatrixAt(i, M4(p.x, p.y + .8, p.z))); fm.instanceMatrix.needsUpdate = true; fm.frustumCulled = false; fm.castShadow = true; fm.name = 'bld-fenceposts'; W.scene.add(fm); BLD.meshes.push(fm);
      }
      if (smoke.items.length) {
        const mat = new T.MeshStandardMaterial({ color: '#dde2e8', transparent: true, opacity: .5, depthWrite: false, roughness: 1 });
        smoke.mesh = new T.InstancedMesh(new T.SphereGeometry(1, 7, 5), mat, smoke.items.length); smoke.mesh.frustumCulled = false; smoke.mesh.name = 'bld-smoke'; W.scene.add(smoke.mesh); BLD.meshes.push(smoke.mesh);
      }
    } catch (e) { console.error('buildings: instancing failed', e); }
    BLD.lights = lights;
    W.onNight(on => { for (const l of lights) { l.intensity = on ? 1.5 : 0; l.visible = !!on; } });
    BLD.ready = true;
  });

  /* ---------------- per frame: the train shuttles, rotors spin, smoke rises, beacons blink ---------------- */
  const _m = new T.Matrix4();
  W.onUpdate((dt, now) => {
    const st = BLD.train, half = TRAIN_LEN / 2, lim = RAIL_X1 - half;
    if (BLD.trainMesh) {
      if (st.wait > 0) st.wait -= dt;
      else {
        st.x += st.dir * st.speed * dt;
        if (st.x >= lim) { st.x = lim; st.dir = -1; st.wait = 2.2; W.sfx('train', { x: st.x + half, z: RAIL_Z }); }
        else if (st.x <= -lim) { st.x = -lim; st.dir = 1; st.wait = 2.2; W.sfx('train', { x: st.x - half, z: RAIL_Z }); }
      }
      BLD.trainMesh.position.x = st.x; for (const c of st.cars) c.s.x = st.x + c.off;
    }
    if (BLD.rotorMesh) {
      BLD.turbines.forEach((t, i) => { t.angle += dt * t.speed; _e.set(0, t.yaw, t.angle, 'YXZ'); _q.setFromEuler(_e); _p.set(t.x + Math.sin(t.yaw) * 2.6, t.hubY, t.z + Math.cos(t.yaw) * 2.6); _s.set(1, 1, 1); _m.compose(_p, _q, _s); BLD.rotorMesh.setMatrixAt(i, _m); });
      BLD.rotorMesh.instanceMatrix.needsUpdate = true;
    }
    if (smoke.mesh) {
      const wx = 1.1, wz = .35;
      smoke.items.forEach((p, i) => {
        p.t += dt / p.life; if (p.t > 1) { p.t -= 1; p.jx = (W.rng() - .5) * .9; p.jz = (W.rng() - .5) * .9; }
        const k = p.t, rise = k * p.life * 1.25, drift = k * p.life * .55, sc = p.s * (.7 + 3.4 * k) * Math.min(1, (1 - k) * 4.5);
        _p.set(p.x + p.jx + wx * drift + Math.sin(now / 900 + p.w) * .6 * k, p.y + rise, p.z + p.jz + wz * drift + Math.cos(now / 1100 + p.w) * .5 * k);
        _q.identity(); _s.set(sc, sc * .8, sc); _m.compose(_p, _q, _s); smoke.mesh.setMatrixAt(i, _m);
      });
      smoke.mesh.instanceMatrix.needsUpdate = true;
    }
    beaconMat.emissiveIntensity = (now % 1400) < 200 ? 2.4 : 0;
  });
})();
