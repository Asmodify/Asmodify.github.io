/* terrain.js — the ground: heightfield, low-poly mesh with per-face colours, water, mountains.
   W.terrain is assigned at load time (other modules read heights in their ready hooks);
   the meshes are built in W.onReady. See CONTRACT.md for the world plan this follows. */
(() => {
  const W = window.W; if (!W) return;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ---------------- constants from the world plan ---------------- */
  const SIZE = 340, DRIVE_R = 118, WATER = -1.2, SNOW = 30;
  // Flat pads: blended to their height over `b` metres beyond radius `r`.
  const PADS = [
    { id: 'plaza', x: 0, z: 6, r: 24, y: 0, b: 8 },
    { id: 'opent', x: -28, z: -2, r: 5, y: 0, b: 8 }, { id: 'fuel', x: 26, z: -4, r: 5, y: 0, b: 8 },
    { id: 'senti', x: -22, z: 26, r: 5, y: 0, b: 8 }, { id: 'about', x: 24, z: 28, r: 5, y: 0, b: 8 },
    { id: 'town', x: 28, z: -100, r: 22, y: 1, b: 12 }, { id: 'mine', x: 92, z: 42, r: 18, y: 2, b: 10 },
    { id: 'powerplant', x: -86, z: -26, r: 16, y: 1, b: 10 }, { id: 'busTerminal', x: 62, z: -22, r: 12, y: .5, b: 11 },
    { id: 'railStation', x: 6, z: 98, r: 14, y: 0, b: 8 }
  ];
  const RAIL = { z: 94, x0: -122, x1: 122, hw: 5, y: 0, b: 8 };
  // River centreline (plan points, extended past the mesh so the gorge leaves the map).
  const RIVER = [[-200, -51], [-130, -58], [-70, -64], [-20, -74], [30, -78], [80, -70], [130, -82], [200, -99]];
  const RIVER_SEG = []; for (let i = 0; i < RIVER.length - 1; i++) { const [ax, az] = RIVER[i], [bx, bz] = RIVER[i + 1]; const dx = bx - ax, dz = bz - az; RIVER_SEG.push({ ax, az, dx, dz, l2: dx * dx + dz * dz }); }
  const LAKE = { x: -92, z: 52, r: 15 };
  // Road corridors from the plan: hills are damped along them so the spurs are not roller coasters.
  const CORR = [[0, -44, 18, -76], [18, -76, 28, -100], [56, 8, 92, 42], [2, 56, 6, 98], [-58, 6, -86, -26], [-40, 46, -70, 78], [-58, 6, -92, 52]]
    .map(([ax, az, bx, bz]) => { const dx = bx - ax, dz = bz - az; return { ax, az, dx, dz, l2: dx * dx + dz * dz }; });

  const segDist = (s, x, z) => { let t = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.l2; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = s.ax + s.dx * t - x, ez = s.az + s.dz * t - z; return Math.sqrt(ex * ex + ez * ez); };

  /* ---------------- noise: value noise on a cached permutation ---------------- */
  const P = new Uint8Array(512), V = new Float32Array(512);
  {
    const p = []; for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(W.rng() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) { P[i] = p[i & 255]; V[i] = W.rng(); }
  }
  // Smooth value noise in [-1, 1].
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y); const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const X = xi & 255, Y = yi & 255, a = P[X] + Y, b = P[X + 1] + Y;
    const v00 = V[P[a]], v10 = V[P[b]], v01 = V[P[a + 1]], v11 = V[P[b + 1]];
    const n0 = v00 + (v10 - v00) * u, n1 = v01 + (v11 - v01) * u;
    return 2 * (n0 + (n1 - n0) * v) - 1;
  }
  const C1 = Math.cos(.7), S1 = Math.sin(.7);
  // Two or three octaves, each rotated so lattice lines never line up.
  function fbm(x, y, oct) {
    let s = vnoise(x, y), amp = .5;
    let rx = x * C1 - y * S1, ry = x * S1 + y * C1;
    s += amp * vnoise(rx * 2.03 + 11.7, ry * 2.03 + 5.3);
    if (oct > 2) { amp *= .5; const qx = rx * C1 - ry * S1, qy = rx * S1 + ry * C1; s += amp * vnoise(qx * 4.1 + 3.1, qy * 4.1 + 9.2); }
    return s / (oct > 2 ? 1.75 : 1.5);
  }
  const ridge = (x, y) => { const a = 1 - Math.abs(vnoise(x, y)); return a * a; };

  /* ---------------- mountain peaks (deterministic, placed once) ---------------- */
  const PEAKS = [];
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2 + W.rand(-.12, .12), rr = W.rand(146, 168); PEAKS.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, h: W.rand(14, 28), R: W.rand(26, 42) }); }
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2 + W.rand(-.2, .2), rr = W.rand(215, 275); PEAKS.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, h: W.rand(22, 44), R: W.rand(45, 75) }); }
  for (const p of PEAKS) p.R2 = p.R * p.R;

  /* ---------------- the height field ---------------- */
  // sample() fills `out` with h (height), wet (0..1 near water), pad (0..1 flattened), m (0..1 mountain).
  const S = { h: 0, wet: 0, pad: 0, m: 0 }, PD = new Float64Array(PADS.length);
  function sample(x, z, out) {
    out.wet = 0; out.pad = 0;
    if (!(x === x && z === z)) { out.h = 0; out.m = 0; return out; } // NaN guard
    const r = Math.sqrt(x * x + z * z);

    // gentle inner plateau: long wavelengths, amplitude ramps up from the plaza outward
    const pa = sstep(18, 62, r);
    let h = pa * (1.5 * fbm(x * .0095 + 3.7, z * .0095 + 1.9, 2) + .25 * vnoise(x * .021 + 9.1, z * .021 + 4.4));

    // pad distances (used twice: a wide halo that damps the hills, then the flattening itself)
    let halo = 0;
    for (let i = 0; i < PADS.length; i++) {
      const p = PADS[i], dx = x - p.x, dz = z - p.z, d = PD[i] = Math.sqrt(dx * dx + dz * dz);
      if (d < p.r + p.b + 22) { const hl = 1 - sstep(p.r + p.b * .5, p.r + p.b + 22, d); if (hl > halo) halo = hl; }
    }

    // rolling hills 60..118 m, damped along road corridors and around pads
    const hw = sstep(58, 90, r);
    if (hw > 0) {
      const hills = 8.5 * Math.pow(.5 + .5 * fbm(x * .0165 + 1.3, z * .0165 + 7.7, 3), 1.35);
      let cmax = 0; for (let i = 0; i < CORR.length; i++) { const c = 1 - sstep(5, 18, segDist(CORR[i], x, z)); if (c > cmax) cmax = c; }
      h += hills * hw * (1 - cmax * .65) * (1 - halo * .7);
    }

    // mountains: steep rise from 114 m, ridged noise + a ring of deliberate peaks
    const m = sstep(114, 152, r); out.m = m;
    if (m > 0) {
      let mh = 12 + 24 * (ridge(x * .019 + 2.2, z * .019 + 5.5) * .72 + ridge(x * .047 + 8.8, z * .047 + 1.1) * .28);
      mh += 8 * sstep(172, 240, r);
      for (let i = 0; i < PEAKS.length; i++) { const p = PEAKS[i], dx = x - p.x, dz = z - p.z, d2 = dx * dx + dz * dz; if (d2 < p.R2) { const t = 1 - Math.sqrt(d2) / p.R; mh += p.h * t * Math.sqrt(t); } }
      h += m * mh;
    }

    // pads: circles flattened to their height, blended over b metres
    let padW = 0;
    for (let i = 0; i < PADS.length; i++) {
      const p = PADS[i], d = PD[i];
      if (d < p.r + p.b) { const w = 1 - sstep(p.r, p.r + p.b, d); h = lerp(h, p.y, w); if (w > padW) padW = w; }
    }
    // the railway strip along z = 94: a flat capsule, wider walls where it cuts the mountains
    {
      const cx = clamp(x, RAIL.x0, RAIL.x1), ex = x - cx, ez = z - RAIL.z, d = Math.sqrt(ex * ex + ez * ez);
      const b = RAIL.b + 14 * m;
      if (d < RAIL.hw + b) { const w = 1 - sstep(RAIL.hw, RAIL.hw + b, d); h = lerp(h, RAIL.y, w); if (w > padW) padW = w; }
    }
    out.pad = padW;

    // river: a U-shaped bed below water level, banks that widen into a gorge through the mountains
    if (z > -132 && z < -18) {
      let d = 1e9; for (let i = 0; i < RIVER_SEG.length; i++) { const e = segDist(RIVER_SEG[i], x, z); if (e < d) d = e; }
      const bank = 7 + 22 * m;
      if (d < 4.5 + bank) {
        const u = d < 4.5 ? d / 4.5 : 1, inner = -2.6 + .4 * u * u;
        const t = sstep(4.5, 4.5 + bank, d);
        h = lerp(inner, h, t); out.wet = 1 - t;
      }
    }
    // lake: a bowl to -3 m with a soft shore
    {
      const dx = x - LAKE.x, dz = z - LAKE.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < 30) {
        const inner = -3 + 1.8 * sstep(5, 16, d);
        const t = sstep(16, 28, d);
        h = lerp(inner, h, t); const wet = 1 - sstep(14, 25, d); if (wet > out.wet) out.wet = wet;
      }
    }
    out.h = h; return out;
  }
  const height = (x, z) => sample(x, z, S).h;
  let riverDistSlow = (x, z) => { let d = 1e9; for (let i = 1; i < RIVER_SEG.length - 1; i++) { const e = segDist(RIVER_SEG[i], x, z); if (e < d) d = e; } return d; };

  /* ---------------- colours ---------------- */
  const col = hex => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
  const GRASS_A = col('#a9b878'), GRASS_B = col('#8ca95c'), GRASS_DRY = col('#c3b97f'), DIRT = col('#cbbd94'), BED = col('#b3a677');
  const SCREE = col('#9c9f7c'), ROCK = col('#a9aeb1'), ROCK_DARK = col('#868d93'), SNOWC = col('#f6f8fb'), PADC = col('#d9d0a8');
  const tmpC = [0, 0, 0];
  const mix3 = (c, b, t) => { c[0] += (b[0] - c[0]) * t; c[1] += (b[1] - c[1]) * t; c[2] += (b[2] - c[2]) * t; };
  // Colour at a point. slope = tan(angle), jitter in [0,1) brightens/darkens a little (per face).
  function colorAt(x, z, h, slope, wet, pad, jitter, out) {
    const c = out || tmpC;
    const r = Math.sqrt(x * x + z * z);
    const tone = .5 + .5 * vnoise(x * .018 + 7.3, z * .018 + 2.1);            // 55 m patches: sage <-> green
    const patch = vnoise(x * .075 + 4.4, z * .075 + 8.8);                     // 13 m patches: brightness
    c[0] = GRASS_A[0]; c[1] = GRASS_A[1]; c[2] = GRASS_A[2]; mix3(c, GRASS_B, tone * .8);
    mix3(c, GRASS_DRY, clamp((h - 1.5) / 7, 0, 1) * .5 + sstep(70, 118, r) * .3);
    mix3(c, SCREE, sstep(8, 17, h));
    mix3(c, ROCK, sstep(15, 26, h));
    mix3(c, ROCK_DARK, sstep(.6, 1.3, slope) * .8);
    if (wet > 0) mix3(c, DIRT, wet * (1 - sstep(.2, 2.2, h)));
    if (h < WATER + .2) mix3(c, BED, .85);
    const sl = SNOW + 2.5 * vnoise(x * .05 + 1.5, z * .05 + 6.2);
    const st = sstep(sl - 2.5, sl + 1, h) * (1 - sstep(1.1, 1.8, slope)); if (st > 0) mix3(c, SNOWC, st);
    if (pad > 0) mix3(c, PADC, pad * .4);
    const f = 1 + (jitter - .5) * .045 + patch * .035; c[0] = clamp(c[0] * f, 0, 1); c[1] = clamp(c[1] * f, 0, 1); c[2] = clamp(c[2] * f, 0, 1);
    return c;
  }
  const hex2 = v => { const s = Math.round(clamp(v, 0, 1) * 255).toString(16); return s.length < 2 ? '0' + s : s; };
  const hash2 = (i, j) => { let n = (i * 73856093) ^ (j * 19349663); n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967296; };

  /* ---------------- public API (load time) ---------------- */
  const terrain = W.terrain = {
    size: SIZE, driveRadius: DRIVE_R, waterLevel: WATER, snowLine: SNOW,
    height,
    isWater: (x, z) => height(x, z) < WATER,
    normal: (x, z) => { const e = .75, hx = height(x + e, z) - height(x - e, z), hz = height(x, z + e) - height(x, z - e); return new W.T.Vector3(-hx, 2 * e, -hz).normalize(); },
    // tan of the slope angle at (x,z)
    slope: (x, z) => { const e = .75, hx = height(x + e, z) - height(x - e, z), hz = height(x, z + e) - height(x, z - e); return Math.sqrt(hx * hx + hz * hz) / (2 * e); },
    // full sample: {h, wet, pad, m}; pass your own object to avoid allocation
    sample: (x, z, out) => sample(x, z, out || { h: 0, wet: 0, pad: 0, m: 0 }),
    // 0..1 how much (x,z) belongs to the mountain zone
    mountain: (x, z) => sstep(114, 152, Math.sqrt(x * x + z * z)),
    // distance to the river centreline / the lake centre, for foliage (reeds, birches) and roads
    riverDist: (x, z) => riverDistSlow(x, z),
    lakeDist: (x, z) => Math.sqrt((x - LAKE.x) * (x - LAKE.x) + (z - LAKE.z) * (z - LAKE.z)),
    river: RIVER.slice(1, -1).map(([x, z]) => ({ x, z })), lake: { x: LAKE.x, z: LAKE.z, r: LAKE.r }, pads: PADS.map(p => ({ ...p })), rail: { ...RAIL },
    color: (x, z) => {
      const o = sample(x, z, S); const h = o.h, wet = o.wet, pad = o.pad;
      if (h < WATER) { const deep = sstep(WATER, WATER - 1.6, h); return deep > .5 ? '#3f7fb0' : '#5e9cc6'; }
      const c = colorAt(x, z, h, terrain.slope(x, z), wet, pad, .5, tmpC);
      return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
    }
  };

  /* ---------------- meshes ---------------- */
  W.onReady(() => {
    const T = W.T, scene = W.scene, t0 = performance.now();

    // Builds a non-indexed grid (flat per-face colours) over [x0,x1]x[z0,z1] with cell size `cs`,
    // skipping cells whose centre lies inside `hole` (half-size), lowered by `drop` metres.
    function buildGrid(x0, z0, x1, z1, cs, hole, drop) {
      const nx = Math.round((x1 - x0) / cs), nz = Math.round((z1 - z0) / cs);
      const H = new Float32Array((nx + 1) * (nz + 1)), WET = new Float32Array(H.length), PAD = new Float32Array(H.length);
      const o = { h: 0, wet: 0, pad: 0, m: 0 };
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) { const k = j * (nx + 1) + i; sample(x0 + i * cs, z0 + j * cs, o); H[k] = o.h - drop; WET[k] = o.wet; PAD[k] = o.pad; }
      let cells = 0;
      const inHole = (i, j) => hole > 0 && Math.abs(x0 + (i + .5) * cs) < hole && Math.abs(z0 + (j + .5) * cs) < hole;
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (!inHole(i, j)) cells++;
      const pos = new Float32Array(cells * 18), colr = new Float32Array(cells * 18);
      let w = 0; const c = [0, 0, 0];
      const put = (ia, ib, ic, ja, jb, jc) => {
        // vertices (ia,ja) (ib,jb) (ic,jc), counter-clockwise seen from above
        const ka = ja * (nx + 1) + ia, kb = jb * (nx + 1) + ib, kc = jc * (nx + 1) + ic;
        const ax = x0 + ia * cs, az = z0 + ja * cs, bx = x0 + ib * cs, bz = z0 + jb * cs, cx = x0 + ic * cs, cz = z0 + jc * cs;
        const ay = H[ka], by = H[kb], cy = H[kc];
        // face normal for the slope
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
        const slope = Math.sqrt(nX * nX + nZ * nZ) / Math.max(1e-6, nY);
        const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3, mh = (ay + by + cy) / 3 + drop;
        colorAt(mx, mz, mh, slope, (WET[ka] + WET[kb] + WET[kc]) / 3, (PAD[ka] + PAD[kb] + PAD[kc]) / 3, hash2(ia * 3 + ib, ja * 5 + jc + 977), c);
        pos[w] = ax; pos[w + 1] = ay; pos[w + 2] = az; pos[w + 3] = bx; pos[w + 4] = by; pos[w + 5] = bz; pos[w + 6] = cx; pos[w + 7] = cy; pos[w + 8] = cz;
        for (let q = 0; q < 9; q += 3) { colr[w + q] = c[0]; colr[w + q + 1] = c[1]; colr[w + q + 2] = c[2]; }
        w += 9;
      };
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        if (inHole(i, j)) continue;
        if (hash2(i, j) < .5) { put(i, i, i + 1, j, j + 1, j); put(i + 1, i, i + 1, j, j + 1, j + 1); }
        else { put(i, i + 1, i + 1, j, j + 1, j); put(i, i, i + 1, j, j + 1, j + 1); }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(colr, 3));
      g.computeVertexNormals(); g.computeBoundingSphere();
      return g;
    }

    const groundMat = new T.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: .96, metalness: 0 });
    try {
      const half = SIZE / 2;
      const ground = new T.Mesh(buildGrid(-half, -half, half, half, 2, 0, 0), groundMat);
      ground.receiveShadow = true; ground.name = 'terrain'; scene.add(ground); terrain.mesh = ground;
    } catch (e) { console.error('terrain mesh failed', e); }
    try {
      // Mountain rim beyond the main mesh: coarser cells, overlapping the plane's edge (lowered 2 m
      // so the fine mesh wins where they overlap and no crack shows along the seam).
      const rim = new T.Mesh(buildGrid(-300, -300, 300, 300, 5, 160, 2), groundMat);
      rim.name = 'rim'; scene.add(rim); terrain.rim = rim;
    } catch (e) { console.error('terrain rim failed', e); }
    terrain.buildMs = Math.round(performance.now() - t0);

    /* ---------- water: one plane with a slow shimmer, fresnel and a sun glint ---------- */
    try {
      const uniforms = T.UniformsUtils.merge([T.UniformsLib.fog, {
        time: { value: 0 }, night: { value: 0 },
        deep: { value: new T.Color('#3b7aad') }, shallow: { value: new T.Color('#6fb1d8') }, glint: { value: new T.Color('#eaf6ff') },
        sunDir: { value: new T.Vector3(20, 40, 12).normalize() }
      }]);
      const waterMat = new T.ShaderMaterial({
        uniforms, transparent: true, depthWrite: false, fog: true,
        vertexShader: `
          uniform float time; varying vec3 vW; varying float vFogDepth;
          void main() {
            vec3 p = position;
            p.y += 0.05 * sin(p.x * 0.23 + time * 0.8) * sin(p.z * 0.19 - time * 0.6) + 0.03 * sin((p.x - p.z) * 0.11 + time * 0.45);
            vec4 wp = modelMatrix * vec4(p, 1.0); vW = wp.xyz;
            vec4 mv = viewMatrix * wp; vFogDepth = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform float time, night; uniform vec3 deep, shallow, glint, sunDir;
          uniform vec3 fogColor; uniform float fogNear, fogFar;
          varying vec3 vW; varying float vFogDepth;
          void main() {
            vec3 vd = normalize(cameraPosition - vW);
            float fres = pow(1.0 - max(vd.y, 0.0), 2.5);
            // slow drifting shimmer: thin warped lines in two directions plus soft patches, no regular grid
            float wz = 2.4 * sin(vW.z * 0.17 + time * 0.22) + 1.3 * sin(vW.x * 0.09 - time * 0.13);
            float wx = 2.2 * sin(vW.x * 0.15 - time * 0.19) + 1.1 * sin(vW.z * 0.08 + time * 0.11);
            float l1 = 1.0 - abs(sin(vW.x * 0.42 + wz + time * 0.35));
            float l2 = 1.0 - abs(sin(vW.z * 0.38 + wx - time * 0.3));
            // break the lines into short drifting dashes
            float seg = sin(vW.x * 0.55 + wx * 0.8 + time * 0.3) * sin(vW.z * 0.6 + wz * 0.7 - time * 0.25);
            float lines = (smoothstep(0.94, 1.0, l1) * 0.55 + smoothstep(0.95, 1.0, l2) * 0.45) * smoothstep(0.15, 0.7, seg);
            float blotch = smoothstep(0.3, 1.0, sin(vW.x * 0.11 + wz * 0.5 + time * 0.2) * sin(vW.z * 0.1 + wx * 0.5 - time * 0.17));
            // sun glint on a wobbling normal
            vec3 n = normalize(vec3(0.05 * sin(vW.x * 0.5 + wz + time), 1.0, 0.05 * cos(vW.z * 0.45 + wx - time * 0.8)));
            vec3 h = normalize(sunDir + vd);
            float spec = pow(max(dot(n, h), 0.0), 90.0) * (1.0 - night * 0.75);
            vec3 c = mix(deep, shallow, 0.3 + 0.5 * fres + 0.12 * blotch);
            c += glint * (lines * 0.28 + spec * 0.6) * (1.0 - night * 0.6);
            float a = 0.84 + 0.1 * fres;
            float f = smoothstep(fogNear, fogFar, vFogDepth);
            gl_FragColor = vec4(mix(c, fogColor, f), a);
          }`
      });
      const wg = new T.PlaneGeometry(600, 600, 48, 48); wg.rotateX(-Math.PI / 2);
      const water = new T.Mesh(wg, waterMat); water.position.y = WATER; water.renderOrder = 1; water.name = 'water';
      scene.add(water); terrain.water = water;
      const dayDeep = new T.Color('#3b7aad'), dayShallow = new T.Color('#6fb1d8'), nightDeep = new T.Color('#0f2238'), nightShallow = new T.Color('#1d3a5c');
      W.onUpdate((dt, now) => { uniforms.time.value = now / 1000; });
      W.onNight(on => { uniforms.night.value = on ? 1 : 0; uniforms.deep.value.copy(on ? nightDeep : dayDeep); uniforms.shallow.value.copy(on ? nightShallow : dayShallow); });
    } catch (e) {
      console.error('water failed', e);
      try { const wg = new T.PlaneGeometry(600, 600); wg.rotateX(-Math.PI / 2); const water = new T.Mesh(wg, new T.MeshStandardMaterial({ color: '#3b7aad', roughness: .4, transparent: true, opacity: .88 })); water.position.y = WATER; scene.add(water); } catch (e2) { }
    }
  });
})();
