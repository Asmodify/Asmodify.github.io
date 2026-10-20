/* roads.js — the road network: ring road, three asphalt spurs, dirt tracks, the river
   bridge (a drivable surface with railings), junction signs, guard rails and the
   start/finish gantry. Exposes W.roads = { distance, nearest, polylines, loop, junctions,
   bridge, gantry, guardRuns, rebuild }. Everything goes through W; see CONTRACT.md. */
(() => {
  const W = window.W, T = W.T;

  /* ---------------- plan (metres; x east, z south) ---------------- */
  const RING = [[0, -44], [38, -32], [56, 8], [42, 46], [2, 56], [-40, 46], [-58, 6], [-40, -34]];
  const RIVER = [[-130, -58], [-70, -64], [-20, -74], [30, -78], [80, -70], [130, -82]];
  const ASPHALT_HW = 3.5, DIRT_HW = 2.0, STEP = 2;
  const Y_RING = .07, Y_SPUR = .06, Y_DIRT = .05;   // ≈ 0.06 above the ground; the ring wins at junctions
  const COL = { asphalt: '#3d4046', edge: '#a9adb2', dash: '#efe3b0', dirt: '#cbbd94', rail: '#d4d8dc' };

  /* ---------------- public object (safe before ready: empty network) ---------------- */
  const R = W.roads = {
    polylines: [], loop: [], junctions: [], guardRuns: [], bridge: null, gantry: null, ready: false,
    distance: () => 1e9,
    nearest: () => null,
    rebuild: () => build(true)
  };

  /* ---------------- helpers ---------------- */
  const hyp = Math.hypot;
  const unit = (x, z) => { const l = hyp(x, z) || 1; return { x: x / l, z: z / l }; };
  const riverZ = x => { // z of the river centreline at x
    for (let i = 0; i < RIVER.length - 1; i++) { const a = RIVER[i], b = RIVER[i + 1]; if (x >= a[0] && x <= b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
    return x < RIVER[0][0] ? RIVER[0][1] : RIVER[RIVER.length - 1][1];
  };
  const num = (v, d = 0) => typeof v === 'number' && v === v ? v : d;
  const th = (x, z) => num(W.terrain.height(x, z));

  // Catmull-Rom through control points, sampled every STEP metres by arc length.
  function spline(pts, closed) {
    const v = pts.map(p => new T.Vector3(p[0], 0, p[1]));
    const c = new T.CatmullRomCurve3(v, closed, 'centripetal');
    c.arcLengthDivisions = Math.max(240, v.length * 80);
    const L = c.getLength(), n = Math.max(2, Math.round(L / STEP));
    const sp = c.getSpacedPoints(n); if (closed) sp.pop();
    return { pts: sp.map(p => ({ x: p.x, z: p.z })), length: L };
  }
  function straight(a, b) {
    const L = hyp(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / STEP)), pts = [];
    for (let i = 0; i <= n; i++) pts.push({ x: a[0] + (b[0] - a[0]) * i / n, z: a[1] + (b[1] - a[1]) * i / n });
    return { pts, length: L };
  }
  function tangents(pts, closed) { // unit tangents per sample
    const n = pts.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      out[i] = unit(b.x - a.x, b.z - a.z);
    }
    return out;
  }

  /* ---------------- distance field: segments + coarse grid ---------------- */
  const SEG = { ax: [], az: [], dx: [], dz: [], l2: [], count: 0 };
  const GRID = { cell: 8, half: 128, n: 32, cells: null };
  const REACH = 24;
  function segDist(i, x, z) {
    const ax = SEG.ax[i], az = SEG.az[i], dx = SEG.dx[i], dz = SEG.dz[i];
    let t = SEG.l2[i] > 0 ? ((x - ax) * dx + (z - az) * dz) / SEG.l2[i] : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    return hyp(x - ax - dx * t, z - az - dz * t);
  }
  function buildDistanceField(polylines) {
    SEG.ax = []; SEG.az = []; SEG.dx = []; SEG.dz = []; SEG.l2 = [];
    for (const pl of polylines) {
      const p = pl.points, n = p.length, m = pl.closed ? n : n - 1;
      for (let i = 0; i < m; i++) { const a = p[i], b = p[(i + 1) % n]; SEG.ax.push(a.x); SEG.az.push(a.z); SEG.dx.push(b.x - a.x); SEG.dz.push(b.z - a.z); SEG.l2.push((b.x - a.x) ** 2 + (b.z - a.z) ** 2); }
    }
    SEG.count = SEG.ax.length;
    // Each cell lists every segment within REACH of it, so a result inside REACH is exact;
    // only queries far from every road fall back to the brute-force scan.
    const N = GRID.n, cs = GRID.cell, cells = GRID.cells = new Array(N * N);
    for (let cz = 0; cz < N; cz++) for (let cx = 0; cx < N; cx++) {
      const mx = -GRID.half + cx * cs + cs / 2, mz = -GRID.half + cz * cs + cs / 2, lim = REACH + cs * .71, list = [];
      for (let i = 0; i < SEG.count; i++) if (segDist(i, mx, mz) < lim) list.push(i);
      cells[cz * N + cx] = list.length ? Int32Array.from(list) : null;
    }
  }
  function distance(x, z) {
    if (!SEG.count || x !== x || z !== z) return 1e9;
    const cx = Math.floor((x + GRID.half) / GRID.cell), cz = Math.floor((z + GRID.half) / GRID.cell);
    let best = 1e9;
    if (cx >= 0 && cz >= 0 && cx < GRID.n && cz < GRID.n) {
      const list = GRID.cells[cz * GRID.n + cx];
      if (list) { for (let k = 0; k < list.length; k++) { const d = segDist(list[k], x, z); if (d < best) best = d; } if (best <= REACH) return best; }
    }
    for (let i = 0; i < SEG.count; i++) { const d = segDist(i, x, z); if (d < best) best = d; }
    return best;
  }
  // Nearest point on the ring: {x, z, t (0..1 clockwise from (0,-44)), i (loop segment), d (metres away)}.
  function nearest(x, z) {
    const L = R.loop, n = L.length; if (!n) return null;
    let best = 1e9, bi = 0, bt = 0;
    for (let i = 0; i < n; i++) {
      const a = L[i], b = L[(i + 1) % n], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = hyp(x - a.x - dx * t, z - a.z - dz * t); if (d < best) { best = d; bi = i; bt = t; }
    }
    const a = L[bi], b = L[(bi + 1) % n];
    return { x: a.x + (b.x - a.x) * bt, z: a.z + (b.z - a.z) * bt, t: ((bi + bt) / n) % 1, i: bi, d: best };
  }

  /* ---------------- geometry sinks ---------------- */
  // Ribbon vertex height: the drivable ground, lifted a little where the terrain is concave so
  // the 2 m-tessellated terrain mesh cannot poke through between samples.
  function ribbonY(x, z) {
    const g = W.groundY(x, z), h = 1.5;
    const lift = (W.groundY(x + h, z) + W.groundY(x - h, z) + W.groundY(x, z + h) + W.groundY(x, z - h)) * .25 - g;
    return g + (lift > 0 ? Math.min(.5, lift * .6) : 0);
  }
  // Non-indexed coloured quads → one BufferGeometry (position, normal, color).
  function Sink() { this.pos = []; this.nor = []; this.col = []; this.quads = 0; }
  Sink.prototype.quad = function (A, B, C, D, c) {
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z, vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { const t = B; B = D; D = t; nx = -nx; ny = -ny; nz = -nz; }
    const l = hyp(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const P of [A, B, C, A, C, D]) { this.pos.push(P.x, P.y, P.z); this.nor.push(nx, ny, nz); this.col.push(c.r, c.g, c.b); }
    this.quads++;
  };
  Sink.prototype.geometry = function () {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere(); return g;
  };
  const rgb = hex => new T.Color(hex);

  // One road ribbon. strips: [{a, b, color | color(i), target}] with across offsets (left +, right −).
  // dip: {x, z} junction point; the ribbon sinks under the ring within 6.5 m of it (no z-fighting).
  function ribbon(pts, closed, yOff, strips, sinkOf, dip) {
    const n = pts.length, tan = tangents(pts, closed), m = closed ? n : n - 1;
    const offs = []; for (const s of strips) { if (!offs.includes(s.a)) offs.push(s.a); if (!offs.includes(s.b)) offs.push(s.b); }
    const rows = pts.map((p, i) => {
      const nx = tan[i].z, nz = -tan[i].x, row = {};
      for (const o of offs) { const x = p.x + nx * o, z = p.z + nz * o; let y = ribbonY(x, z) + yOff; if (dip) y -= .12 * (1 - W.smoothstep(0, 6.5, hyp(x - dip.x, z - dip.z))); row[o] = { x, y, z }; }
      return row;
    });
    for (let i = 0; i < m; i++) {
      const r0 = rows[i], r1 = rows[(i + 1) % n];
      for (const s of strips) { const c = typeof s.color === 'function' ? s.color(i) : s.color; if (c) sinkOf(s.target).quad(r0[s.a], r0[s.b], r1[s.b], r1[s.a], c); }
    }
    return rows;
  }

  // Instanced unit boxes with per-instance colour: many props in one draw call.
  function Boxes() { this.items = []; }
  Boxes.prototype.add = function (w, h, d, color, x, y, z, ry = 0, rx = 0) { this.items.push({ w, h, d, color, x, y, z, ry, rx }); };
  Boxes.prototype.mesh = function (geo) {
    const m = new T.InstancedMesh(geo || new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ roughness: .85 }), this.items.length);
    const mtx = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(0, 0, 0, 'YXZ'), sc = new T.Vector3(), ps = new T.Vector3(), col = new T.Color();
    this.items.forEach((b, i) => { e.set(b.rx, b.ry, 0, 'YXZ'); q.setFromEuler(e); sc.set(b.w, b.h, b.d); ps.set(b.x, b.y, b.z); mtx.compose(ps, q, sc); m.setMatrixAt(i, mtx); m.setColorAt(i, col.set(b.color)); });
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.castShadow = m.receiveShadow = true; return m;
  };

  /* ---------------- textures ---------------- */
  const SW = 512, SH = 192; // one sign slot in the atlas
  function drawSign(x, ox, oy, title, sub, { bg = '#1f4fd1', fg = '#ffffff', subColor = '#cfd9ff', arrow = null, border = 'rgba(255,255,255,.9)' } = {}) {
    x.save(); x.translate(ox, oy); x.beginPath(); x.rect(0, 0, SW, SH); x.clip();
    x.fillStyle = bg; x.fillRect(0, 0, SW, SH);
    if (border) { x.strokeStyle = border; x.lineWidth = 6; x.strokeRect(11, 11, SW - 22, SH - 22); }
    const aw = arrow ? 96 : 0, pad = 30, tx = arrow === 'left' ? pad + aw : pad, maxW = SW - pad * 2 - aw;
    x.textBaseline = 'middle'; x.textAlign = 'left'; x.fillStyle = fg;
    let s = 64; while (s > 24) { x.font = `800 ${s}px Archivo`; if (x.measureText(title).width <= maxW) break; s -= 2; }
    x.fillText(title, tx, sub ? SH * .4 : SH * .5);
    if (sub) { x.fillStyle = subColor; let q = 30; while (q > 14) { x.font = `500 ${q}px "IBM Plex Mono"`; if (x.measureText(sub).width <= maxW) break; q -= 2; } x.fillText(sub, tx, SH * .74); }
    if (arrow) {
      const cx = arrow === 'left' ? pad + aw * .45 : SW - pad - aw * .45, cy = SH * .5, k = arrow === 'left' ? -1 : 1;
      x.fillStyle = fg; x.beginPath();
      x.moveTo(cx + k * 44, cy); x.lineTo(cx + k * 6, cy - 32); x.lineTo(cx + k * 6, cy - 11); x.lineTo(cx - k * 44, cy - 11); x.lineTo(cx - k * 44, cy + 11); x.lineTo(cx + k * 6, cy + 11); x.lineTo(cx + k * 6, cy + 32);
      x.closePath(); x.fill();
    }
    x.restore();
  }
  function bannerTex() {
    const w = 1024, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.fillStyle = '#f7bd0c'; x.fillRect(0, 0, w, h);
    const k = h / 2; for (let q = 0; q < 6; q++) for (let r = 0; r < 2; r++) { x.fillStyle = (q + r) % 2 ? '#1c1b19' : '#f6f7f3'; x.fillRect(q * k, r * k, k, k); x.fillRect(w - (q + 1) * k, r * k, k, k); }
    x.fillStyle = '#1c1b19'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '800 74px Archivo'; x.fillText('START · FINISH', w / 2, h / 2 + 2);
    const t = new T.CanvasTexture(c); t.anisotropy = 4; return t;
  }

  /* ---------------- build / teardown ---------------- */
  let group = null, mySurfaces = [], mySolids = [], lineMat = null;
  function teardown() {
    if (group) {
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); const m = o.material; if (m && m.map && m.map.dispose) m.map.dispose(); if (m && m.dispose) m.dispose(); });
      W.scene.remove(group);
    }
    group = null;
    for (const s of mySurfaces) { const i = W.surfaces.indexOf(s); if (i >= 0) W.surfaces.splice(i, 1); }
    for (const s of mySolids) { const i = W.solids.indexOf(s); if (i >= 0) W.solids.splice(i, 1); }
    mySurfaces = []; mySolids = []; R.polylines = []; R.loop = []; R.junctions = []; R.guardRuns = []; R.bridge = null; R.gantry = null; SEG.count = 0; GRID.cells = null;
    R.distance = () => 1e9; R.nearest = () => null; R.ready = false;
  }
  const solid = (x, z, r, tag) => { const s = W.solid(x, z, r, tag); mySolids.push(s); return s; };
  const addSurface = s => { W.addSurface(s); mySurfaces.push(s); return s; };

  function build(isRebuild) {
    if (isRebuild) teardown();
    group = new T.Group(); group.name = 'roads'; W.scene.add(group);

    /* ---- 1. centrelines ---- */
    const ring = spline(RING, true);
    const loop = R.loop = ring.pts.map((p, i, a) => ({ x: p.x, z: p.z, y: 0, s: i * ring.length / a.length, t: i / a.length }));
    const polylines = R.polylines = [{ id: 'ring', points: ring.pts, closed: true, dirt: false, width: ASPHALT_HW * 2 }];
    const junctions = R.junctions;
    const addRoad = (id, pts, dirt, extra) => { const pl = Object.assign({ id, points: pts, closed: false, dirt, width: dirt ? DIRT_HW * 2 : ASPHALT_HW * 2 }, extra || {}); polylines.push(pl); return pl; };
    const ringPointNear = (x, z) => { const p = nearest(x, z); return [p.x, p.z]; };

    // The bridge axis is skewed a little from the river normal so the north spur arrives aligned.
    const bC = { x: 18, z: riverZ(18) }, bP = unit(.29, -.96), bN = { x: -bP.z, z: bP.x }, B_HALF = 8, B_RAMP = 8, B_HW = 4.4;
    const bS = { x: bC.x - bP.x * B_HALF, z: bC.z - bP.z * B_HALF }, bE = { x: bC.x + bP.x * B_HALF, z: bC.z + bP.z * B_HALF };
    const wl = num(W.terrain.waterLevel, -999);
    const deckY = Math.max(th(bS.x, bS.z), th(bE.x, bE.z), wl > -100 ? wl + 1.2 : -99) + .6;
    const footS = { x: bS.x - bP.x * B_RAMP, z: bS.z - bP.z * B_RAMP }, footE = { x: bE.x + bP.x * B_RAMP, z: bE.z + bP.z * B_RAMP };
    const gFootS = th(footS.x, footS.z), gFootE = th(footE.x, footE.z);
    {
      const xs = [bS.x, bE.x, footS.x, footE.x], zs = [bS.z, bE.z, footS.z, footE.z];
      const minX = Math.min(...xs) - B_HW - 1, maxX = Math.max(...xs) + B_HW + 1, minZ = Math.min(...zs) - B_HW - 1, maxZ = Math.max(...zs) + B_HW + 1;
      addSurface({ id: 'bridge', height(x, z) {
        if (x < minX || x > maxX || z < minZ || z > maxZ) return null;
        const dx = x - bS.x, dz = z - bS.z, s = dx * bP.x + dz * bP.z, t = dx * bN.x + dz * bN.z;
        if (t > B_HW || t < -B_HW) return null;
        if (s >= 0 && s <= 2 * B_HALF) return deckY;
        // Ramps are straight from the foot height to the deck (they match the tilted embankment
        // blocks); only the first 30% blends into the local terrain so the foot has no step.
        if (s < 0) { if (s <= -B_RAMP) return null; const u = (s + B_RAMP) / B_RAMP; return W.lerp(th(x, z), gFootS + (deckY - gFootS) * u, W.smoothstep(0, .3, u)); }
        if (s >= 2 * B_HALF + B_RAMP) return null; const u = (2 * B_HALF + B_RAMP - s) / B_RAMP; return W.lerp(th(x, z), gFootE + (deckY - gFootE) * u, W.smoothstep(0, .3, u));
      } });
      R.bridge = { x: bC.x, z: bC.z, start: bS, end: bE, deckY, dir: bP, width: B_HW * 2, length: 2 * B_HALF };
    }

    // North spur: ring → bridge → town. Collinear control points keep the deck straight.
    const north = spline([[0, -44], [5, -51], [10, -59], [bS.x - bP.x * 4.5, bS.z - bP.z * 4.5], [bS.x, bS.z], [bE.x, bE.z], [bE.x + bP.x * 3, bE.z + bP.z * 3], [23.4, -92.6], [24.6, -94.6]], false);
    addRoad('north', north.pts, false, { to: 'town' });
    addRoad('east', spline([[56, 8], [63, 12], [71, 19], [79, 29], [86, 37]], false).pts, false, { to: 'mine' });
    addRoad('south', spline([[2, 56], [3, 66], [4.5, 78], [5.5, 89]], false).pts, false, { to: 'railStation' });
    junctions.push({ id: 'north', x: 0, z: -44, kind: 'spur' }, { id: 'east', x: 56, z: 8, kind: 'spur' }, { id: 'south', x: 2, z: 56, kind: 'spur' });

    // Dirt tracks: a first waypoint 'ring' resolves to the nearest ring point of the hint.
    const TRACKS = [
      { id: 'plaza', title: 'Plaza', sub: 'start · ekhlel', pts: [[0, -44], [0, -24]], straight: true },
      { id: 'depot', title: 'Open T depot', sub: 'fleet platform', pts: [['ring', -46, -22], [-39, -11], [-35, -5.5], [-32.6, -3.4]] },
      { id: 'fuel', title: 'Fuel station', sub: 'shatakhuun', pts: [['ring', 30, -36], [28.4, -22], [26.8, -9.4]] },
      { id: 'senti', title: 'SentimentAI', sub: 'diploma thesis', pts: [['ring', -50, 34], [-44, 33], [-36, 27.6], [-27.3, 25.2]] },
      { id: 'about', title: 'Ger camp', sub: 'about · tanilts', pts: [['ring', 50, 38], [43, 37.4], [35, 33], [28.8, 30.3]] },
      { id: 'plant', title: 'Power plant', sub: 'tsakhilgaan stants', pts: [['ring', -53, -14], [-62, -16.2], [-73.2, -20.4]] },
      { id: 'wind', title: 'Wind farm', sub: 'salkhin park', pts: [['ring', -41, 45], [-50, 55], [-58, 66], [-64, 73]] },
      { id: 'lake', title: 'Lake', sub: 'nuur', pts: [['ring', -50, 34], [-60, 36.5], [-70, 42], [-76.6, 45]] }
    ];
    for (const tr of TRACKS) {
      const pts = tr.pts.map(p => p[0] === 'ring' ? ringPointNear(p[1], p[2]) : p);
      const r = tr.straight ? straight(pts[0], pts[1]) : spline(pts, false);
      tr.points = r.pts; addRoad(tr.id, r.pts, true, { to: tr.id });
      junctions.push({ id: tr.id, x: pts[0][0], z: pts[0][1], kind: 'track' });
    }

    /* ---- 2. distance field (ready before anything calls W.isClear) ---- */
    buildDistanceField(polylines);
    R.distance = distance; R.nearest = nearest; R.ready = true;
    const tanAt = (x, z) => { const p = nearest(x, z), a = loop[p.i], b = loop[(p.i + 1) % loop.length]; return unit(b.x - a.x, b.z - a.z); };

    /* ---- 3. ribbons: asphalt base, paint lines (glow a little at night), dirt ---- */
    const sinks = { base: new Sink(), line: new Sink(), dirt: new Sink() };
    const sinkOf = k => sinks[k];
    const cA = rgb(COL.asphalt), cE = rgb(COL.edge), cD = rgb(COL.dash);
    const asphaltStrips = [
      { a: ASPHALT_HW, b: ASPHALT_HW - .32, color: cE, target: 'line' },
      { a: ASPHALT_HW - .32, b: .13, color: cA, target: 'base' },
      { a: .13, b: -.13, color: i => (i % 4) < 2 ? cD : null, target: 'line' },
      { a: .13, b: -.13, color: i => (i % 4) < 2 ? null : cA, target: 'base' },
      { a: -.13, b: -(ASPHALT_HW - .32), color: cA, target: 'base' },
      { a: -(ASPHALT_HW - .32), b: -ASPHALT_HW, color: cE, target: 'line' }
    ];
    const loopRows = ribbon(ring.pts, true, Y_RING, asphaltStrips, sinkOf, null);
    for (let i = 0; i < loop.length; i++) loop[i].y = loopRows[i][.13].y;
    for (const pl of polylines) if (!pl.dirt && !pl.closed) ribbon(pl.points, false, Y_SPUR, asphaltStrips, sinkOf, pl.points[0]);
    const dirtBase = rgb(COL.dirt);
    for (const pl of polylines) if (pl.dirt) {
      const n = pl.points.length, raw = []; for (let i = 0; i < n; i++) raw.push((W.rng() - .5) * .04);
      const tint = raw.map((v, i) => dirtBase.clone().offsetHSL(0, 0, (raw[Math.max(0, i - 1)] + v + raw[Math.min(n - 1, i + 1)]) / 3));
      ribbon(pl.points, false, Y_DIRT, [{ a: DIRT_HW, b: -DIRT_HW, color: i => tint[i], target: 'dirt' }], sinkOf, pl.points[0]);
    }

    /* ---- 4. start / finish gantry: straddles the ring 6.5 m before the (0,-44) junction, where
            the north spur and the plaza track leave, so its legs stand clear of them ---- */
    const gi = loop.length - 3, G = loop[gi], gT = tanAt(G.x, G.z), gN = { x: gT.z, z: -gT.x };
    R.gantry = { x: G.x, z: G.z, i: gi, dir: gT };
    { // chequered line painted into the road surface (follows the ground on any terrain)
      const pts = [-1, -.5, 0, .5, 1].map(k => ({ x: G.x + gT.x * k * .7, z: G.z + gT.z * k * .7 }));
      const strips = [], cols = 14, w = (ASPHALT_HW * 2 - .4) / cols, black = rgb('#1c1b19'), white = rgb('#f6f7f3');
      for (let c = 0; c < cols; c++) { const a = -ASPHALT_HW + .2 + c * w; strips.push({ a: +(a + w).toFixed(3), b: +a.toFixed(3), color: i => (i + c) % 2 ? black : white, target: 'line' }); }
      ribbon(pts, false, Y_RING + .012, strips, sinkOf, null);
    }
    const baseMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    lineMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: .9, metalness: 0, emissive: new T.Color('#f6e9b4'), emissiveIntensity: W.night ? .35 : 0 });
    const dirtMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    for (const [k, mat] of [['base', baseMat], ['line', lineMat], ['dirt', dirtMat]]) { const m = new T.Mesh(sinks[k].geometry(), mat); m.receiveShadow = true; m.name = 'road-' + k; group.add(m); }
    (() => {
      const y0 = W.groundY(G.x, G.z), span = 5.4, H = 6.2, g = new T.Group();
      g.position.set(G.x, y0, G.z); g.rotation.y = Math.atan2(gN.x, gN.z); // local +z = across the road
      const bx = new Boxes(), steel = '#2b2e33';
      for (const sd of [-1, 1]) { bx.add(.5, H, .5, steel, 0, H / 2, sd * span); bx.add(1.1, .25, 1.1, '#b8b4ab', 0, .125, sd * span); bx.add(.28, 2.2, .3, '#f7bd0c', .27, 1.5, sd * span); }
      bx.add(.6, 1.15, 2 * span + .5, steel, 0, H + .3, 0);
      g.add(bx.mesh());
      const bt = bannerTex();
      for (const sd of [-1, 1]) { const b = new T.Mesh(new T.PlaneGeometry(2 * span - .2, 1.0), new T.MeshBasicMaterial({ map: bt })); b.position.set(sd * .32, H + .3, 0); b.rotation.y = sd * Math.PI / 2; g.add(b); }
      // small flat pennants on the beam, alternating Open T yellow and blue
      const flag = new T.BufferGeometry(); flag.setAttribute('position', new T.Float32BufferAttribute([0, 0, -.28, 0, 0, .28, 0, .62, 0], 3)); flag.computeVertexNormals();
      const pen = new T.InstancedMesh(flag, new T.MeshStandardMaterial({ roughness: .8, side: T.DoubleSide }), 11), mtx = new T.Matrix4(), col = new T.Color();
      for (let i = 0; i < 11; i++) { mtx.makeTranslation(0, H + .88, -span + .5 + i * (2 * span - 1) / 10); pen.setMatrixAt(i, mtx); pen.setColorAt(i, col.set(i % 2 ? '#1f4fd1' : '#f7bd0c')); }
      pen.instanceMatrix.needsUpdate = true; if (pen.instanceColor) pen.instanceColor.needsUpdate = true; g.add(pen);
      W.shadowed(g); group.add(g);
      for (const sd of [-1, 1]) solid(G.x + gN.x * sd * span, G.z + gN.z * sd * span, .55, 'gantry');
    })();

    /* ---- 5. signs: boards share one texture atlas (one draw call), posts and backs are instanced ---- */
    const signs = [];
    const addSign = (x, z, face, title, sub, arrow, kind) => signs.push({ x, z, face, title, sub, arrow, kind });
    addSign(-5.6, -49.6, { x: -.5, z: .87 }, 'Khuslen Khot', 'town · over the bridge', 'left', 'blue');
    addSign(61.6, .8, { x: .3, z: .95 }, 'Mine', 'uurkhai', 'left', 'blue');
    addSign(9.2, 61.4, { x: .95, z: -.3 }, 'Rail station', 'galt teregnii buudal', 'left', 'blue');
    addSign(bS.x - bP.x * 5 + bN.x * 5.4, bS.z - bP.z * 5 + bN.z * 5.4, { x: -bP.x, z: -bP.z }, 'Khuslen gol', 'river · bridge 8 t', null, 'white');
    for (const tr of TRACKS) { // wooden fingerposts just before each dirt junction, facing clockwise traffic
      const J = tr.points[0], d = unit(tr.points[1].x - J.x, tr.points[1].z - J.z), tg = tanAt(J.x, J.z);
      const right = d.x * -tg.z + d.z * tg.x > 0;
      addSign(J.x + d.x * 5.6 - tg.x * 3.6, J.z + d.z * 5.6 - tg.z * 3.6, unit(-tg.x * .4 + .59, -tg.z * .4 + .81), tr.title, tr.sub, right ? 'right' : 'left', 'wood');
    }
    (() => {
      const n = signs.length, colsN = 2, rowsN = Math.ceil(n / colsN);
      const c = document.createElement('canvas'); c.width = SW * colsN; c.height = SH * rowsN; const x = c.getContext('2d');
      const pos = [], nor = [], uv = [], posts = new Boxes(), backs = new Boxes();
      signs.forEach((s, k) => {
        const blue = s.kind === 'blue', white = s.kind === 'white';
        const bw = blue ? 2.6 : white ? 1.9 : 1.75, bh = blue ? .98 : white ? .72 : .62, top = blue ? 3.1 : white ? 2.35 : 2.2;
        const ox = (k % colsN) * SW, oy = Math.floor(k / colsN) * SH;
        drawSign(x, ox, oy, s.title, s.sub, blue ? { arrow: s.arrow } : white ? { bg: '#f6f4ee', fg: '#18202b', subColor: '#5a6573', border: '#18202b' } : { bg: '#e3d4a7', fg: '#2a241c', subColor: '#5a4a32', border: 'rgba(42,36,28,.8)', arrow: s.arrow });
        const y0 = W.groundY(s.x, s.z), ry = Math.atan2(s.face.x, s.face.z), rx = Math.cos(ry), rz = -Math.sin(ry); // board width axis
        const cx = s.x + s.face.x * .04, cz = s.z + s.face.z * .04, cy = y0 + top - bh / 2;
        const P = (u, v) => [cx + rx * u * bw / 2, cy + v * bh / 2, cz + rz * u * bw / 2];
        const u0 = ox / c.width, u1 = (ox + SW) / c.width, v1 = 1 - oy / c.height, v0 = 1 - (oy + SH) / c.height;
        const A = P(-1, -1), B = P(1, -1), C = P(1, 1), D = P(-1, 1);
        for (const [p, t] of [[A, [u0, v0]], [B, [u1, v0]], [C, [u1, v1]], [A, [u0, v0]], [C, [u1, v1]], [D, [u0, v1]]]) { pos.push(...p); nor.push(s.face.x, 0, s.face.z); uv.push(...t); }
        backs.add(bw + .08, bh + .08, .06, blue ? '#2a3f8a' : '#2b2e33', s.x, cy, s.z, ry);
        const px = s.x - s.face.x * .05, pz = s.z - s.face.z * .05;
        if (blue) for (const sd of [-1, 1]) posts.add(.1, top - .1, .1, '#9da5ad', px + rx * sd * (bw / 2 - .25), y0 + (top - .1) / 2, pz + rz * sd * (bw / 2 - .25), ry);
        else posts.add(.1, top - bh + .05, .1, white ? '#9da5ad' : '#6b4a2d', px, y0 + (top - bh + .05) / 2, pz, ry);
        solid(s.x, s.z, .3, 'sign');
      });
      const tex = new T.CanvasTexture(c); tex.anisotropy = 4;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.computeBoundingSphere();
      const boards = new T.Mesh(g, new T.MeshStandardMaterial({ map: tex, roughness: .75 })); boards.castShadow = true; group.add(boards);
      group.add(posts.mesh(), backs.mesh());
    })();

    /* ---- 6. the bridge: deck, kerbs, rails, posts, abutments, piers, approach embankments ---- */
    (() => {
      const g = new T.Group(); g.position.set(bC.x, 0, bC.z); g.rotation.y = Math.atan2(bP.x, bP.z); // local +z = S → E along the deck
      const L = 2 * B_HALF, Wd = 2 * B_HW, deckT = .7, concrete = '#b8b4ab', bx = new Boxes();
      bx.add(Wd, deckT, L + .6, concrete, 0, deckY - deckT / 2, 0);                               // deck slab
      for (const sd of [-1, 1]) {
        bx.add(.45, .32, L + .6, '#d7d2c6', sd * (B_HW - .225), deckY + .16, 0);                   // kerb
        bx.add(.08, .08, L + .4, '#fbfbf7', sd * (B_HW - .22), deckY + 1.08, 0);                   // top rail
        bx.add(.07, .07, L + .4, '#fbfbf7', sd * (B_HW - .22), deckY + .68, 0);                    // mid rail
        bx.add(Wd + .6, deckY - deckT + 3.2, 1.4, concrete, 0, (deckY - deckT - 3.2) / 2, sd * L / 2); // abutment
      }
      for (const sz of [-3.6, 3.6]) bx.add(6.4, .5, .9, concrete, 0, deckY - deckT - .25, sz);     // pier cross beams
      // approach embankments: tilted blocks whose top follows the ramp surface (foot end lower)
      for (const [gFoot, sign] of [[gFootS, -1], [gFootE, 1]]) {
        const rise = deckY - gFoot, len = Math.hypot(B_RAMP, rise);
        bx.add(Wd + .2, 2.2, len + .3, concrete, 0, (gFoot + deckY) / 2 - 1.13, sign * (B_HALF + B_RAMP / 2), 0, sign * Math.atan2(rise, B_RAMP));
      }
      g.add(bx.mesh());
      const posts = new Boxes(), np = Math.round(L / 2);
      for (let k = 0; k <= np; k++) for (const sd of [-1, 1]) posts.add(.11, .95, .11, '#1f4fd1', sd * (B_HW - .22), deckY + .32 + .475, -L / 2 + k * L / np);
      g.add(posts.mesh());
      const piers = new Boxes();
      for (const sz of [-3.6, 3.6]) for (const sx of [-2.5, 2.5]) piers.add(1, deckY - deckT + 3.2, 1, concrete, sx, (deckY - deckT - 3.2) / 2, sz);
      g.add(piers.mesh(new T.CylinderGeometry(.45, .55, 1, 10)));
      group.add(g);
      // invisible kerb colliders along both edges (deck and ramps) so the truck cannot drop off
      for (let s = -B_RAMP + 1.5; s <= L + B_RAMP - 1.5; s += 1.6) for (const sd of [-1, 1]) { const t = sd * (B_HW + .05); solid(bS.x + bP.x * s + bN.x * t, bS.z + bP.z * s + bN.z * t, .35, 'bridge'); }
    })();

    /* ---- 7. guard rails on the outside of the sharp bends, broken at junctions ---- */
    (() => {
      const n = loop.length, curv = new Float32Array(n), tan = tangents(ring.pts, true);
      for (let i = 0; i < n; i++) { const a = tan[(i - 1 + n) % n], b = tan[(i + 1) % n]; let d = Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; curv[i] = d / 2; }
      const sm = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = -3; k <= 3; k++) s += curv[(i + k + n) % n]; sm[i] = s / 7; }
      const nearJ = i => junctions.some(j => hyp(loop[i].x - j.x, loop[i].z - j.z) < 11);
      const want = new Uint8Array(n); for (let i = 0; i < n; i++) want[i] = Math.abs(sm[i]) > .0185 && !nearJ(i) ? 1 : 0;
      const runs = []; let start = -1;
      for (let i = 0; i < 2 * n; i++) { const w = want[i % n]; if (w && start < 0) start = i; if (!w && start >= 0) { if (start < n && i - start >= 7 && !(start === 0 && want[n - 1])) runs.push([start, i]); start = -1; } }
      const off = ASPHALT_HW + 1.0, band = new Sink(), posts = new Boxes(), cS = rgb(COL.rail);
      for (const [a, b] of runs) {
        const pts = []; for (let i = a; i <= b; i++) { const k = i % n, x = loop[k].x + tan[k].z * off, z = loop[k].z - tan[k].x * off; pts.push({ x, z, y: W.groundY(x, z) }); }
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          band.quad({ x: p.x, y: p.y + .5, z: p.z }, { x: p.x, y: p.y + .78, z: p.z }, { x: q.x, y: q.y + .78, z: q.z }, { x: q.x, y: q.y + .5, z: q.z }, cS);
          if (i % 2 === 0) posts.add(.12, .8, .12, '#6b7177', p.x, p.y + .4, p.z);
        }
        const e = pts[pts.length - 1]; posts.add(.12, .8, .12, '#6b7177', e.x, e.y + .4, e.z);
      }
      if (band.quads) {
        const bm = new T.Mesh(band.geometry(), new T.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .05, side: T.DoubleSide })); bm.castShadow = true; group.add(bm);
        group.add(posts.mesh());
      }
      R.guardRuns = runs.map(([a, b]) => ({ from: a % n, to: b % n }));
    })();

    return R;
  }

  /* ---------------- hooks ---------------- */
  W.onReady(() => { try { build(false); } catch (e) { console.error('roads failed to build', e); } });
  W.onNight(on => { if (lineMat) lineMat.emissiveIntensity = on ? .35 : 0; });
})();
