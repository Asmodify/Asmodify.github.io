/* foliage.js — forests and ground cover. Larch/pine stands on the hills and the lower mountain
   slopes (dense to the north and east), birches along the river, saxaul bushes on the steppe,
   rocks everywhere, grass tufts on the plateau and reeds at the lake and river banks.
   Six THREE.InstancedMesh objects (one draw call each, plus a shadow pass for trees, bushes and
   rocks), placed by rejection sampling with W.rng, W.groundY and W.isClear. Trees and rocks over
   1 m inside the drivable disc register W.solid(). Grass and reeds sway in a vertex shader.
   Exposes W.foliage = { ready, stats, counts, trees, rocks, meshes, nearestTree }. See CONTRACT.md. */
(() => {
  const W = window.W; if (!W) return;
  const T = W.T, sstep = W.smoothstep;
  const F = W.foliage = { ready: false, stats: null, counts: {}, trees: [], rocks: [], meshes: [], nearestTree: () => null };

  /* ---------------- plan constants (fixed by CONTRACT.md) ---------------- */
  const DRIVE_R = 118, OUTER_R = 164, SNOW_FALLBACK = 30;
  const RIVER = [[-130, -58], [-70, -64], [-20, -74], [30, -78], [80, -70], [130, -82]];
  const LAKE = { x: -92, z: 52 };
  const PLAZA = { x: 0, z: 6, r: 24 };
  const NAME_RECT = { x0: -29, x1: 29, z0: -23, z1: -7 };            // the KHUSLEN blocks and their subtitle
  // Footprints other modules own, as [x, z, r]. stations.js runs after foliage so its rings, props
  // and camp are always taken from the plan; the pads are a fallback for a stubbed buildings.js.
  const PLAN = [
    [-28, -2, 15], [26, -4, 13], [-22, 26, 11], [-23, 18, 7], [24, 28, 10], [29, 22, 10],   // depot, fuel, SentimentAI + billboard, About + ger camp
    [28, -100, 23], [92, 42, 19], [-86, -26, 17], [62, -22, 13], [6, 98, 15],               // town, mine, power plant, bus terminal, rail station
    [14, -30, 7], [70, -8, 7], [-60, -50, 7], [40, -52, 9]                                   // ramps and bowling pad the plan suggests to missions.js
  ];
  const RAIL = { z: 94, x0: -118, x1: 118, hw: 6.5 };
  // Road plan, only used when roads.js is stubbed (then W.roads is undefined and isClear knows no roads).
  const RING = [[0, -44], [38, -32], [56, 8], [42, 46], [2, 56], [-40, 46], [-58, 6], [-40, -34]];
  const SPURS = [[[0, -44], [10, -59], [18, -76], [24, -93], [28, -100]], [[56, 8], [71, 19], [92, 42]], [[2, 56], [4.5, 78], [6, 98]], [[0, -44], [0, -24]],
    [[-46, -22], [-39, -11], [-32, -3]], [[30, -36], [28, -22], [26, -9]], [[-50, 34], [-44, 33], [-27, 25]], [[50, 38], [43, 37], [29, 30]],
    [[-53, -14], [-62, -16], [-73, -20]], [[-41, 45], [-50, 55], [-64, 73]], [[-50, 34], [-60, 36], [-77, 45]]];

  /* ---------------- small helpers ---------------- */
  const num = (v, d) => typeof v === 'number' && v === v ? v : d;
  const hyp = Math.hypot;
  // Lattice value noise in [0,1], hashed (no rng), so stands and patches do not depend on call order.
  const ih = (i, j) => { let n = (i * 1597334677 ^ j * 3812015801) | 0; n = Math.imul(n ^ n >>> 15, 2246822519 | 1); n = Math.imul(n ^ n >>> 13, 3266489917 | 1); return ((n ^ n >>> 16) >>> 0) / 4294967296; };
  function noise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = ih(xi, zi), b = ih(xi + 1, zi), c = ih(xi, zi + 1), d = ih(xi + 1, zi + 1), t = a + (b - a) * u, s = c + (d - c) * u;
    return t + (s - t) * v;
  }

  // River as segments with cumulative length, for sampling bank points.
  const RSEG = []; let RLEN = 0;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const [ax, az] = RIVER[i], [bx, bz] = RIVER[i + 1], dx = bx - ax, dz = bz - az, L = hyp(dx, dz);
    RSEG.push({ ax, az, dx, dz, L, nx: -dz / L, nz: dx / L, s0: RLEN }); RLEN += L;
  }
  const annulus = (P, r0, r1) => { const a = W.rng() * 6.2832, r = Math.sqrt(r0 * r0 + W.rng() * (r1 * r1 - r0 * r0)); P[0] = Math.cos(a) * r; P[1] = Math.sin(a) * r; return true; };
  const lakeSample = (P, d0, d1) => { const a = W.rng() * 6.2832, d = Math.sqrt(d0 * d0 + W.rng() * (d1 * d1 - d0 * d0)); P[0] = LAKE.x + Math.cos(a) * d; P[1] = LAKE.z + Math.sin(a) * d; return true; };
  const riverSample = (P, d0, d1) => {
    const s = W.rng() * RLEN; let k = 0; while (k < RSEG.length - 1 && s > RSEG[k].s0 + RSEG[k].L) k++;
    const g = RSEG[k], u = (s - g.s0) / g.L, d = W.rand(d0, d1) * (W.rng() < .5 ? -1 : 1);
    P[0] = g.ax + g.dx * u + g.nx * d; P[1] = g.az + g.dz * u + g.nz * d; return true;
  };

  /* ---------------- point grids: road centrelines and existing solids, for cheap clearance ----------------
     W.isClear is exact but scans every solid and asks roads.distance (together ~15 µs); with tens of
     thousands of candidates that is most of the budget. The same data goes into 8 m buckets here so
     candidates are filtered at well under a microsecond, and W.isClear confirms the survivors. */
  const RG = 8;
  const gkey = (cx, cz) => ((cx + 512) << 10) | (cz + 512);
  const gput = (grid, x, z, ...rest) => { const k = gkey(Math.floor(x / RG), Math.floor(z / RG)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(x, z, ...rest); };
  let roadGrid = null, solidGrid = null, bigSolids = [];
  function buildRoadGrid(polylines) {
    roadGrid = new Map();
    const seg = (ax, az, bx, bz) => { const n = Math.max(1, Math.ceil(hyp(bx - ax, bz - az) / 2)); for (let i = 0; i <= n; i++) gput(roadGrid, ax + (bx - ax) * i / n, az + (bz - az) * i / n); };
    if (polylines) {
      for (const pl of polylines) { const p = pl && pl.points; if (!p || p.length < 2) continue; const n = pl.closed ? p.length : p.length - 1; for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % p.length]; seg(num(a.x, 0), num(a.z, 0), num(b.x, 0), num(b.z, 0)); } }
      return;
    }
    try { const c = new T.CatmullRomCurve3(RING.map(p => new T.Vector3(p[0], 0, p[1])), true, 'centripetal'); for (const p of c.getSpacedPoints(Math.round(c.getLength() / 2))) gput(roadGrid, p.x, p.z); }
    catch (e) { for (let i = 0; i < RING.length; i++) { const a = RING[i], b = RING[(i + 1) % RING.length]; seg(a[0], a[1], b[0], b[1]); } }
    for (const s of SPURS) for (let i = 0; i < s.length - 1; i++) seg(s[i][0], s[i][1], s[i + 1][0], s[i + 1][1]);
  }
  // True when a sampled centreline point lies within lim (points sit on the road, so this never rejects a clear spot).
  function roadNear(x, z, lim) {
    const cx = Math.floor(x / RG), cz = Math.floor(z / RG), l2 = lim * lim;
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const l = roadGrid.get(gkey(i, j)); if (!l) continue;
      for (let k = 0; k < l.length; k += 2) { const dx = l[k] - x, dz = l[k + 1] - z; if (dx * dx + dz * dz < l2) return true; }
    }
    return false;
  }
  function buildSolidGrid() {
    solidGrid = new Map(); bigSolids = [];
    for (const s of W.solids) { const x = num(s.x, 0), z = num(s.z, 0), r = num(s.r, 0); if (r > 6) bigSolids.push(x, z, r); else gput(solidGrid, x, z, r); }
  }
  function solidNear(x, z, r) {
    for (let k = 0; k < bigSolids.length; k += 3) { const dx = bigSolids[k] - x, dz = bigSolids[k + 1] - z, m = bigSolids[k + 2] + r; if (dx * dx + dz * dz < m * m) return true; }
    const cx = Math.floor(x / RG), cz = Math.floor(z / RG);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const l = solidGrid.get(gkey(i, j)); if (!l) continue;
      for (let k = 0; k < l.length; k += 3) { const dx = l[k] - x, dz = l[k + 1] - z, m = l[k + 2] + r; if (dx * dx + dz * dz < m * m) return true; }
    }
    return false;
  }

  /* ---------------- spacing hashes: nothing overlaps anything placed earlier ----------------
     Trees, bushes and rocks live in 4 m cells; the thousands of grass tufts and reeds in 1 m cells,
     so a tuft checks a few neighbours instead of every tuft within 6 m. */
  const HG = 4, hash = new Map(), FG = 1, fine = new Map();
  const hkey = (cx, cz) => ((cx + 1024) << 11) | (cz + 1024);
  function spaced(map, cell, x, z, r) {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const l = map.get(hkey(i, j)); if (!l) continue;
      for (let k = 0; k < l.length; k += 3) { const dx = l[k] - x, dz = l[k + 1] - z, m = r + l[k + 2]; if (dx * dx + dz * dz < m * m) return false; }
    }
    return true;
  }
  function occupy(map, cell, x, z, r) { const k = hkey(Math.floor(x / cell), Math.floor(z / cell)); let l = map.get(k); if (!l) map.set(k, l = []); l.push(x, z, r); }

  /* ---------------- geometry builder: parts + coloured triangles → one non-indexed geometry ---------------- */
  const V = new T.Vector3(), M4 = new T.Matrix4(), M2 = new T.Matrix4(), Q = new T.Quaternion(), E = new T.Euler(), SC = new T.Vector3(), C = new T.Color();
  const mt = (x, y, z, sx = 1, sy = 1, sz = 1) => new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion(), new T.Vector3(sx, sy, sz));
  function Geo() { this.p = []; this.n = []; this.c = []; }
  Geo.prototype.part = function (g, color, m) {
    const src = g.index ? g.toNonIndexed() : g, P = src.attributes.position, N = src.attributes.normal, nm = new T.Matrix3().getNormalMatrix(m), c = new T.Color(color);
    for (let i = 0; i < P.count; i++) {
      V.fromBufferAttribute(P, i).applyMatrix4(m); this.p.push(V.x, V.y, V.z);
      if (N) { V.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); this.n.push(V.x, V.y, V.z); } else this.n.push(0, 1, 0);
      this.c.push(c.r, c.g, c.b);
    }
    if (src !== g) src.dispose(); g.dispose(); return this;
  };
  Geo.prototype.tri = function (a, b, c, ca, cb, cc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    V.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.n.push(V.x, V.y, V.z);
    for (const k of [ca, cb, cc || cb]) this.c.push(k.r, k.g, k.b);
    return this;
  };
  Geo.prototype.build = function () {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere(); g.userData.tris = this.p.length / 9; return g;
  };
  // A blade: thin triangle from a base of half-width w up to a tip at height h, leaning by `lean`, turned by yaw.
  function blade(G, yaw, w, h, lean, cBase, cTip) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw), r = (x, z) => [x * cs - z * sn, 0, x * sn + z * cs], a = r(-w, 0), b = r(w, 0), t = r(0, lean);
    G.tri([a[0], 0, a[2]], [b[0], 0, b[2]], [t[0], h, t[2]], cBase, cBase, cTip);
  }
  // A seed head: a thin diamond standing on the tip of a blade.
  function head(G, yaw, lean, y0, y1, w, c) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw), r = (x, z) => [x * cs - z * sn, x * sn + z * cs];
    const lo = r(0, lean), hi = r(0, lean * 1.08), l = r(-w, lean * 1.04), rt = r(w, lean * 1.04), ym = (y0 + y1) / 2;
    G.tri([lo[0], y0, lo[1]], [rt[0], ym, rt[1]], [hi[0], y1, hi[1]], c, c, c); G.tri([lo[0], y0, lo[1]], [hi[0], y1, hi[1]], [l[0], ym, l[1]], c, c, c);
  }

  /* ---------------- materials; grass and reeds sway in the vertex shader ---------------- */
  const wind = { value: 0 };
  function material(o, sway) {
    const m = new T.MeshStandardMaterial(Object.assign({ vertexColors: true, flatShading: true, roughness: .92, metalness: 0 }, o));
    if (sway) {
      m.onBeforeCompile = sh => {
        sh.uniforms.uTime = wind;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ float ph = uTime * 1.6 + instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;'
            + ' float k = position.y * position.y * ' + sway.toFixed(3) + ';'
            + ' transformed.x += k * (sin(ph) + 0.35 * sin(ph * 2.7 + 1.3)); transformed.z += k * 0.5 * cos(ph * 0.9 + 0.7); }');
      };
      m.customProgramCacheKey = () => 'foliage-sway-' + sway;
    }
    return m;
  }

  /* ---------------- tree hits: a short canopy wobble and a puff of leaves ---------------- */
  const shakes = []; let lastHit = 0;
  // Solids are queued and registered after placement: W.isClear scans every solid, so adding
  // hundreds of trees while still scattering would make each later check slower.
  const pending = [];
  const queueSolid = (x, z, r, tag, onHit) => { if (hyp(x, z) <= DRIVE_R + 2) pending.push({ x, z, r, tag, onHit }); };
  function treeSolid(mesh, i, x, z, leaf) {
    queueSolid(x, z, .6, 'tree', () => {
      const now = performance.now(); if (now - lastHit < 250) return; lastHit = now;
      W.puff(x, z, 1.3, leaf); W.puff(x + .7, z - .4, .9, leaf);
      for (const k of shakes) if (k.mesh === mesh && k.i === i) { k.t = 0; return; }
      const base = new T.Matrix4(); mesh.getMatrixAt(i, base);
      shakes.push({ mesh, i, t: 0, base, ax: W.rand(-1, 1), az: W.rand(-1, 1) });
    });
  }
  W.onUpdate((dt, now) => {
    wind.value = now / 1000;
    if (!shakes.length) return;
    const touched = [];
    for (let k = shakes.length - 1; k >= 0; k--) {
      const s = shakes[k]; s.t += dt;
      if (s.t > .9) { s.mesh.setMatrixAt(s.i, s.base); shakes.splice(k, 1); }
      else { const a = Math.sin(s.t * 22) * Math.exp(-s.t * 4.5) * .09; E.set(s.ax * a, 0, s.az * a, 'XYZ'); M4.makeRotationFromEuler(E); M2.copy(s.base).multiply(M4); s.mesh.setMatrixAt(s.i, M2); }
      if (!touched.includes(s.mesh)) touched.push(s.mesh);
    }
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
  });

  /* ---------------- the world ---------------- */
  W.onReady(() => {
    const t0 = performance.now();
    W.reseed(703311);                    // the forest does not depend on how much rng earlier modules used
    const terrain = W.terrain || {}, snow = num(terrain.snowLine, SNOW_FALLBACK), waterLevel = num(terrain.waterLevel, -999), hasWater = waterLevel > -100;
    const roads = W.roads && typeof W.roads.distance === 'function' ? W.roads : null;
    buildRoadGrid(roads && Array.isArray(roads.polylines) && roads.polylines.length ? roads.polylines : null);
    buildSolidGrid();
    const ground = (x, z) => num(W.groundY(x, z), 0);
    const slopeAt = (x, z, y) => { const e = 1.2, a = ground(x + e, z) - y, b = ground(x, z + e) - y; return Math.sqrt(a * a + b * b) / e; };

    // Everything the plan reserves (cheap, checked first).
    function blocked(x, z, r) {
      if (hyp(x, z) > OUTER_R - r) return true;
      if (hyp(x - PLAZA.x, z - PLAZA.z) < PLAZA.r + 3 + r) return true;
      if (x > NAME_RECT.x0 - r && x < NAME_RECT.x1 + r && z > NAME_RECT.z0 - r && z < NAME_RECT.z1 + r) return true;
      for (let i = 0; i < PLAN.length; i++) { const p = PLAN[i], dx = x - p[0], dz = z - p[1], m = p[2] + r; if (dx * dx + dz * dz < m * m) return true; }
      if (Math.abs(z - RAIL.z) < RAIL.hw + r && x > RAIL.x0 - r && x < RAIL.x1 + r) return true;
      return false;
    }
    // The same tests as W.isClear (plaza, water, stations, places, roads, solids) on the bucketed data.
    function clearFast(x, z, r) {
      if (hyp(x, z) < 24 + r || W.inWater(x, z)) return false;
      for (const s of W.stations) if (hyp(x - s.x, z - s.z) < s.r + r + 4) return false;
      for (const id in W.places) { const p = W.places[id]; if (hyp(x - p.x, z - p.z) < p.r + r) return false; }
      for (const a of W.reserved || []) if (hyp(x - a.x, z - a.z) < a.r + r) return false; // ground claimed by missions (ramps, lane)
      if (roadNear(x, z, 4.5 + r) || solidNear(x, z, r)) return false;
      return true;
    }

    // Rejection sampling. sample(P) proposes a point, want() a density 0..1 compared with rng, then the plan,
    // spacing, snow line, water, slope and clearance filter; put() writes the instance. Attempts are capped.
    // strict: W.isClear confirms every survivor that becomes a solid (trees, rocks); bushes, grass and
    // reeds rely on clearFast (same tests, bucketed data). fine: use the 1 m hash for mutual spacing.
    const rejects = {}; let isClearCalls = 0;
    function scatter(o) {
      let placed = 0, t = 0; const P = [0, 0], minAbove = o.minAbove == null ? .25 : o.minAbove;
      const rj = rejects[o.name] = { tries: 0, density: 0, plan: 0, spacing: 0, height: 0, slope: 0, clear: 0, isClear: 0, ok: 0, ms: 0 }, ts = performance.now();
      while (placed < o.n && t < o.tries) {
        t++;
        if (!o.sample(P)) continue;
        const x = P[0], z = P[1], R = hyp(x, z);
        const d = o.want(x, z, R); if (d <= 0 || W.rng() > d) { rj.density++; continue; }
        if (blocked(x, z, o.clear)) { rj.plan++; continue; }
        if (!spaced(hash, HG, x, z, o.space) || (o.fine && !spaced(fine, FG, x, z, o.space))) { rj.spacing++; continue; }
        const y = ground(x, z); if (y > snow || (hasWater && y < waterLevel + minAbove)) { rj.height++; continue; }
        if (o.slopeMax && slopeAt(x, z, y) > o.slopeMax) { rj.slope++; continue; }
        if (!clearFast(x, z, o.clear)) { rj.clear++; continue; }
        if (o.strict && hyp(x, z) < DRIVE_R) { isClearCalls++; if (!W.isClear(x, z, o.clear)) { rj.isClear++; continue; } } // exact check only where the tree becomes a solid
        if (o.ok && !o.ok(x, z, y, R)) { rj.ok++; continue; }
        const rr = o.put(x, z, y, R, placed); if (o.fine) occupy(fine, FG, x, z, o.space); else occupy(hash, HG, x, z, typeof rr === 'number' ? rr : o.space); placed++;
      }
      rj.tries = t; rj.ms = Math.round((performance.now() - ts) * 10) / 10; return placed;
    }
    const setInst = (mesh, i, x, y, z, yaw, sx, sy, sz, r, g, b, tx = 0, tz = 0) => {
      E.set(tx, yaw, tz, 'YXZ'); Q.setFromEuler(E); V.set(x, y, z); SC.set(sx, sy, sz); M4.compose(V, Q, SC);
      mesh.setMatrixAt(i, M4); C.setRGB(r, g, b); mesh.setColorAt(i, C);
    };
    const meshes = F.meshes, counts = F.counts; let triangles = 0;
    function finish(name, mesh, n, shadow) {
      mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.castShadow = !!shadow && n > 0; mesh.receiveShadow = true; mesh.name = 'foliage-' + name;
      if (!n) mesh.visible = false; else { W.scene.add(mesh); meshes.push(mesh); triangles += n * mesh.geometry.userData.tris; }
      counts[name] = n;
    }
    // Forest density: hills and lower slopes, in stands and clearings about 20 m across, and much
    // thicker to the north and east. The direction term also biases the candidate angles (below),
    // so attempts are not wasted on the open south and west.
    const pineDir = (x, z, R) => .2 + .8 * sstep(-1, 1, (x - z) / (R * 1.4142));
    const pineWant = (x, z, R) => {
      const zone = sstep(62, 84, R) * (1 - sstep(148, 162, R)); if (zone <= 0) return 0;
      const clump = sstep(.32, .68, noise(x * .045 + 3.1, z * .045 + 7.7));
      return zone * pineDir(x, z, R) * (.08 + .92 * clump);
    };
    // Inverse-CDF table of the direction weight: a biased candidate angle costs two rng calls.
    const ANGLE = new Float32Array(1024);
    { const w = new Float64Array(256); let acc = 0; for (let i = 0; i < 256; i++) { const a = (i + .5) / 256 * 6.2832; w[i] = .2 + .8 * sstep(-1, 1, (Math.cos(a) - Math.sin(a)) / 1.4142); acc += w[i]; }
      let i = 0, c = w[0] / acc; for (let k = 0; k < 1024; k++) { const u = (k + .5) / 1024; while (u > c && i < 255) { i++; c += w[i] / acc; } ANGLE[k] = i / 256 * 6.2832; } }
    const pineSample = P => {
      const a = ANGLE[(W.rng() * 1024) | 0] + W.rng() * .02454, r = Math.sqrt(3600 + W.rng() * (OUTER_R * OUTER_R - 3600));
      P[0] = Math.cos(a) * r; P[1] = Math.sin(a) * r; return true;
    };

    /* ---- larch / pine: trunk + two stacked cones ---- */
    try {
      const geo = new Geo().part(new T.CylinderGeometry(.11, .19, 2.1, 5, 1, true), '#5c4330', mt(0, 1.05, 0))
        .part(new T.ConeGeometry(1.5, 2.7, 7, 1, true), '#3f6a3b', mt(0, 2.8, 0)).part(new T.ConeGeometry(1.05, 2.7, 7, 1, true), '#4b7b42', mt(0, 4.35, 0)).build();
      const N = 1500, mesh = new T.InstancedMesh(geo, material({}), N);
      const n = scatter({
        name: 'pine', n: N, tries: 26000, space: 1.75, clear: 1.0, slopeMax: 1.05, strict: true, sample: pineSample,
        want: (x, z, R) => pineWant(x, z, R) / pineDir(x, z, R),                    // the direction bias is already in the sampling
        ok: (x, z, y) => W.rng() > sstep(snow - 8, snow, y),                      // the tree line thins out
        put: (x, z, y, R, i) => {
          const s = (.75 + .7 * Math.pow(W.rng(), 1.4)) * (1 - .3 * sstep(snow - 12, snow, y)), hy = W.rand(.9, 1.28);
          const t = W.clamp(.5 * noise(x * .07 + 11, z * .07 + 5) + .5 * W.rng(), 0, 1), b = W.rand(.84, 1.08) * (1 - .1 * sstep(12, snow, y));
          setInst(mesh, i, x, y - .1, z, W.rng() * 6.2832, s, s * hy, s, (1.14 - .28 * t) * b, (1.04 - .06 * t) * b, (.8 + .34 * t) * b);
          F.trees.push({ x, z, kind: 'pine', r: 1.5 * s, h: 5.7 * s * hy }); treeSolid(mesh, i, x, z, '#4b7b42');
        }
      });
      finish('pine', mesh, n, true);
    } catch (e) { console.error('foliage: pines failed', e); }

    /* ---- birch: pale trunk + round light canopy, along the river and a few at the lake ---- */
    try {
      const geo = new Geo().part(new T.CylinderGeometry(.08, .15, 2.7, 5, 1, true), '#e3e0d6', mt(0, 1.35, 0))
        .part(new T.IcosahedronGeometry(1.35, 1), '#8fbd5a', mt(0, 3.25, 0, 1, 1.22, 1)).build();
      const N = 260, mesh = new T.InstancedMesh(geo, material({ roughness: .85 }), N);
      const n = scatter({
        name: 'birch', n: N, tries: 7000, space: 1.5, clear: 1.0, slopeMax: .9, minAbove: .35, strict: true,
        sample: P => W.rng() < .85 ? riverSample(P, 5.5, 19) : lakeSample(P, 16.5, 27),
        want: (x, z, R) => R > OUTER_R - 2 ? 0 : .3 + .7 * sstep(.3, .7, noise(x * .06 + 1, z * .06 + 9)),
        put: (x, z, y, R, i) => {
          const s = W.rand(.7, 1.3), hy = W.rand(.9, 1.3), gold = W.rng() < .22, b = W.rand(.9, 1.08);
          const r = gold ? 1.3 : W.rand(.92, 1.06), g = gold ? 1.02 : W.rand(.98, 1.08), bl = gold ? .5 : W.rand(.8, 1.0);
          setInst(mesh, i, x, y - .1, z, W.rng() * 6.2832, s * W.rand(.85, 1.1), s * hy, s * W.rand(.85, 1.1), r * b, g * b, bl * b);
          F.trees.push({ x, z, kind: 'birch', r: 1.4 * s, h: 4.9 * s * hy }); treeSolid(mesh, i, x, z, gold ? '#c9b43a' : '#a3cc63');
        }
      });
      finish('birch', mesh, n, true);
    } catch (e) { console.error('foliage: birches failed', e); }

    /* ---- saxaul: squat dark blobs on the open steppe ---- */
    try {
      const geo = new Geo().part(new T.IcosahedronGeometry(1, 0), '#55673f', mt(0, .42, 0, 1, .62, 1)).part(new T.IcosahedronGeometry(.62, 0), '#5f7347', mt(.6, .32, .3, 1, .72, 1)).build();
      const N = 520, mesh = new T.InstancedMesh(geo, material({}), N);
      const n = scatter({
        name: 'bush', n: N, tries: 9000, space: 1.1, clear: .6, slopeMax: .8, sample: P => annulus(P, 26, 114),
        want: (x, z, R) => { const steppe = 1 - sstep(98, 114, R), patch = sstep(.42, .78, noise(x * .055 + 21, z * .055 + 2)); return steppe * (.08 + .92 * patch) * (1 - .85 * pineWant(x, z, R)); },
        put: (x, z, y, R, i) => {
          const s = W.rand(.5, 1.1), dusty = W.rng(), b = W.rand(.85, 1.1);
          setInst(mesh, i, x, y - .05, z, W.rng() * 6.2832, s, s * W.rand(.8, 1.2), s * W.rand(.8, 1.15), (1 + .18 * dusty) * b, (1 + .04 * dusty) * b, (.92 + .14 * dusty) * b);
        }
      });
      finish('bush', mesh, n, true);
    } catch (e) { console.error('foliage: bushes failed', e); }

    /* ---- rocks: dodecahedra, sparse on the plateau, more on the mountains ---- */
    try {
      const geo = new Geo().part(new T.DodecahedronGeometry(1, 0), '#9aa1a6', mt(0, 0, 0)).build();
      const N = 360, mesh = new T.InstancedMesh(geo, material({ roughness: .95 }), N);
      const n = scatter({
        name: 'rock', n: N, tries: 4000, space: 1.3, clear: 1.0, strict: true, sample: P => annulus(P, 26, OUTER_R),
        want: (x, z, R) => (.16 + .84 * sstep(100, 140, R)) * (.5 + .5 * noise(x * .08 + 2, z * .08 + 44)),
        put: (x, z, y, R, i) => {
          const mtn = sstep(100, 140, R), size = .35 + .6 * Math.pow(W.rng(), 1.6) + mtn * W.rng() * 1.6;
          const sx = size * W.rand(.75, 1.3), sy = size * W.rand(.55, 1), sz = size * W.rand(.75, 1.3), warm = W.rand(-1, 1), b = W.rand(.78, 1.05);
          setInst(mesh, i, x, y - .32 * sy, z, W.rng() * 6.2832, sx, sy, sz, (1 + .07 * warm) * b, b, (1 - .07 * warm) * b, W.rand(-.4, .4), W.rand(-.4, .4));
          const rr = Math.max(sx, sz); F.rocks.push({ x, z, r: rr });
          if (rr * 1.9 > 1) queueSolid(x, z, .85 * rr, 'rock');
          return Math.max(1.3, rr + .3);
        }
      });
      finish('rock', mesh, n, true);
    } catch (e) { console.error('foliage: rocks failed', e); }

    /* ---- grass tufts: thousands on the plateau, no shadows, swaying ---- */
    try {
      const G = new Geo(), cb = new T.Color('#5f8238'), ct = new T.Color('#a8c25c');
      for (let k = 0; k < 4; k++) blade(G, k * 1.5708 + .3 * ((k * 7) % 3 - 1), .075 + .015 * (k % 2), .85 + .15 * (k % 2), .22 + .06 * (k % 3), cb, ct);
      const N = 6500, mesh = new T.InstancedMesh(G.build(), material({ side: T.DoubleSide, roughness: 1 }, .12), N);
      const n = scatter({
        name: 'grass', n: N, tries: 40000, space: .35, clear: 0, fine: true, sample: P => annulus(P, 24, 102),
        want: (x, z, R) => (1 - .5 * sstep(70, 102, R)) * (.55 + .45 * sstep(.3, .75, noise(x * .05 + 31, z * .05 + 17))),
        put: (x, z, y, R, i) => {
          const h = W.rand(.6, 1.15), w = W.rand(.8, 1.3), t = W.clamp(.6 * noise(x * .03 + 5, z * .03 + 41) + .4 * W.rng(), 0, 1), b = W.rand(.9, 1.1);
          setInst(mesh, i, x, y - .06, z, W.rng() * 6.2832, w, h, w, (.95 + .3 * t) * b, (1 + .06 * t) * b, (.9 - .3 * t) * b, W.rand(-.1, .1), W.rand(-.1, .1));
        }
      });
      finish('grass', mesh, n, false);
    } catch (e) { console.error('foliage: grass failed', e); }

    /* ---- reeds: tall clumps with brown seed heads at the water line ---- */
    try {
      const G = new Geo(), cb = new T.Color('#6f8a46'), ct = new T.Color('#aab46a'), ch = new T.Color('#7a5a3a');
      for (let k = 0; k < 4; k++) { const yaw = k * 1.5708 + .4 * (k % 2), lean = .09 + .03 * (k % 3), h = k < 3 ? .86 : 1; blade(G, yaw, .03, h, lean, cb, ct); if (k < 3) head(G, yaw, lean, .84, 1.02, .035, ch); }
      const N = 900, mesh = new T.InstancedMesh(G.build(), material({ side: T.DoubleSide, roughness: 1 }, .09), N);
      const n = scatter({
        name: 'reed', n: N, tries: 9000, space: .45, clear: .3, minAbove: -.02, fine: true,
        sample: P => W.rng() < .6 ? riverSample(P, 4.4, hasWater ? 11.5 : 7.4) : lakeSample(P, 15, hasWater ? 21.5 : 18.6),
        want: (x, z, R) => R > OUTER_R - 1 ? 0 : .55 + .45 * sstep(.3, .7, noise(x * .12 + 7, z * .12 + 3)),
        ok: (x, z, y) => !hasWater || y < waterLevel + 1.4,                      // only the strip just above the water
        put: (x, z, y, R, i) => {
          const h = W.rand(1.4, 2.3), w = W.rand(.8, 1.3), t = W.rng(), b = W.rand(.88, 1.08);
          setInst(mesh, i, x, y - .05, z, W.rng() * 6.2832, w, h, w, (1 + .12 * t) * b, (1 + .02 * t) * b, (.92 - .12 * t) * b);
        }
      });
      finish('reed', mesh, n, false);
    } catch (e) { console.error('foliage: reeds failed', e); }

    for (const p of pending) { const s = W.solid(p.x, p.z, p.r, p.tag); if (p.onHit) s.onHit = p.onHit; }
    F.nearestTree = (x, z) => { let best = null, bd = 1e9; for (const t of F.trees) { const d = hyp(t.x - x, t.z - z); if (d < bd) { bd = d; best = t; } } return best ? Object.assign({ d: bd }, best) : null; };
    F.ready = true;
    F.stats = { ms: Math.round((performance.now() - t0) * 10) / 10, counts: Object.assign({}, counts), triangles, drawCalls: meshes.length, shadowCasters: meshes.filter(m => m.castShadow).length,
      solids: pending.length, isClearCalls, rejects, roadsFrom: roads && roads.polylines && roads.polylines.length ? 'roads.polylines' : 'plan' };
  });
})();
