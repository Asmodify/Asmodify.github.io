/* stations.js — the four project stations (rings you park on) and the centre plaza
   (name blocks, intro props). Example module: everything goes through W. */
(() => {
  const W = window.W, T = W.T, M = W.M;

  W.onReady(() => {
    /* ---------- centre plaza: name in knockable blocks ---------- */
    const boxG = new T.BoxGeometry(1, 1, 1);
    const c = document.createElement('canvas'); c.width = 260; c.height = 44; const x = c.getContext('2d');
    x.font = '800 40px Archivo'; x.textBaseline = 'middle'; x.textAlign = 'center'; x.fillText('KHUSLEN', 130, 23);
    const d = x.getImageData(0, 0, 260, 44).data, step = 4, S = .78;
    // One InstancedMesh for all ~190 blocks (one draw call instead of one per block). Each block's
    // physics body is a bare Object3D proxy that core moves; its matrix is copied into the instance.
    const cells = [];
    for (let py = 0; py < 44; py += step) for (let px = 0; px < 260; px += step) if (d[(py * 260 + px) * 4 + 3] > 140) cells.push([px, py]);
    const letters = new T.InstancedMesh(boxG, W.mat('#ffffff'), cells.length);
    letters.castShadow = letters.receiveShadow = true;
    const dark = new T.Color('#1c1b19'), blue = new T.Color('#1f4fd1'), proxies = [];
    cells.forEach(([px, py], i) => {
      const o = new T.Object3D(); o.scale.set(S, S * 1.1, S);
      o.position.set((px - 130) / step * S * 1.02, 0, -16 + (py - 22) / step * S * 1.02);
      W.pushable(o, S * .55, S * .62, { tag: 'letter' });
      letters.setColorAt(i, px > 150 ? blue : dark); proxies.push(o);
    });
    letters.instanceColor.needsUpdate = true; W.scene.add(letters);
    W.onUpdate(() => { proxies.forEach((o, i) => { o.updateMatrix(); letters.setMatrixAt(i, o.matrix); }); letters.instanceMatrix.needsUpdate = true; });
    const sub = W.decal(W.textTex(['', 'software developer · fleet systems · python first'], { w: 1400, h: 120, sub: '500 46px "IBM Plex Mono"' }), 30, 2.6);
    W.place(sub, 0, -10.6, .04); W.scene.add(sub);

    // crates and a row of cones near the start
    [[8, 4], [9.3, 4], [8.6, 5.3], [-10, 8], [-10, 9.3], [14, -8]].forEach(([cx, cz]) => { const m = new T.Mesh(boxG, M.crate); m.scale.setScalar(1.1); m.position.set(cx, 0, cz); m.rotation.y = W.rng(); W.pushable(m, .55, .77, { tag: 'crate' }); });
    const coneG = new T.ConeGeometry(.4, 1.1, 12);
    for (let i = 0; i < 7; i++) { const m = new T.Mesh(coneG, M.cone); m.position.set(-4 + i * 1.6, 0, 10 + Math.sin(i) * .6); W.pushable(m, .55, .5, { tag: 'cone' }); }

    /* ---------- stations ---------- */
    let fuelSfxOn = false;
    const defs = [
      { id: 'opent', x: -28, z: -2, color: '#f7bd0c', title: 'Open T', sub: 'fleet platform',
        html: `<div class="eyebrow">In production · 2026 · OpenDevelopment</div><h2>Open T fleet platform</h2>
        <p>Internal transport management for a trucking company: vehicles, drivers, dispatch, fuel, inspections, maintenance and reporting, as one API with two clients.</p>
        <ul><li><b>API:</b> Node and Express on MongoDB, 24 route groups, Socket.IO live tracking, scheduled reports.</li>
        <li><b>Admin console:</b> Next.js 16 and React 19 with Leaflet maps and Recharts.</li>
        <li><b>Driver app:</b> Flutter with Riverpod: shifts, jobs, fuel entries, documents.</li>
        <li>Identity and vehicle registry lookups through Mongolia's DAN OAuth service.</li></ul>
        <div class="tags">Express · Mongoose · Next.js · Flutter · 34 data models · private repos</div>
        <div class="row"><a class="chip" href="classic.html#work">More in classic view</a></div>` },
      { id: 'fuel', x: 26, z: -4, color: '#d2473b', title: 'Fuel Tank Warner', sub: 'refuel here',
        html: `<div class="eyebrow">In use · Sep 2026 · sole developer</div><h2>Fuel Tank Warner</h2>
        <p>Watches every vehicle on the company's GPS server and alerts when fuel disappears, a tracker is tampered with, or a truck idles, speeds or goes silent. Runs on one office PC with a double-click start.</p>
        <ul><li>Probes slosh by thousands of millivolts while driving, so levels are only trusted from settled readings while stopped.</li>
        <li>Calibration tables turn sensor millivolts into litres; every refuel and drain lands in an Excel ledger.</li>
        <li>Live dashboard over server-sent events.</li></ul>
        <p><b>Your tank is being refilled.</b> Try the drain-detector demo in the classic view.</p>
        <div class="tags">Node 24 · SQLite · SSE</div>
        <div class="row"><a class="chip" href="https://github.com/Asmodify/OpendeGPS-fuel-notify">Repo ↗</a><a class="chip" href="classic.html#work">Try the demo</a></div>`,
        onInside: dt => { const c = W.car; if (c.fuel < c.maxFuel - 1) { c.fuel = Math.min(c.maxFuel, c.fuel + 160 * dt); if (!fuelSfxOn) { fuelSfxOn = true; W.sfx('refuel'); } } },
        onLeave: () => { fuelSfxOn = false; } },
      { id: 'senti', x: -22, z: 26, color: '#7a4fe0', title: 'SentimentAI', sub: 'diploma thesis',
        html: `<div class="eyebrow">Diploma thesis · 2026 · MUST SICT</div><h2>SentimentAI</h2>
        <p>Collects public Facebook page posts and comments, scores sentiment, finds topics, predicts engagement and writes AI reports in Mongolian.</p>
        <ul><li>Four sentiment back ends: lexicon, transformer, fine-tuned Mongolian BERT (F1 0.94), and a LoRA-tuned LLM via Ollama.</li>
        <li>LDA topics, trends and an engagement model in scikit-learn.</li>
        <li>Next.js dashboard with Gemini reports and Q&amp;A; CI with pytest, ruff, eslint, tsc and vitest.</li></ul>
        <p>The earlier prototype used Selenium, FastAPI, React and Firestore.</p>
        <div class="tags">FastAPI · SQLAlchemy · Next.js 16 · Gemini</div>
        <div class="row"><a class="chip" href="https://github.com/Asmodify/Diplom-Data">Prototype repo ↗</a><a class="chip" href="classic.html#work">Screenshots</a></div>` },
      { id: 'about', x: 24, z: 28, color: '#1f4fd1', title: 'About', sub: 'and earlier work',
        html: `<div class="eyebrow">About</div><h2>Khuslen</h2>
        <p>Developer at OpenDevelopment and Information Systems student at the Mongolian University of Science and Technology. Most of my work sits between hardware in the field and the people who run it: GPS trackers and fuel sensors on one side, dispatchers and accountants on the other.</p>
        <p>Python first; Node, TypeScript and Dart when the job needs them.</p>
        <p><b>Earlier work (2024):</b> Mongol BUS terminal and <a href="https://github.com/Asmodify/REAL-AS-BUS-">REAL-AS-BUS</a>, Flutter apps from my internship practicum.</p>
        <div class="row"><a class="chip" href="https://github.com/Asmodify">github.com/Asmodify ↗</a><a class="chip" href="classic.html">Classic view</a></div>` }
    ];
    for (const s of defs) {
      W.addStation(s);
      const g = new T.Group(); W.place(g, s.x, s.z); W.scene.add(g);
      const pad = new T.Mesh(new T.CircleGeometry(s.r, 48), M.pad); pad.rotation.x = -Math.PI / 2; pad.position.y = .015; pad.receiveShadow = true; g.add(pad);
      s.glow = W.ring(s.r, .45, s.color, .9); s.glow.position.y = .02; g.add(s.glow);
      const label = W.decal(W.textTex([s.title, s.sub], { w: 1024, h: 260, font: '800 118px Archivo', sub: '500 42px "IBM Plex Mono"' }), 11, 2.8);
      label.position.set(0, .04, s.r + 2.2); g.add(label);
    }
    W.addPlace('depot', { x: -28, z: -2, r: 14, label: 'Open T depot' });
    W.addPlace('fuel', { x: 26, z: -4, r: 12, label: 'Fuel station' });

    /* ---------- station props ---------- */
    (() => { // Open T depot: containers + the Open T mark
      const s = defs[0];
      [[-4, -6, 0], [0, -7, .1], [4, -6, -.1]].forEach(([dx, dz, r], i) => { const m = W.box(3.4, 2.6, 7.5, i === 1 ? M.blue : M.truck); W.place(m, s.x + dx, s.z + dz, 1.3); m.rotation.y = r; W.scene.add(W.shadowed(m)); W.solid(s.x + dx, s.z + dz - 1.5, 2.1); W.solid(s.x + dx, s.z + dz + 1.5, 2.1); });
      const mark = new T.Group();
      mark.add(W.box(3.5, 2.7, .4, M.truck, 0, 2.6, 0), W.box(3.5, .8, .5, M.dark, 0, 4.35, 0), W.box(.9, 4.4, .5, M.dark, .35, 2.2, .05), W.cyl(.12, .12, 1.2, M.grey, 0, .6, 0));
      W.place(mark, s.x - 8, s.z + 1); mark.rotation.y = .5; W.scene.add(W.shadowed(mark)); W.solid(s.x - 8, s.z + 1, 1.6);
    })();
    (() => { // fuel station: canopy and pumps
      const s = defs[1], g = new T.Group(); W.place(g, s.x + 7.5, s.z - 1);
      g.add(W.box(7, .5, 5, M.red, 0, 4.2, 0), W.box(7.05, .18, 5.05, M.white, 0, 3.95, 0));
      [[-2.8, -1.8], [2.8, -1.8], [-2.8, 1.8], [2.8, 1.8]].forEach(([x, z]) => g.add(W.cyl(.18, .18, 4.1, M.white, x, 2.05, z)));
      [-1.2, 1.2].forEach(x => { g.add(W.box(.9, 1.6, .6, M.white, x, .8, 0), W.box(.6, .4, .05, M.glass, x, 1.2, .33)); });
      W.scene.add(W.shadowed(g)); W.solid(s.x + 6.3, s.z - 1, .8); W.solid(s.x + 8.7, s.z - 1, .8);
      for (let i = 0; i < 6; i++) { const m = new T.Mesh(new T.ConeGeometry(.4, 1.1, 12), M.cone); m.position.set(s.x - 6, 0, s.z - 6 + i * 2.2); W.pushable(m, .55, .5, { tag: 'cone' }); }
    })();
    (() => { // SentimentAI billboard with the real dashboard, plus comment bubbles
      const s = defs[2], g = new T.Group(); W.place(g, s.x - 1, s.z - 8); g.rotation.y = .35;
      g.add(W.box(10.6, 7.4, .4, M.dark, 0, 5.2, 0), W.box(.35, 2, .35, M.dark, -3.5, 1, 0), W.box(.35, 2, .35, M.dark, 3.5, 1, 0));
      const tex = new T.TextureLoader().load('img/sentiment-dashboard.webp'); tex.anisotropy = 4;
      const screen = new T.Mesh(new T.PlaneGeometry(10, 6.8), new T.MeshBasicMaterial({ map: tex })); screen.position.set(0, 5.2, .21); g.add(screen);
      W.scene.add(W.shadowed(g)); W.solid(s.x - 2.2, s.z - 8.2, 1.4); W.solid(s.x + .5, s.z - 7.6, 1.4); W.solid(s.x + 2.4, s.z - 7, 1.4); W.solid(s.x - 4.4, s.z - 9, 1.4);
      const bm = [W.mat('#1d8a5b'), W.mat('#d2473b'), W.mat('#9aa1a6')];
      for (let i = 0; i < 9; i++) { const b = new T.Mesh(new T.SphereGeometry(.5, 12, 8), bm[i % 3]); b.position.set(s.x - 7 + (i % 3) * 1.4, 0, s.z + 2 + Math.floor(i / 3) * 1.4); W.pushable(b, .5, .55, { tag: 'bubble' }); }
    })();
    (() => { // About: a small ger camp
      const s = defs[3];
      W.ger(s.x + 8, s.z - 3, 1.1, -.4); W.ger(s.x + 3, s.z - 9, .9, .3);
      W.addPlace('camp', { x: s.x + 5, z: s.z - 6, r: 9, label: 'Ger camp' });
    })();
  });

  // A ger (yurt). Shared so buildings.js can scatter more of them.
  W.ger = (x, z, s = 1, rot = 0) => {
    const T = W.T, M = W.M, g = new T.Group();
    g.add(W.cyl(2.4 * s, 2.4 * s, 1.8 * s, M.white, 0, .9 * s, 0, 20), W.cyl(2.42 * s, 2.42 * s, .25 * s, M.blue, 0, 1.55 * s, 0, 20),
      new T.Mesh(new T.ConeGeometry(2.7 * s, 1.3 * s, 20), M.white), W.cyl(.35 * s, .35 * s, .2 * s, M.red, 0, 3.1 * s, 0), W.box(.9 * s, 1.3 * s, .2 * s, M.red, 0, .65 * s, 2.38 * s));
    g.children[2].position.y = 2.45 * s;
    W.place(g, x, z); g.rotation.y = rot; W.scene.add(W.shadowed(g)); W.solid(x, z, 2.5 * s, 'ger'); return g;
  };
})();
