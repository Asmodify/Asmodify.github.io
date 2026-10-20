/* missions.js — the playable layer. A mission board (the Missions chip, or E at the Open T depot)
   offers delivery runs, the Steppe Rally, a GPS tracker hunt, Big Air ramps, steppe bowling and a
   fuel-theft chase. One mission at a time, a HUD card with objective and timer, minimap markers,
   the guide arrow, best results in localStorage under khuslen.world.*. All geometry is procedural
   low-poly (one merged, vertex-coloured mesh per thing) so the layer costs ~16 draw calls at rest.
   Everything goes through W and survives every other module being stubbed. See CONTRACT.md. */
(() => {
  const W = window.W; if (!W || !W.T) return;
  const T = W.T, PI = Math.PI, hyp = Math.hypot;

  /* ---------------- small helpers ---------------- */
  const KEY = 'khuslen.world.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { } }
  };
  const num = (v, d = 0) => typeof v === 'number' && isFinite(v) ? v : d;
  const fmt = s => { s = Math.max(0, num(s)); const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const G = (x, z) => num(W.groundY(x, z));
  const car = W.car;
  const unit = (x, z) => { const l = hyp(x, z) || 1; return { x: x / l, z: z / l }; };
  const flat = (x, z, r) => { let lo = 1e9, hi = -1e9; for (const dx of [-r, 0, r]) for (const dz of [-r, 0, r]) { const y = G(x + dx, z + dz); if (y < lo) lo = y; if (y > hi) hi = y; } return hi - lo; };
  const clearOfSolids = (x, z, m) => { for (const s of W.solids) if (hyp(x - num(s.x), z - num(s.z)) < num(s.r) + m) return false; return true; };
  const driveR = () => num(W.terrain && W.terrain.driveRadius, 118);
  const isClear = (x, z, r) => { try { return !!W.isClear(x, z, r); } catch (e) { return true; } };
  const wet = (x, z) => { try { return !!W.inWater(x, z); } catch (e) { return false; } };
  const YEL = '#f7bd0c', BLU = '#1f4fd1', INK = '#1c1b19', RED = '#d2473b', ASPH = '#3a3d42', STEEL = '#9da5ad', PALE = '#f6f7f3';

  /* ---------------- procedural kit: quads with flat normals and a colour per vertex ---------------- */
  const colCache = new Map();
  const rgb = hex => { let c = colCache.get(hex); if (!c) { const k = new T.Color(hex); c = [k.r, k.g, k.b]; colCache.set(hex, c); } return c; };
  const VC = new T.MeshStandardMaterial({ vertexColors: true, roughness: .85, metalness: 0 });
  class Sink {
    constructor() { this.pos = []; this.nor = []; this.col = []; this.m = null; this.tris = 0; }
    frame(x, y, z, ry = 0) { this.m = ry || x || y || z ? new T.Matrix4().makeRotationY(ry).setPosition(x, y, z) : null; return this; }
    _p(p) { const m = this.m; if (!m) return p; const e = m.elements; return [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]]; }
    tri(A, B, C, hex) {
      A = this._p(A); B = this._p(B); C = this._p(C);
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = hyp(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const c = rgb(hex);
      this.pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
      for (let i = 0; i < 3; i++) { this.nor.push(nx, ny, nz); this.col.push(c[0], c[1], c[2]); }
      this.tris++;
    }
    quad(A, B, C, D, hex) { this.tri(A, B, C, hex); this.tri(A, C, D, hex); }
    tri2(A, B, C, hex) { this.tri(A, B, C, hex); this.tri(A, C, B, hex); } // two-sided (pennants)
    box(w, h, d, x, y, z, hex) { // centre (x, y, z) in the current frame
      const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2, z0 = z - d / 2, z1 = z + d / 2;
      this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], hex); this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], hex);
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], hex); this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], hex);
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], hex); this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], hex);
    }
    // lathe: profile [[r, along, hex], ...] bottom to top, around an axis ('y' | 'x' | 'z') through (x, y, z)
    lathe(prof, seg, x, y, z, axis = 'y') {
      const P = (r, a, t) => { const u = Math.cos(t) * r, v = Math.sin(t) * r; return axis === 'x' ? [x + a, y + v, z + u] : axis === 'z' ? [x + v, y + u, z + a] : [x + u, y + a, z + v]; };
      for (let i = 0; i < prof.length - 1; i++) {
        const r0 = prof[i][0], a0 = prof[i][1], hex = prof[i][2] || prof[i + 1][2], r1 = prof[i + 1][0], a1 = prof[i + 1][1];
        for (let k = 0; k < seg; k++) {
          const t0 = k / seg * PI * 2, t1 = (k + 1) / seg * PI * 2;
          if (r0 < 1e-4) this.tri(P(r0, a0, t0), P(r1, a1, t0), P(r1, a1, t1), hex);
          else if (r1 < 1e-4) this.tri(P(r0, a0, t0), P(r1, a1, t0), P(r0, a0, t1), hex);
          else this.quad(P(r0, a0, t1), P(r0, a0, t0), P(r1, a1, t0), P(r1, a1, t1), hex);
        }
      }
    }
    geometry() { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(this.nor, 3)); g.setAttribute('color', new T.Float32BufferAttribute(this.col, 3)); g.computeBoundingSphere(); return g; }
    mesh(mat, name) { const m = new T.Mesh(this.geometry(), mat || VC); m.castShadow = m.receiveShadow = true; if (name) m.name = name; return m; }
  }

  /* ---------------- state shared by the missions ---------------- */
  const SP = { ramps: [], lane: null, pins: [], trackers: [], rally: null, bay: { x: -28, z: 9 }, drops: {} }; // placements, exposed for tests
  let act = null, outro = 0, lastHud = '';
  const marks = [];
  const mark = (x, z, color, big) => { const m = { x, z, color, big: !!big }; W.markers.push(m); marks.push(m); return m; };
  const clearMarks = () => { for (const m of marks) { const i = W.markers.indexOf(m); if (i >= 0) W.markers.splice(i, 1); } marks.length = 0; };
  const rings = {};
  const ringAt = (id, x, z, color) => { const r = rings[id]; if (!r) return; r.visible = true; r.position.set(x, G(x, z) + .03, z); r.material.color.set(color); };
  const hideRings = () => { for (const k in rings) if (k !== 'bay') rings[k].visible = false; };
  let speedBefore = 0; // |v| at the end of the previous frame: what the truck hit a solid with
  const pinState = { hit: false, hitT: -1, bodies: [], mesh: null, dirty: false };
  const trk = { body: null, led: null, ledMat: null, pts: [], found: [], visible: false };
  const van = { mesh: null, solid: null, path: null, d: 0, x: 0, z: 0, caught: false, active: false };
  const air = { rampOf: () => -1 };
  const cargoBuilders = {};
  let dropped = []; // {mesh, t}

  /* ---------------- bowling pins ---------------- */
  function resetPins() { for (const b of pinState.bodies) { try { W.resetBody(b); } catch (e) { } } pinState.hit = false; pinState.hitT = -1; pinState.dirty = true; }
  const pinDown = b => { const p = b.mesh.position, h = b.home; if (hyp(p.x - h.x, p.z - h.z) > .6) return true; const up = new T.Vector3(0, 1, 0).applyQuaternion(b.mesh.quaternion); return up.y < .7; };
  const pinsDown = () => pinState.bodies.reduce((n, b) => n + (pinDown(b) ? 1 : 0), 0);

  /* ================================================================
     WORLD BUILD (ready hook: every other module has placed its things)
     ================================================================ */
  W.onReady(() => {
    W.reseed(9102026);
    try { buildBay(); } catch (e) { console.warn('missions: bay', e); }
    try { buildLane(); } catch (e) { console.warn('missions: lane', e); }   // the lane needs the biggest flat patch, so it picks first
    try { buildRamps(); } catch (e) { console.warn('missions: ramps', e); }
    try { buildTrackers(); } catch (e) { console.warn('missions: trackers', e); }
    try { buildGates(); } catch (e) { console.warn('missions: gates', e); }
    try { buildVan(); } catch (e) { console.warn('missions: van', e); }
    try { buildRings(); } catch (e) { console.warn('missions: rings', e); }
    try { for (const r of ROUTES) SP.drops[r.id] = dropPoint(placeOf(r), r.to); } catch (e) { console.warn('missions: drops', e); }
    try { reserveSpots(); } catch (e) { console.warn('missions: reserve', e); }
    MS.ready = true;
  });

  // Claim the ground under the lane, ramps, trackers and bay so foliage (whose ready hook runs later) keeps off it.
  function reserveSpots() {
    if (!W.reserve) return;
    if (SP.lane) { const L = SP.lane; W.reserve(L.x + L.f.x * 2, L.z + L.f.z * 2, 15, 'lane'); W.reserve(L.x - L.f.x * 19, L.z - L.f.z * 19, 6, 'lane'); }
    for (const r of SP.ramps) { const fx = Math.sin(r.h), fz = Math.cos(r.h); W.reserve(r.x, r.z, 10, 'ramp'); for (const k of [-15, 15]) W.reserve(r.x + fx * k, r.z + fz * k, 6, 'ramp'); }
    for (const t of SP.trackers) W.reserve(t.x, t.z, 2.5, 'tracker');
    W.reserve(SP.bay.x, SP.bay.z, 6, 'bay');
    for (const id in SP.drops) { const d = SP.drops[id]; if (d) W.reserve(d.x, d.z, 3, 'drop'); }
  }

  /* ---- loading bay at the depot: a painted apron and a blue ring south of the Open T station ---- */
  function buildBay() {
    const b = SP.bay, y = G(b.x, b.z);
    const tex = W.textTex(['LOADING BAY', 'Open T · cargo · ачаа'], { w: 1024, h: 300, font: '800 128px Archivo', sub: '500 44px "IBM Plex Mono"' });
    const d = W.decal(tex, 7, 2.05); d.position.set(b.x, y + .04, b.z); d.name = 'ms-bay'; W.scene.add(d);
    const S = new Sink(); // four yellow corner marks
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { S.box(1.2, .05, .22, b.x + sx * 3.6, y + .03, b.z + sz * 2.6 - sz * .1, YEL); S.box(.22, .05, 1.2, b.x + sx * 3.6 - sx * .1, y + .03, b.z + sz * 2.6, YEL); }
    const m = S.mesh(VC, 'ms-baymarks'); m.castShadow = false; W.scene.add(m);
  }

  /* ---- Big Air: three kicker ramps, 6 m wide, 10 m long, 2.2 m high; mesh plus a drivable surface ---- */
  const RAMP = { L: 10, Wd: 6, H: 2.2, K: 1.7 };
  const rampH = u => RAMP.H * Math.pow(W.clamp(u, 0, 1), RAMP.K);
  const RAMP_CANDS = [ // [x, z, heading]; heading = direction of travel up the ramp (forward = (sin h, cos h))
    [[14, -30, -PI / 2], [15, -30, -PI / 2], [16, -28, -PI / 2], [12, -31, -PI / 2]],                       // north steppe inside the ring, jump west over the plaza track
    [[2, 36, PI / 2], [0, 38, PI / 2], [0, 42, PI / 2], [-4, 36, PI / 2], [4, 34, PI / 2], [0, 44, PI / 2]], // south steppe inside the ring, jump east
    [[-46, 12, PI], [-47, 14, PI], [-45, 10, PI], [-46, 6, PI], [-48, 16, PI], [-44, 14, PI], [-46, 2, PI], [46, -48, -PI / 2], [48, -50, -PI / 2], [-16, -28, -PI / 2], [-24, -26, -PI / 2]] // west inside the ring, jump north; else north-east steppe
  ];
  function rampOk(x, z, h, strict) {
    const f = { x: Math.sin(h), z: Math.cos(h) };
    if (!inside(x, z, 10) || wet(x, z)) return false;
    if (!isClear(x, z, strict ? 7 : 5.5) || flat(x, z, 7) > (strict ? .5 : .8)) return false;
    for (const k of [-14, 14]) { const px = x + f.x * k, pz = z + f.z * k; if (wet(px, pz) || !inside(px, pz, 6) || !clearOfSolids(px, pz, 2.5)) return false; }
    return true;
  }
  const inside = (x, z, m = 0) => hyp(x, z) < driveR() - m;
  const taken = []; // my own placements, so the lane and the ramps never share a patch
  const free = (x, z) => taken.every(t => hyp(x - t.x, z - t.z) > t.r);
  function pick(cands, ok, keep) { let r = null; for (const strict of [true, false]) { for (const c of cands) if (free(c[0], c[1]) && ok(c[0], c[1], c[2], strict)) { r = { x: c[0], z: c[1], h: c[2] }; break; } if (r) break; } if (!r) r = { x: cands[0][0], z: cands[0][1], h: cands[0][2], fallback: true }; taken.push({ x: r.x, z: r.z, r: keep }); return r; }
  function buildRamps() {
    const S = new Sink(), N = 8, L = RAMP.L, hw = RAMP.Wd / 2, skirt = -.6;
    RAMP_CANDS.forEach((cands, idx) => {
      const r = pick(cands, rampOk, 14); const f = { x: Math.sin(r.h), z: Math.cos(r.h) }, n = { x: Math.cos(r.h), z: -Math.sin(r.h) };
      let base = -1e9; for (const t of [-hw, 0, hw]) base = Math.max(base, num(W.terrain.height(r.x - f.x * L / 2 + n.x * t, r.z - f.z * L / 2 + n.z * t)));
      base += .02; r.base = base; r.f = f; r.n = n; r.lip = { x: r.x + f.x * L / 2, z: r.z + f.z * L / 2 }; r.entry = { x: r.x - f.x * L / 2, z: r.z - f.z * L / 2 }; r.approach = { x: r.x - f.x * (L / 2 + 10), z: r.z - f.z * (L / 2 + 10) };
      SP.ramps.push(r);
      S.frame(r.x, base, r.z, r.h);
      for (let i = 0; i < N; i++) {
        const s0 = -L / 2 + L * i / N, s1 = -L / 2 + L * (i + 1) / N, y0 = rampH(i / N), y1 = rampH((i + 1) / N);
        for (const [t0, t1, hex] of [[-hw, -hw + .45, YEL], [-hw + .45, hw - .45, ASPH], [hw - .45, hw, YEL]]) S.quad([t0, y0, s0], [t0, y1, s1], [t1, y1, s1], [t1, y0, s0], hex);
        S.quad([-hw, skirt, s0], [-hw, skirt, s1], [-hw, y1, s1], [-hw, y0, s0], '#8f8a80'); S.quad([hw, skirt, s1], [hw, skirt, s0], [hw, y0, s0], [hw, y1, s1], '#8f8a80');
      }
      for (let k = 0; k < 6; k++) { const t0 = -hw + k, t1 = t0 + 1; S.quad([t0, skirt, L / 2], [t1, skirt, L / 2], [t1, RAMP.H, L / 2], [t0, RAMP.H, L / 2], k % 2 ? INK : YEL); }
      S.quad([hw, skirt, -L / 2], [-hw, skirt, -L / 2], [-hw, 0, -L / 2], [hw, 0, -L / 2], '#8f8a80');
      S.box(RAMP.Wd + .2, .1, .3, 0, RAMP.H + .03, L / 2 - .1, STEEL);                                  // steel lip
      for (const sd of [-1, 1]) { S.box(.14, 1.3, .14, sd * (hw + .4), .65, -L / 2, PALE); S.box(.18, .45, .18, sd * (hw + .4), 1.1, -L / 2, RED); } // entrance bollards
      // drivable surface: the same profile; null outside the footprint so core launches the truck off the lip
      W.addSurface({ id: 'ramp' + idx, height(x, z) { const dx = x - r.x, dz = z - r.z, s = dx * f.x + dz * f.z; if (s < -L / 2 || s > L / 2) return null; const t = dx * n.x + dz * n.z; if (t < -hw || t > hw) return null; return base + rampH((s + L / 2) / L); } });
      // approach decal (ground text always reads from the fixed chase camera)
      const tex = W.textTex(['JUMP', `ramp ${idx + 1} · big air`], { w: 1024, h: 300, font: '800 150px Archivo', sub: '500 44px "IBM Plex Mono"' });
      const d = W.decal(tex, 5.6, 1.65); const ax = r.x - f.x * (L / 2 + 5.5), az = r.z - f.z * (L / 2 + 5.5); d.position.set(ax, G(ax, az) + .04, az); W.scene.add(d);
    });
    const m = S.mesh(VC, 'ms-ramps'); W.scene.add(m);
  }

  /* ---- Steppe bowling: a ground-hugging lane with gutters and arrows, ten lathe pins, a backstop ---- */
  const LANE_CANDS = [[-20, -27, -PI / 2], [-22, -27, -PI / 2], [-20, -25, -PI / 2], [-24, -27, -PI / 2], [0, 42, PI / 2], [40, -52, -PI / 2]];
  const laneOk = (x, z, h, strict) => { const f = { x: Math.sin(h), z: Math.cos(h) }; const px = x + f.x * 7, pz = z + f.z * 7, ex = x - f.x * 13, ez = z - f.z * 13; return inside(x, z, 8) && !wet(x, z) && isClear(x, z, strict ? 6 : 4.5) && isClear(px, pz, strict ? 5 : 4) && flat(x, z, 10) < (strict ? .6 : 1) && !wet(ex, ez) && clearOfSolids(ex, ez, 2); };
  function buildLane() {
    const F = pick(LANE_CANDS, laneOk, 18); const f = { x: Math.sin(F.h), z: Math.cos(F.h) }, n = { x: Math.cos(F.h), z: -Math.sin(F.h) };
    SP.lane = F; F.f = f; F.entry = { x: F.x - f.x * 13, z: F.z - f.z * 13 }; F.pins = { x: F.x + f.x * 8.5, z: F.z + f.z * 8.5 };
    const S = new Sink();
    const P = (s, t, lift) => { const x = F.x + f.x * s + n.x * t, z = F.z + f.z * s + n.z * t; return [x, G(x, z) + lift, z]; };
    const strip = (s0, s1, t0, t1, hex, lift = .03) => {
      const ns = Math.max(1, Math.ceil((s1 - s0) / 2)), nt = Math.max(1, Math.ceil((t1 - t0) / 2));
      for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) { const a = s0 + (s1 - s0) * i / ns, b = s0 + (s1 - s0) * (i + 1) / ns, c = t0 + (t1 - t0) * j / nt, d = t0 + (t1 - t0) * (j + 1) / nt; S.quad(P(a, c, lift), P(b, c, lift), P(b, d, lift), P(a, d, lift), hex); }
    };
    strip(-10, 14, -4, -3, '#4a4d52'); strip(-10, 14, 3, 4, '#4a4d52');   // gutters
    strip(-10, 5, -3, 3, '#e2dccb'); strip(5, 14, -3, 3, '#d3cbb7');        // lane, pin deck
    strip(-5.1, -4.85, -3, 3, INK, .045);                                    // foul line
    for (const k of [-1, 0, 1]) S.tri(P(-2.2, k * 1.4 - .4, .045), P(-.4, k * 1.4, .045), P(-2.2, k * 1.4 + .4, .045), BLU); // arrows
    // backstop wall behind the pins (also solids so pins and the truck stop there), far enough that the truck clears the back row first
    const bx = F.x + f.x * 14.6, bz = F.z + f.z * 14.6, by = G(bx, bz);
    S.frame(bx, by, bz, F.h); S.box(8.4, .9, .35, 0, .45, 0, '#8c4a2b'); S.box(8.6, .12, .45, 0, .95, 0, YEL); S.frame(0, 0, 0, 0);
    for (const t of [-2.8, 0, 2.8]) W.solid(bx + n.x * t, bz + n.z * t, 1.5, 'backstop');
    const lane = S.mesh(VC, 'ms-lane'); lane.castShadow = false; W.scene.add(lane);
    const tex = W.textTex(['STEPPE BOWLING', 'ten pins · drive through · strike'], { w: 1024, h: 300, font: '800 110px Archivo', sub: '500 44px "IBM Plex Mono"' });
    const d = W.decal(tex, 6.4, 1.9); d.position.set(F.entry.x, G(F.entry.x, F.entry.z) + .04, F.entry.z); W.scene.add(d);
    // pins: one lathe geometry, ten pushable meshes in a triangle, apex toward the approach
    const PS = new Sink(), half = .67;
    PS.lathe([[0, 0, PALE], [.27, 0, PALE], [.3, .3, PALE], [.26, .62, PALE], [.17, .85, RED], [.14, .95, PALE], [.15, 1.02, RED], [.21, 1.14, PALE], [.19, 1.27, PALE], [0, 1.34, PALE]].map(([r, y, c]) => [r, y - half, c]), 10, 0, 0, 0);
    // one InstancedMesh for all ten pins; each physics body is a bare Object3D proxy that core moves
    const pm = new T.InstancedMesh(PS.geometry(), VC, 10); pm.castShadow = pm.receiveShadow = true; pm.frustumCulled = false; pm.name = 'ms-pins'; W.scene.add(pm); pinState.mesh = pm;
    for (let row = 0; row < 4; row++) for (let k = 0; k <= row; k++) {
      const s = 7.5 + row * .9, t = (k - row / 2) * 1.02, x = F.x + f.x * s + n.x * t, z = F.z + f.z * s + n.z * t;
      const o = new T.Object3D(); o.position.set(x, 0, z); o.rotation.y = W.rng() * PI;
      const b = W.pushable(o, half, .42, { tag: 'pin', onHit: () => { pinState.hit = true; pinState.dirty = true; } });
      pinState.bodies.push(b); SP.pins.push({ x, z });
    }
    pinState.dirty = true; syncPins();
  }
  function syncPins() {
    const pm = pinState.mesh; if (!pm) return;
    const moving = pinState.bodies.some(b => !b.rest); if (!moving && !pinState.dirty) return;
    pinState.bodies.forEach((b, i) => { b.mesh.updateMatrix(); pm.setMatrixAt(i, b.mesh.matrix); }); pm.instanceMatrix.needsUpdate = true;
    pinState.dirty = moving; // keep syncing until everything has come to rest, then one last frame
  }

  /* ---- Tracker hunt: eight GPS trackers on short poles, instanced bodies and one blinking LED mesh ---- */
  const TRK_SEEDS = [[22, -62], [80, 22], [-70, -14], [66, -40], [-8, 80], [-54, 58], [-78, 34], [60, 60], [48, -48], [-66, -46], [-20, 70], [90, -10]];
  function buildTrackers() {
    for (const [sx, sz] of TRK_SEEDS) {
      if (trk.pts.length >= 8) break;
      let best = null;
      for (let k = 0; k < 420 && !best; k++) { const a = k * 2.4, rr = Math.sqrt(k) * 1.6, x = sx + Math.cos(a) * rr, z = sz + Math.sin(a) * rr; if (inside(x, z, 8) && !wet(x, z) && isClear(x, z, 2.5) && flat(x, z, 2) < .6) best = { x, z }; }
      if (!best && isClear(sx, sz, 1) && !wet(sx, sz) && inside(sx, sz, 8)) best = { x: sx, z: sz };
      if (best) { best.yaw = W.rng() * PI * 2; trk.pts.push(best); }
    }
    while (trk.pts.length < 8) { const a = W.rng() * PI * 2, rr = 60 + W.rng() * 40; trk.pts.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, yaw: W.rng() * PI * 2 }); }
    SP.trackers = trk.pts.map(p => ({ x: p.x, z: p.z }));
    const B = new Sink();
    B.box(.09, 1.15, .09, 0, .575, 0, '#2b2e33'); B.box(.52, .3, .36, 0, 1.3, 0, '#3a3d42'); B.box(.3, .13, .37, .02, 1.3, 0, YEL);
    B.box(.04, .5, .04, .18, 1.68, -.08, INK); B.box(.1, .04, .1, .18, 1.94, -.08, INK);
    const L = new Sink(); L.box(.12, .12, .12, -.15, 1.47, .1, '#39ff6a');
    trk.ledMat = new T.MeshStandardMaterial({ color: '#0f4d24', emissive: '#39ff6a', emissiveIntensity: 0, roughness: .4 });
    trk.body = new T.InstancedMesh(B.geometry(), VC, 8); trk.led = new T.InstancedMesh(L.geometry(), trk.ledMat, 8);
    for (const m of [trk.body, trk.led]) { m.frustumCulled = false; m.name = 'ms-trackers'; W.scene.add(m); }
    trk.body.castShadow = true;
    showTrackers(false);
  }
  const _m4 = new T.Matrix4();
  function showTrackers(on) {
    trk.visible = on; trk.found = trk.pts.map(() => false);
    if (!trk.body) return;
    trk.pts.forEach((p, i) => setTracker(i, on));
  }
  function setTracker(i, on) {
    const p = trk.pts[i]; if (!trk.body || !p) return;
    if (on) _m4.makeRotationY(p.yaw).setPosition(p.x, G(p.x, p.z), p.z); else _m4.makeScale(0, 0, 0);
    trk.body.setMatrixAt(i, _m4); trk.led.setMatrixAt(i, _m4); trk.body.instanceMatrix.needsUpdate = true; trk.led.instanceMatrix.needsUpdate = true;
    trk.body.visible = trk.led.visible = trk.found.some((f, k) => !f) && trk.visible;
  }

  /* ---- Steppe Rally: eight gates along the ring road, start and finish at the gantry ---- */
  function buildGates() {
    const R = W.roads; if (!R || !R.loop || R.loop.length < 16) return;
    const L = R.loop, n = L.length, gi = R.gantry && typeof R.gantry.i === 'number' ? R.gantry.i : 0;
    const runs = (R.guardRuns || []).map(r => ({ from: num(r.from), to: num(r.to) }));
    const inRun = (i, m) => runs.some(r => r.from <= r.to ? (i >= r.from - m && i <= r.to + m) : (i >= r.from - m || i <= r.to + m));
    const nearJ = i => (R.junctions || []).some(j => hyp(L[i].x - j.x, L[i].z - j.z) < 12);
    const cdist = (a, b) => { const d = Math.abs(a - b) % n; return Math.min(d, n - d); };
    const gap = Math.max(6, Math.round(n / 20)); // at least ~17 m between gates, and from the gantry
    const gates = []; let prev = gi;
    for (let k = 1; k <= 7; k++) {
      const ideal = (gi + Math.round(k * n / 8)) % n; let best = -1, bs = 1e9;
      for (let o = -24; o <= 24; o++) {
        const i = (ideal + o + n) % n;
        if (nearJ(i) || cdist(i, gi) < gap || cdist(i, prev) < gap) continue;
        const sc = Math.abs(o) + (inRun(i, 2) ? 7 : 0); // guard rails are only a preference: posts stand outside them
        if (sc < bs) { bs = sc; best = i; }
      }
      if (best < 0) best = ideal;
      gates.push(best); prev = best;
    }
    const start = R.gantry ? { x: num(R.gantry.x), z: num(R.gantry.z) } : { x: L[gi].x, z: L[gi].z };
    SP.rally = { start, gates: [] };
    const S = new Sink();
    gates.forEach((i, k) => {
      const p = L[i], a = L[(i - 1 + n) % n], b = L[(i + 1) % n], tg = unit(b.x - a.x, b.z - a.z), nn = { x: tg.z, z: -tg.x }, yaw = Math.atan2(tg.x, tg.z);
      SP.rally.gates.push({ x: p.x, z: p.z, i, k: k + 1 });
      for (const sd of [-1, 1]) {
        const px = p.x + nn.x * sd * 5.3, pz = p.z + nn.z * sd * 5.3, py = G(px, pz);
        S.frame(px, py, pz, yaw);
        S.box(.24, 2.9, .24, 0, 1.45, 0, BLU); S.box(.32, .42, .32, 0, 3.0, 0, YEL); S.box(.5, .12, .5, 0, .06, 0, '#b8b4ab');
        const inw = -sd; // pennant points toward the road
        S.tri2([0, 3.3, 0], [0, 2.55, 0], [inw * 1.05, 2.95, 0], sd < 0 ? YEL : PALE);
        S.frame(0, 0, 0, 0);
        W.solid(px, pz, .35, 'gate');
      }
    });
    const m = S.mesh(VC, 'ms-gates'); W.scene.add(m);
  }

  /* ---- the thief's van: a dark panel van with jerry cans on the roof, one merged mesh ---- */
  function buildVan() {
    const S = new Sink(), body = '#4a4d52', dk = '#2b2e33';
    S.box(1.9, .5, 4.5, 0, .55, 0, dk); S.box(2.0, 1.55, 3.0, 0, 1.55, -.6, body); S.box(2.0, 1.25, 1.4, 0, 1.4, 1.6, body); S.box(2.02, .08, 4.3, 0, 1.05, -.1, YEL);
    S.box(1.8, .62, .08, 0, 1.68, 2.3, '#2a3e66'); S.box(.08, .5, .9, 1.01, 1.65, 1.6, '#2a3e66'); S.box(.08, .5, .9, -1.01, 1.65, 1.6, '#2a3e66');
    S.box(.42, .2, .06, .62, 1.0, 2.31, '#fff6c8'); S.box(.42, .2, .06, -.62, 1.0, 2.31, '#fff6c8'); S.box(.36, .2, .06, .7, 1.0, -2.11, '#9b1c15'); S.box(.36, .2, .06, -.7, 1.0, -2.11, '#9b1c15');
    S.box(1.6, .08, 2.4, 0, 2.36, -.6, STEEL); S.box(.5, .52, .34, -.42, 2.66, -.3, RED); S.box(.5, .52, .34, .42, 2.66, -.3, RED); S.box(.5, .52, .34, 0, 2.66, -1.1, RED);
    S.box(.08, .08, 2.2, .7, 2.52, -.6, INK); S.box(.08, .08, 2.2, -.7, 2.52, -.6, INK);
    for (const [wx, wz] of [[1.0, 1.45], [-1.0, 1.45], [1.0, -1.4], [-1.0, -1.4]]) S.lathe([[0, -.15, INK], [.42, -.15, INK], [.42, .15, INK], [0, .15, INK]], 10, wx, .42, wz, 'x');
    for (const [wx, wz] of [[1.0, 1.45], [-1.0, 1.45], [1.0, -1.4], [-1.0, -1.4]]) S.lathe([[0, -.17, '#8a8a8a'], [.17, -.17, '#8a8a8a'], [.17, .17, '#8a8a8a'], [0, .17, '#8a8a8a']], 8, wx, .42, wz, 'x');
    van.mesh = S.mesh(VC, 'ms-van'); van.mesh.visible = false; W.scene.add(van.mesh);
  }
  function vanPath() {
    const R = W.roads, pts = [];
    if (R && R.loop && R.loop.length > 10 && typeof R.nearest === 'function') {
      const pl = (R.polylines || []).find(p => p.to === 'depot');
      if (pl && pl.points && pl.points.length > 1) for (const p of pl.points.slice().reverse()) pts.push({ x: p.x, z: p.z, dirt: true });
      else pts.push({ x: -33, z: -4, dirt: true });
      const last = pts[pts.length - 1], nr = R.nearest(last.x, last.z), n = R.loop.length, i0 = nr && typeof nr.i === 'number' ? nr.i + 1 : 0;
      for (let k = 0; k < n * 3; k++) { const p = R.loop[(i0 + k) % n]; pts.push({ x: p.x, z: p.z, dirt: false }); }
    } else { // no roads: flee to a circle of radius 50 and lap it clockwise
      const a0 = Math.atan2(-2, -28), RR = 50; pts.push({ x: -33, z: -4, dirt: true });
      for (let k = 0; k <= 360; k++) { const a = a0 + k / 120 * PI * 2; pts.push({ x: Math.cos(a) * RR, z: Math.sin(a) * RR, dirt: false }); }
    }
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    return { pts, cum, total: cum[cum.length - 1], seg: 0 };
  }
  function vanAt(P, d) {
    if (d >= P.total) { const e = P.pts[P.pts.length - 1], q = P.pts[P.pts.length - 2]; return { x: e.x, z: e.z, yaw: Math.atan2(e.x - q.x, e.z - q.z), dirt: false }; }
    while (P.seg < P.pts.length - 2 && P.cum[P.seg + 1] <= d) P.seg++;
    const a = P.pts[P.seg], b = P.pts[P.seg + 1], l = P.cum[P.seg + 1] - P.cum[P.seg] || 1, t = (d - P.cum[P.seg]) / l;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: Math.atan2(b.x - a.x, b.z - a.z), dirt: !!a.dirt };
  }
  function vanShow(on) {
    van.active = on; if (van.mesh) van.mesh.visible = on;
    if (on) { van.path = vanPath(); van.d = 0; van.caught = false; const p = vanAt(van.path, 0); van.x = p.x; van.z = p.z; van.solid = { x: p.x, z: p.z, r: 1.8, tag: 'van', onHit: impact => { if (Math.max(num(impact), speedBefore, Math.abs(num(car.v)) * 4) > 4) van.caught = true; } }; /* core passes the pre-bounce speed; older cores bounced first, hence the fallbacks */ W.solids.push(van.solid); vanPlace(p); }
    else if (van.solid) { const i = W.solids.indexOf(van.solid); if (i >= 0) W.solids.splice(i, 1); van.solid = null; }
  }
  function vanPlace(p) { van.x = p.x; van.z = p.z; if (van.solid) { van.solid.x = p.x; van.solid.z = p.z; } if (van.mesh) { van.mesh.position.set(p.x, G(p.x, p.z), p.z); van.mesh.rotation.y = p.yaw; } }

  /* ---- rings on the ground: destination (yellow), next gate (blue), the bay (blue, always on) ---- */
  function buildRings() {
    rings.dest = W.ring(5, .5, YEL, .85); rings.gate = W.ring(4.2, .45, BLU, .85); rings.bay = W.ring(4, .4, BLU, .7);
    for (const k in rings) { rings[k].visible = false; rings[k].name = 'ms-ring'; W.scene.add(rings[k]); }
    ringAt('bay', SP.bay.x, SP.bay.z, BLU);
  }

  /* ================================================================
     DELIVERY ROUTES, DROP POINTS AND CARGO
     ================================================================ */
  const ROUTES = [
    { id: 'town', to: 'town', title: 'Delivery: Khuslen Khot', sub: 'Load at the depot, cross the river bridge to the town.', fb: { x: 28, z: -100, r: 22, label: 'Khuslen Khot' }, cargo: 'crates' },
    { id: 'mine', to: 'mine', title: 'Delivery: Mine', sub: 'Drums and spares for the open pit, out along the east spur.', fb: { x: 92, z: 42, r: 18, label: 'Mine' }, cargo: 'drums' },
    { id: 'railStation', to: 'railStation', title: 'Delivery: Rail station', sub: 'A container for the freight yard, down the south spur.', fb: { x: 6, z: 98, r: 14, label: 'Rail station' }, cargo: 'container' },
    { id: 'powerplant', to: 'plant', title: 'Delivery: Power plant', sub: 'Pipes for the turbine hall, west past the ring.', fb: { x: -86, z: -26, r: 16, label: 'Power plant' }, cargo: 'pipes' }
  ];
  const placeOf = r => { const p = W.places && W.places[r.id]; return p && isFinite(p.x) && isFinite(p.z) ? { x: p.x, z: p.z, r: num(p.r, 10), label: p.label || r.fb.label } : r.fb; };
  // Where the cargo goes: beside the end of the road that serves the place, else the place's edge nearest a road
  // (or nearest the plaza without roads). Never on water, never inside a solid, never on the ring road itself.
  function dropPoint(place, toId) {
    const R = W.roads && W.roads.polylines ? W.roads : null, cands = [];
    if (R) { const pl = R.polylines.find(p => p.to === toId); if (pl && pl.points && pl.points.length > 1) { const P = pl.points, E = P[P.length - 1], Q = P[P.length - 2], d = unit(E.x - Q.x, E.z - Q.z), n = { x: d.z, z: -d.x }; for (const a of [0, -3, 3, -6, 6]) for (const b of [0, 5.5, -5.5, 7.5, -7.5]) cands.push([E.x + d.x * a + n.x * b, E.z + d.z * a + n.z * b, Math.abs(a) * .6 + Math.abs(b), false]); } }
    for (let k = 0; k < 48; k++) { const a = k / 48 * PI * 2, rr = place.r + 4.5, x = place.x + Math.cos(a) * rr, z = place.z + Math.sin(a) * rr; const sc = R && typeof R.distance === 'function' ? Math.min(60, num(R.distance(x, z), 60)) : hyp(x, z) / 4; cands.push([x, z, 40 + sc, true]); }
    let best = null;
    for (const [x, z, sc, onCircle] of cands) {
      if (!inside(x, z, 4) || wet(x, z) || !clearOfSolids(x, z, 1.6)) continue;
      if (onCircle && R && typeof R.distance === 'function' && R.distance(x, z) < 4.5) continue;
      if (!best || sc < best.sc) best = { x, z, sc };
    }
    if (!best) { const d = unit(-place.x, -place.z); best = { x: place.x + d.x * (place.r + 4.5), z: place.z + d.z * (place.r + 4.5), sc: 99, fallback: true }; }
    return { x: best.x, z: best.z, fallback: !!best.fallback };
  }
  const par = (a, b) => Math.max(20, Math.ceil(hyp(a.x - b.x, a.z - b.z) * 2.2 / 10 / 5) * 5);
  // cargo kinds built on W.truckCargo (origin at the top of the cargo box)
  cargoBuilders.crates = S => { for (const [x, z, r, hex] of [[-.58, -.55, .1, '#b98a52'], [.58, -.6, -.08, '#b98a52'], [.02, .62, .2, BLU]]) { S.frame(x, 0, z, r); S.box(.95, .95, .95, 0, .475, 0, hex); S.box(1.0, .08, .14, 0, .5, 0, INK); S.box(.14, .08, 1.0, 0, .5, 0, INK); } };
  cargoBuilders.drums = S => { S.frame(0, 0, 0, 0); for (const [x, z] of [[-.55, -.55], [.55, -.55]]) S.lathe([[0, 0, STEEL], [.42, 0, STEEL], [.42, .3, STEEL], [.42, .42, RED], [.42, .62, STEEL], [.42, .78, RED], [.42, 1.0, STEEL], [.36, 1.0, STEEL], [0, 1.0, '#6c7076']], 12, x, 0, z); S.frame(0, 0, .6, .15); S.box(.95, .95, .95, 0, .475, 0, '#b98a52'); S.box(1.0, .08, .14, 0, .5, 0, INK); };
  cargoBuilders.container = S => { S.frame(0, 0, 0, 0); S.box(2.3, 1.15, 1.2, 0, .575, 0, BLU); S.box(2.32, .08, 1.22, 0, 1.15, 0, PALE); for (const x of [-.7, 0, .7]) S.box(.16, 1.17, 1.23, x, .585, 0, YEL); S.box(.5, .3, .04, .6, .6, .62, YEL); };
  cargoBuilders.pipes = S => { S.frame(0, 0, 0, 0); for (const [x, y] of [[-.5, .3], [0, .3], [.5, .3], [-.25, .78], [.25, .78]]) S.lathe([[0, -1.6, STEEL], [.26, -1.6, STEEL], [.26, 1.6, STEEL], [0, 1.6, '#6c7076']], 10, x, y, 0, 'z'); S.box(1.7, .1, .3, 0, 1.06, -1.0, INK); S.box(1.7, .1, .3, 0, 1.06, 1.0, INK); };
  const cargoGeo = {}; // one geometry per cargo kind, shared by every delivery (meshes are removed, geometries never leak)
  function makeCargo(kind) { let g = cargoGeo[kind]; if (!g) { const S = new Sink(); (cargoBuilders[kind] || cargoBuilders.crates)(S); g = cargoGeo[kind] = S.geometry(); } const m = new T.Mesh(g, VC); m.castShadow = m.receiveShadow = true; m.name = 'ms-cargo'; return m; }

  /* ================================================================
     THE MISSIONS
     ================================================================ */
  const near = (p, r) => hyp(car.x - p.x, car.z - p.z) < r;
  const bestKey = id => 'best.' + id;
  const DEFS = [];

  for (const r of ROUTES) DEFS.push({
    id: 'delivery-' + r.id, kind: 'delivery', title: r.title, sub: r.sub,
    best() { const b = store.get(bestKey(this.id), null); return b != null ? 'Best ' + fmt(b) : ''; },
    begin(a) {
      const place = placeOf(r); a.drop = SP.drops[r.id] || dropPoint(place, r.to); a.label = place.label; a.par = par(SP.bay, a.drop); a.phase = 'load'; a.t = 0;
      ringAt('dest', SP.bay.x, SP.bay.z, BLU); W.setTarget({ x: SP.bay.x, z: SP.bay.z, color: BLU }); mark(SP.bay.x, SP.bay.z, BLU, true); mark(a.drop.x, a.drop.z, YEL, false);
      if (near(SP.bay, 6)) this.load(a); else W.toast('Load the cargo at the Open T depot');
    },
    load(a) {
      a.phase = 'drive'; a.t = 0; a.cargo = makeCargo(r.cargo); if (W.truckCargo) W.truckCargo.add(a.cargo); W.shadowed(a.cargo);
      W.sfx('cargo'); W.toast(`Loaded. Deliver to ${a.label} (par ${fmt(a.par)})`);
      clearMarks(); mark(a.drop.x, a.drop.z, YEL, true); ringAt('dest', a.drop.x, a.drop.z, YEL); W.setTarget({ x: a.drop.x, z: a.drop.z, color: YEL });
    },
    tick(a, dt) {
      if (a.phase === 'load') { if (near(SP.bay, 6) && Math.abs(car.v) < 3) this.load(a); return; }
      a.t += dt;
      if (near(a.drop, 5.5) && Math.abs(car.v) < 2.5) {
        const t = a.t, prev = store.get(bestKey(this.id), null), isBest = prev == null || t < prev; if (isBest) store.set(bestKey(this.id), +t.toFixed(1));
        if (a.cargo) { unloadCargo(a.cargo, a.drop); a.cargo = null; }
        W.sfx('cargo'); setTimeout(() => W.sfx('cash'), 350);
        finish(a, { ok: true, sfx: 'success', text: `Delivered to ${a.label} in ${fmt(t)}${isBest ? ' · new best' : t <= a.par ? ' · under par' : ' · par was ' + fmt(a.par)}` });
      }
    },
    hud(a) { return a.phase === 'load' ? { line: 'Load cargo at the Open T depot', timer: 'drive to the blue ring' } : { line: `Deliver to ${a.label}`, timer: `${fmt(a.t)} · par ${fmt(a.par)}`, progress: Math.min(1, a.t / a.par) }; },
    cleanup(a) { if (a.cargo && a.cargo.parent) a.cargo.parent.remove(a.cargo); a.cargo = null; }
  });

  DEFS.push({
    id: 'rally', kind: 'rally', title: 'Steppe Rally', sub: 'One lap of the ring road through eight gates, clockwise from the start gantry.',
    available: () => !!(SP.rally && SP.rally.gates.length === 7), unavailable: 'Needs the ring road: the roads module is not loaded.',
    best() { const b = store.get('best.rally', null); return b != null ? 'Best lap ' + fmt(b) : ''; },
    begin(a) { a.phase = 'tostart'; a.gate = 0; a.t = 0; const s = SP.rally.start; for (const g of SP.rally.gates) mark(g.x, g.z, BLU, false); mark(s.x, s.z, YEL, true); W.setTarget({ x: s.x, z: s.z, color: YEL }); ringAt('gate', s.x, s.z, YEL); W.toast('Cross the start line at the gantry, then take the gates in order'); },
    tick(a, dt) {
      const s = SP.rally.start;
      if (a.phase === 'tostart') { if (near(s, 6)) { a.phase = 'lap'; a.t = 0; a.gate = 1; W.sfx('checkpoint'); W.toast('Go!'); this.aim(a); } return; }
      a.t += dt;
      const g = a.gate <= 7 ? SP.rally.gates[a.gate - 1] : s;
      if (near(g, 5.5)) {
        if (a.gate <= 7) { W.sfx('checkpoint'); W.puff(g.x, g.z, 1.5, '#f7bd0c'); a.gate++; W.toast(`Gate ${a.gate - 1} of 7 · ${fmt(a.t)}`); this.aim(a); }
        else { const t = a.t, prev = store.get('best.rally', null), isBest = prev == null || t < prev; if (isBest) store.set('best.rally', +t.toFixed(1)); finish(a, { ok: true, sfx: 'success', text: `Lap ${fmt(t)}${isBest ? ' · new best lap' : ' · best ' + fmt(prev)}` }); }
      }
    },
    aim(a) { const g = a.gate <= 7 ? SP.rally.gates[a.gate - 1] : SP.rally.start, c = a.gate <= 7 ? BLU : YEL; W.setTarget({ x: g.x, z: g.z, color: c }); ringAt('gate', g.x, g.z, c); clearMarks(); for (let i = a.gate - 1; i < 7; i++) mark(SP.rally.gates[i].x, SP.rally.gates[i].z, BLU, i === a.gate - 1); mark(SP.rally.start.x, SP.rally.start.z, YEL, a.gate > 7); },
    hud(a) { const b = store.get('best.rally', null); return a.phase === 'tostart' ? { line: 'Drive to the start gantry', timer: b != null ? 'best ' + fmt(b) : 'lap timer starts at the line' } : { line: a.gate <= 7 ? `Gate ${a.gate} of 7, then the finish` : 'Back to the gantry to finish', timer: fmt(a.t) + (b != null ? ' · best ' + fmt(b) : ''), progress: (a.gate - 1) / 8 }; },
    cleanup() { }
  });

  DEFS.push({
    id: 'hunt', kind: 'hunt', title: 'Tracker hunt', sub: 'Eight GPS trackers went dark around the map. Drive over each blinking one to recover it.',
    best() { const b = store.get('best.hunt', null); return b != null ? 'Best ' + fmt(b) : ''; },
    begin(a) { a.t = 0; a.found = 0; showTrackers(true); for (const p of trk.pts) mark(p.x, p.z, '#1d8a5b', false); this.aim(); W.toast('Eight trackers are blinking somewhere out there'); },
    aim() { let best = null, bd = 1e9; trk.pts.forEach((p, i) => { if (trk.found[i]) return; const d = hyp(car.x - p.x, car.z - p.z); if (d < bd) { bd = d; best = p; } }); W.setTarget(best ? { x: best.x, z: best.z, color: '#1d8a5b' } : null); },
    tick(a, dt) {
      a.t += dt;
      trk.pts.forEach((p, i) => {
        if (trk.found[i] || hyp(car.x - p.x, car.z - p.z) > 3) return;
        trk.found[i] = true; a.found++; setTracker(i, false); W.sfx('collect'); W.puff(p.x, p.z, 1.2, '#39ff6a');
        const mi = marks.find(m => m.x === p.x && m.z === p.z); if (mi) { const k = W.markers.indexOf(mi); if (k >= 0) W.markers.splice(k, 1); marks.splice(marks.indexOf(mi), 1); }
        if (a.found >= trk.pts.length) { const t = a.t, prev = store.get('best.hunt', null), isBest = prev == null || t < prev; if (isBest) store.set('best.hunt', +t.toFixed(1)); car.fuel = car.maxFuel; finish(a, { ok: true, sfx: 'success', text: `All ${trk.pts.length} trackers recovered in ${fmt(t)}. Reward: a full tank.` }); }
        else { W.toast(`Tracker ${a.found} of ${trk.pts.length}`); this.aim(); }
      });
      if (a.phase !== 'done') this.aim();
    },
    hud(a) { return { line: `Trackers ${a.found} of ${trk.pts.length}`, timer: fmt(a.t), progress: a.found / Math.max(1, trk.pts.length) }; },
    cleanup() { showTrackers(false); }
  });

  DEFS.push({
    id: 'air', kind: 'air', title: 'Big Air', sub: 'Three ramps on the steppe. Hit each one fast; the longest flight counts.',
    best() { const b = store.get('best.air', null); return b != null ? `Best air ${num(b).toFixed(1)} s` : ''; },
    begin(a) { a.jumped = SP.ramps.map(() => false); a.best = 0; a.wasAir = !!car.airborne; a.pending = -1; a.t = 0; this.aim(a); W.toast('Follow the arrow to a ramp and floor it (Shift to boost)'); },
    aim(a) { clearMarks(); let best = null, bd = 1e9; SP.ramps.forEach((r, i) => { if (a.jumped[i]) return; mark(r.x, r.z, RED, false); const d = hyp(car.x - r.approach.x, car.z - r.approach.z); if (d < bd) { bd = d; best = r; } }); if (best) { W.setTarget({ x: best.approach.x, z: best.approach.z, color: RED }); ringAt('dest', best.approach.x, best.approach.z, RED); } },
    tick(a, dt) {
      a.t += dt; const airborne = !!car.airborne;
      if (airborne && !a.wasAir) { a.pending = -1; let bd = 9; SP.ramps.forEach((r, i) => { const d = hyp(car.x - r.lip.x, car.z - r.lip.z); if (d < bd) { bd = d; a.pending = i; } }); }
      if (!airborne && a.wasAir && a.pending >= 0) {
        const t = num(W.lastAir); a.jumped[a.pending] = true; a.best = Math.max(a.best, t); W.sfx('checkpoint');
        const prev = store.get('best.air', 0); if (t > num(prev)) store.set('best.air', +t.toFixed(2));
        const n = a.jumped.filter(Boolean).length; a.pending = -1;
        if (n >= SP.ramps.length) finish(a, { ok: true, sfx: 'success', text: `All ${SP.ramps.length} ramps. Longest flight ${a.best.toFixed(1)} s` });
        else { W.toast(`Ramp done: ${t.toFixed(1)} s in the air · ${n} of ${SP.ramps.length}`); this.aim(a); }
      }
      a.wasAir = airborne;
    },
    hud(a) { const n = a.jumped.filter(Boolean).length; return { line: `Ramps ${n} of ${SP.ramps.length}`, timer: a.best > 0 ? `best flight ${a.best.toFixed(1)} s` : 'no flight yet', progress: n / Math.max(1, SP.ramps.length) }; },
    cleanup() { }
  });

  DEFS.push({
    id: 'bowling', kind: 'bowling', title: 'Steppe bowling', sub: 'Ten pins on a lane in the north steppe. Knock them all down in one run.',
    best() { const b = store.get('best.bowling', null); return b != null ? (b >= 10 ? 'Best: strike' : `Best ${b} pins`) : ''; },
    begin(a) { resetPins(); a.phase = 'approach'; a.t = 0; const L = SP.lane; mark(L.pins.x, L.pins.z, RED, true); W.setTarget({ x: L.entry.x, z: L.entry.z, color: RED }); ringAt('dest', L.entry.x, L.entry.z, RED); W.toast('Line up at the lane entrance and drive through the pins'); },
    tick(a, dt) {
      if (a.phase === 'approach') { if (pinState.hit) { a.phase = 'rolling'; pinState.hitT = 0; W.setTarget(null); rings.dest && (rings.dest.visible = false); } return; }
      pinState.hitT += dt;
      const rest = pinState.bodies.every(b => b.rest);
      if (pinState.hitT > 4.5 || (pinState.hitT > 1.5 && rest)) {
        const n = pinsDown(); const prev = num(store.get('best.bowling', 0)); if (n > prev) store.set('best.bowling', n);
        pinState.hit = false; pinState.hitT = -1;
        finish(a, n >= 10 ? { ok: true, sfx: 'success', text: 'STRIKE! All ten pins down.' } : { ok: false, sfx: n >= 7 ? 'click' : 'fail', text: `${n} of 10 pins. Reset the pins from the board and try again.` });
      }
    },
    hud(a) { return a.phase === 'approach' ? { line: 'Knock down all ten pins in one run', timer: 'drive through the red ring' } : { line: `Pins down ${pinsDown()} of 10`, timer: 'rolling…', progress: pinsDown() / 10 }; },
    cleanup() { }
  });

  DEFS.push({
    id: 'thief', kind: 'thief', title: 'Fuel theft alert', sub: 'Fuel Tank Warner flagged a drain at the depot. Ram the thief\'s van before it gets away: 60 s.',
    best() { const n = num(store.get('thief.caught', 0)); return n ? `Caught ${n}×` : ''; },
    begin(a) { a.t = 60; vanShow(true); a.m = mark(van.x, van.z, RED, true); a.tg = { x: van.x, z: van.z, color: RED }; W.setTarget(a.tg); W.sfx('horn'); W.toast('Fuel theft at the depot: a van is fleeing along the ring road'); },
    tick(a, dt) {
      a.t -= dt; const P = van.path; const speed = vanAt(P, van.d).dirt ? 9 : 13; van.d += speed * dt; const p = vanAt(P, van.d); vanPlace(p);
      a.m.x = p.x; a.m.z = p.z; a.tg.x = p.x; a.tg.z = p.z;
      if (van.caught) { const n = num(store.get('thief.caught', 0)) + 1; store.set('thief.caught', n); car.fuel = Math.min(car.maxFuel, car.fuel + 120); W.puff(p.x, p.z, 2.5, '#9b1c15'); finish(a, { ok: true, sfx: 'success', text: `Thief caught with ${Math.ceil(a.t)} s to spare. 120 L of fuel recovered.` }); setTimeout(() => W.sfx('cash'), 300); }
      else if (a.t <= 0) finish(a, { ok: false, sfx: 'fail', text: 'The van got away. Fuel Tank Warner logged the drain.' });
    },
    hud(a) { const d = hyp(car.x - van.x, car.z - van.z); return { line: `Catch the van · ${Math.round(d)} m away`, timer: `${Math.ceil(Math.max(0, a.t))} s left`, progress: Math.max(0, a.t) / 60 }; },
    cleanup() { vanShow(false); }
  });

  /* ================================================================
     CONTROLLER: start / cancel / finish, HUD, board, hooks
     ================================================================ */
  const defOf = id => DEFS.find(d => d.id === id);
  const pub = a => ({ id: a.def.id, title: a.def.title, phase: a.phase || 'run', t: +num(a.t).toFixed(2), gate: a.gate, found: a.found, jumped: a.jumped, best: a.best, result: a.result || null, done: a.phase === 'done' });
  function start(id) {
    const def = defOf(id); if (!def) { W.toast('No such mission'); return false; }
    if (def.available && !def.available()) { W.toast(def.unavailable || 'Not available'); W.sfx('fail'); return false; }
    if (act) { cleanup(); W.toast('Previous mission replaced'); }
    act = { def, t: 0, phase: 'run', startedAt: performance.now() }; outro = 0;
    W.closePanel(); W.sfx('start');
    try { def.begin(act); } catch (e) { console.warn('missions: begin failed', e); cleanup(); return false; }
    setHud(hudHtml(act));
    return true;
  }
  function cancel() { if (!act) return false; const t = act.def.title; cleanup(); W.toast(`${t} cancelled`); W.sfx('click'); return true; }
  function cleanup() { const a = act; act = null; outro = 0; if (a && !a.cleaned) { try { a.def.cleanup(a); } catch (e) { } a.cleaned = true; } clearMarks(); W.setTarget(null); hideRings(); setHud(''); }
  function finish(a, r) { a.phase = 'done'; a.result = r; outro = 3.4; if (r.text) W.toast(r.text); if (r.sfx) W.sfx(r.sfx); if (r.ok) store.set('done', num(store.get('done', 0)) + 1); if (!a.cleaned) { try { a.def.cleanup(a); } catch (e) { } a.cleaned = true; } clearMarks(); W.setTarget(null); hideRings(); }
  function setHud(html) { if (html === lastHud) return; lastHud = html; if (html) W.hud.set('mission', html); else W.hud.remove('mission'); }
  function hudHtml(a) {
    if (a.phase === 'done') { const r = a.result || {}; return `<b>${esc(a.def.title)}</b><br>${esc(r.ok ? 'Done. ' : '')}${esc(r.text || '')}`; }
    let h; try { h = a.def.hud(a) || {}; } catch (e) { h = {}; }
    return `<b>${esc(a.def.title)}</b><br>${esc(h.line || '')}${h.timer ? `<br><span class="mono">${esc(h.timer)}</span>` : ''}${h.progress != null ? `<div class="bar"><i style="width:${Math.round(W.clamp(h.progress, 0, 1) * 100)}%"></i></div>` : ''}`;
  }
  // cargo leaves the truck and lands beside the drop ring, then fades out of the world after a while
  function unloadCargo(mesh, drop) {
    const from = new T.Vector3(); mesh.getWorldPosition(from); if (mesh.parent) mesh.parent.remove(mesh);
    const q = new T.Quaternion(); W.truck.getWorldQuaternion(q);
    const side = { x: Math.cos(car.h), z: -Math.sin(car.h) }, tx = car.x + side.x * 3.2, tz = car.z + side.z * 3.2;
    mesh.position.copy(from); mesh.quaternion.copy(q); W.scene.add(mesh);
    dropped.push({ mesh, t: 0, from, to: new T.Vector3(tx, G(tx, tz), tz), yaw: car.h + .3 });
  }
  function tickDropped(dt) {
    for (let i = dropped.length - 1; i >= 0; i--) {
      const d = dropped[i]; d.t += dt; const m = d.mesh;
      if (d.t < .8) { const u = d.t / .8, k = u * u * (3 - 2 * u); m.position.lerpVectors(d.from, d.to, k); m.position.y += Math.sin(u * PI) * 1.6; m.rotation.set(0, d.yaw, 0); }
      else if (d.t < 30) { m.position.copy(d.to); }
      else { if (m.parent) m.parent.remove(m); dropped.splice(i, 1); }
    }
  }
  function clearDropped() { for (const d of dropped) if (d.mesh.parent) d.mesh.parent.remove(d.mesh); dropped = []; }

  /* ---- the board (sticky panel) ---- */
  function boardHtml() {
    const rows = DEFS.map(d => {
      const ok = !d.available || d.available(); let best = ''; try { best = d.best ? d.best() : ''; } catch (e) { }
      const isAct = act && act.def === d && act.phase !== 'done';
      return `<div class="mission"><div><b>${esc(d.title)}</b><small>${esc(ok ? d.sub : d.unavailable)}</small>${best ? `<span class="best">${esc(best)}</span>` : ''}</div>${isAct ? '<button class="btn small ghost" data-mcancel="1">Cancel</button>' : ok ? `<button class="btn small" data-mstart="${d.id}">Start</button>` : '<button class="btn small ghost" disabled>Unavailable</button>'}</div>`;
    }).join('');
    const activeLine = act && act.phase !== 'done' ? `<p><b>Active:</b> ${esc(act.def.title)}. Cancel it below, or press R to reset everything.</p>` : '<p>Pick a job. One at a time; the card under the name badge shows the objective and the timer.</p>';
    return `<div class="eyebrow">Mission board · Open T depot</div><h2>Missions</h2>${activeLine}${rows}<div class="row"><button class="btn small ghost" data-mpins="1">Reset bowling pins</button><span class="tags">E at the depot opens this board</span></div>`;
  }
  function openBoard() { if (W.panelId === 'missions') { W.closePanel(); return; } W.closePanel(); W.openPanel(boardHtml(), { id: 'missions', sticky: true }); }
  document.addEventListener('click', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-mstart],[data-mcancel],[data-mpins]') : null; if (!el) return;
    try {
      if (el.dataset.mstart) start(el.dataset.mstart);
      else if (el.dataset.mcancel) { cancel(); W.closePanel(); }
      else if (el.dataset.mpins) { resetPins(); W.sfx('click'); W.toast('Pins are back up'); }
    } catch (err) { console.warn('missions: board click', err); }
  });
  W.hud.button('Missions', openBoard, { id: 'missionsBtn', title: 'Mission board (E at the Open T depot)' });
  W.onAction(() => { const d = W.places && W.places.depot; const atDepot = d ? hyp(car.x - d.x, car.z - d.z) < num(d.r, 14) + 2 : hyp(car.x + 28, car.z + 2) < 16; if (!atDepot) return false; openBoard(); return true; });

  /* ---- public API ---- */
  const MS = W.missions = {
    ready: false, spots: SP, start, cancel, openBoard, resetPins,
    get list() { return DEFS.map(d => { let best = ''; try { best = d.best ? d.best() : ''; } catch (e) { } return { id: d.id, title: d.title, sub: d.sub, available: !d.available || !!d.available(), best }; }); },
    get active() { return act ? pub(act) : null; },
    state: () => act ? pub(act) : null,
    boardHtml
  };

  /* ---- every frame ---- */
  W.onUpdate((dt, now) => {
    try {
      if (trk.ledMat) trk.ledMat.emissiveIntensity = (now % 900) < 140 ? 2.2 : 0;
      const pulse = .55 + .3 * Math.sin(now / 240);
      for (const k in rings) if (rings[k].visible) rings[k].material.opacity = k === 'bay' ? .45 + .25 * Math.sin(now / 300) : pulse;
      if (dropped.length) tickDropped(dt);
      syncPins();
      // passive strike watcher when bowling is not the active mission
      if (pinState.hit && !(act && act.def.kind === 'bowling')) { if (pinState.hitT < 0) pinState.hitT = 0; pinState.hitT += dt; if (pinState.hitT > 4) { const n = pinsDown(); if (n >= 10) { W.toast('Strike! Start Steppe bowling from the board to record it'); W.sfx('success'); } pinState.hit = false; pinState.hitT = -1; } }
      if (act) {
        if (act.phase === 'done') { outro -= dt; setHud(hudHtml(act)); if (outro <= 0) { act = null; setHud(''); } }
        else { act.def.tick(act, dt, now); if (act) setHud(hudHtml(act)); }
      }
      speedBefore = Math.abs(num(car.v));
    } catch (e) {
      console.warn('missions: frame error', e);
      try { cleanup(); } catch (e2) { }
      W.toast('Mission stopped');
    }
  });

  W.onReset(() => {
    try { if (act) cleanup(); } catch (e) { }
    try { resetPins(); clearDropped(); showTrackers(false); if (van.active) vanShow(false); if (W.panelId === 'missions') W.closePanel(); } catch (e) { }
  });
})();
