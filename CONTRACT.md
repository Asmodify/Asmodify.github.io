# World modules: the contract

The homepage (`index.html`) is a drivable 3D world built with three.js **r128** (vendored at `vendor/three.r128.min.js`, a classic UMD script: the global is `THREE`). It is plain static files on GitHub Pages: no bundler, no npm at runtime, no network except Google Fonts. Everything else (geometry, textures, sound, music) is generated in code.

`js/core.js` is the engine. It owns the renderer, scene, camera, lights, sky, fog, clouds, the truck, physics, input, HUD, minimap, panel and the frame loop. It exposes one global, `window.W`. Every other file is a **module** that registers content through `W` and never touches the renderer, camera or DOM directly (HUD goes through `W.hud`, panels through `W.openPanel`).

Load order (fixed by `index.html`): `core → audio → terrain → roads → buildings → stations → missions → foliage → main`. A module's top level runs at load time, but **all world building happens inside `W.onReady(fn)`**, which `main.js` fires once fonts are loaded (or after 1.2 s, whichever comes first). Ready hooks run in load order, so `roads` can read `W.terrain`, `buildings` can read `W.roads`, `missions` can read `W.places`, `W.roads.loop` and `W.stations`, and `foliage` runs last so it can honour every `W.reserve` claim.

A module is one IIFE, no top-level `const` leaking into the global scope, no ES modules, no `import`. Example: `js/stations.js`.

## The API (window.W)

Engine objects: `W.T` (THREE), `W.scene`, `W.camera`, `W.renderer`, `W.sun`, `W.hemi`, `W.truck` (Group), `W.truckBody`, `W.truckCargo` (Group on the cargo bed, origin at the bed's top, for attaching loads), `W.car`.

Random (deterministic, use it instead of Math.random so the world is the same every visit): `W.rng()` → [0,1), `W.rand(a,b)`, `W.reseed(n)`. Math: `W.clamp`, `W.lerp`, `W.smoothstep(a,b,x)`.

Materials: `W.mat(hexColor, {rough, metal, flat, emissive, ei, side})` cached MeshStandardMaterial; presets in `W.M`: truck, cab, dark, glass, grey, blue, white, rock, red, crate, cone, wood, concrete, brick, asphalt, dirt, steel, rust, grassDark, leaf, leafLight, trunk, snow, window, lamp, sand, pad. `W.M.window` and `W.M.lamp` have an emissive that core turns on at night; push your own glow materials into `W.nightGlow` to get the same.

Geometry helpers: `W.box(w,h,d,mat,x,y,z)`, `W.cyl(rTop,rBottom,h,mat,x,y,z,segments)`, `W.ring(r,width,color,opacity)` (flat ring, already rotated), `W.shadowed(obj)` (cast+receive on every mesh), `W.textTex([title, subtitle], opts)` canvas texture, `W.decal(tex,w,h)` flat ground text, `W.sprite(text, {scale})` camera-facing label, `W.windowTex(cols, rows, {lit, pane, wall})` window-grid texture for buildings, `W.ger(x,z,scale,rot)` a yurt (defined in stations.js, available in ready hooks).

Ground: `W.terrain` (set by terrain.js; see below), `W.groundY(x,z)` height of whatever you can drive on at (x,z) (terrain or the highest surface), `W.addSurface({height(x,z) → number|null})` for bridges, ramps and decks the truck should drive on (return `null` outside the surface), `W.surfaceY(x,z)`, `W.inWater(x,z)`, `W.place(obj, x, z, yOffset)` sets `obj.position` to the ground at (x,z).

Colliders: `W.solid(x,z,r,tag)` static circle the truck and pushables cannot enter (returns the object; mutate `x`/`z` each frame for moving things like a train; set `yMax` to let the truck pass when above it, e.g. on a bridge; set `onHit(impact)` to hear the truck's pre-bounce speed when it hits). `W.pushable(mesh, halfHeight, r, {tag, onHit(body, speed), grounded})` a physics prop the truck knocks around; returns a body `{mesh, v, w, rest, home}`; `W.resetBody(body)` puts it back; pass `grounded: false` to keep the mesh's own y instead of dropping it onto the terrain. Pushables are added to the scene for you. `W.reserve(x,z,r,tag)` claims ground without a collider (a lane, a ramp approach, a loading bay) so later modules keep off it. `W.breakable(bodyOrSolid, {at, colors, n, size, kind, y, onBreak, onRestore})` makes a pushable or a solid shatter when the truck hits it at `at` m/s or faster (a flung pushable also breaks on a solid at that speed): the engine hides a body's mesh and skips it, marks a solid `dead`, throws `n` debris pieces of `colors` and `size` from one shared InstancedMesh, plays `W.sfx('crash', {kind})` (`wood`, `metal`, `rock`, `glass`, `plastic`) and counts it in the HUD; a module hides its own instanced visuals in `onBreak` and shows them again in `onRestore`. `W.reset` restores everything (bodies through `W.resetBody`, solids through `W.restoreBroken`). `W.shatter(x,y,z,opts)` throws debris on its own. `W.isClear(x,z,r)` true when nothing important is within r: the centre plaza, water, stations, places, roads, solids and reserved ground. Use it before scattering trees or rocks.

Registries: `W.addStation({id,x,z,r,color,title,html,onEnter,onLeave,onInside(dt)})` a ring you park on (core opens `html` in the panel); `W.addPlace(id, {x,z,r,label,hidden})` named locations for missions and `isClear`, drawn as small dots on the minimap unless `hidden`; `W.places[id]`; `W.markers` array of `{x,z,color,big}` drawn on the minimap (push/splice it yourself); `W.setTarget({x,z,color}|null)` guide arrow above the truck plus a pulsing minimap ring.

UI: `W.toast(text)`, `W.openPanel(html, {id, sticky, refresh})` (sticky panels are not auto-closed when leaving a station, but give way when the truck enters one; `refresh: true` swaps the html in place when the same `id` is already open, without the open animation), `W.closePanel()`, `W.hud.set(id, html)` a small card under the name badge (returns the element), `W.hud.remove(id)`, `W.hud.button(label, onClick, {id, title})` a chip in the top-right row.

Input: `W.keys` booleans `fwd back left right boost brake action horn`; `W.onAction(fn)` fires on E / Enter / the touch E button (return `true` to stop other handlers). Core also binds R reset, N night, M mute, C camera zoom, Esc close panel, H horn (calls `W.sfx('horn')`).

Hooks: `W.onReady(fn)` build the world; `W.onUpdate(fn(dt, nowMs))` every frame after physics (dt in seconds, capped at .05); `W.onReset(fn)` after R; `W.onNight(fn(isNight))`.

Car state `W.car`: `x z y h` (heading, radians, forward = `(sin h, cos h)`), `v` (m/s, +forward), `vy`, `airborne`, `airTime`, `onRoad`, `inWater`, `fuel`, `maxFuel`, `kmh`, `odometer`. `W.started` is true after the Start button. `W.night`, `W.setNight(bool)`. `W.setStart(x,z,h)`. `W.reset()`.

Audio (implemented by audio.js, stubbed by core so calls are always safe): `W.sfx(name, opts)`; `W.audio.init()` (core calls it from the Start click: that is the user gesture), `W.audio.engine(speed01, throttle01, airborne)` (core calls every frame), `W.audio.music(on)`, `W.audio.setMuted(bool)`, `W.audio.muted`.

Effects: `W.puff(x,z,size,color)` a dust puff. Helpers for text: fonts Archivo (display), IBM Plex Mono, IBM Plex Sans are loaded before ready hooks run.

## World plan (coordinates are fixed so modules agree)

Units are metres. `x` east, `z` south (screen-down), `y` up. The drivable disc has radius `W.terrain.driveRadius = 118`; the terrain mesh extends to ±170 so mountains fill the horizon. Heading 0 faces +z.

| Thing | Where | Owner |
|---|---|---|
| Start, centre plaza, name blocks | (0, 6), plaza radius 24, flat at y = 0 | stations.js |
| Open T station | (−28, −2) r 5 | stations.js |
| Fuel station | (26, −4) r 5 | stations.js |
| SentimentAI station | (−22, 26) r 5 | stations.js |
| About station + ger camp | (24, 28) r 5, camp place (29, 22) | stations.js |
| Ring road (asphalt, closed loop, driven clockwise on screen) | control points (0,−44) (38,−32) (56,8) (42,46) (2,56) (−40,46) (−58,6) (−40,−34) | roads.js |
| North spur + bridge to the town | (0,−44) → bridge over the river at about (18,−76) → town (28,−100) | roads.js |
| East spur to the mine | (56,8) → (92,42) | roads.js |
| South spur to the rail station | (2,56) → (6,98) | roads.js |
| Dirt tracks | ring → each station, ring → plaza (0,−44)→(0,−24), ring → power plant, ring → wind farm, ring → lake shore | roads.js |
| River | polyline (−130,−58) (−70,−64) (−20,−74) (30,−78) (80,−70) (130,−82), bed width ≈ 9, bed y ≈ −2.6, water level y = −1.2 | terrain.js |
| Lake | centre (−92, 52) radius 15, bed y ≈ −3 | terrain.js |
| Town "Khuslen Khot" | place (28,−100) r 22, pad y = 1.0 | buildings.js |
| Mine | place (92,42) r 18, pad y = 2.0 | buildings.js |
| Power plant | place (−86,−26) r 16, pad y = 1.0 | buildings.js |
| Bus terminal | place (62,−22) r 12, pad y = 0.5 | buildings.js |
| Rail station + railway | place (6,98) r 14, pad y = 0; track along z = 94 from x = −115 to 115, strip flattened to y = 0 | buildings.js (terrain flattens) |
| Wind farm | hills around (−70, 78), no pad | buildings.js |
| Mountains | ring from r ≈ 120 outward, peaks 35–60 m at r ≈ 150–165, snow above ≈ 30 m | terrain.js |

Terrain height zones: inner plateau r < 70 gentle (|h| ≤ 1.5 m, wavelengths ≥ 40 m) so roads and stations stay drivable; stations, the plaza and the pads above are flattened exactly to their pad height with a smooth blend (blend width ≈ 8 m); rolling hills 70 < r < 118 up to ≈ 7 m; the river and lake are cut below water level; beyond 118 the mountains rise steeply.

## Module responsibilities

**terrain.js**: builds `W.terrain = { height(x,z), normal(x,z), isWater(x,z), waterLevel, color(x,z) (hex string for the minimap), driveRadius: 118, size: 340 }` at load time (not in a ready hook: others may call `height` in their ready hooks, and `W.groundY` must work before anything is placed), then in a ready hook adds the terrain mesh (one PlaneGeometry ≈ 170×170 segments with vertex colours: grass by height, dirt near water, rock on steep slopes, snow high up), a water plane at `waterLevel` with a slow animated shimmer, mountain rim, and nothing else. The height function must be cheap (it is called thousands of times per frame by physics and foliage placement): a few octaves of smooth value noise seeded by `W.rng`, plus the masks above. Keep `normal` finite-difference based.

**roads.js**: builds `W.roads = { distance(x,z) → metres to the nearest road centreline, polylines: [{points:[{x,z}…], closed, dirt, width}], loop: [{x,z}…] (the ring sampled every ≈ 2 m in driving direction, closed), nearest(x,z) → {x,z,t} }` and the road meshes: ribbons that follow `W.groundY` (sample every 2 m, y = ground + 0.06), asphalt with a dashed centre line and lighter edges, dirt tracks plain. The bridge: a deck registered with `W.addSurface` plus railings and abutments; the river band under it must stay water. Road signs at junctions (text via `W.textTex`), a few guard rails on bends, a start/finish gantry on the ring at (0,−44). `distance` must be fast (core calls it every frame; precompute segments, use a coarse grid or early-out by bounding boxes).

**buildings.js**: all man-made structures listed in the plan plus their `W.addPlace` entries, solids and night lighting. Town: 10–14 apartment blocks with `W.windowTex`, a shop with a sign, a small square with an obelisk, streetlights (`W.M.lamp` heads; at most 6 PointLights, intensity 0 by day and set via `W.onNight`), parked cars as pushables or solids, bus stop. Power plant: tall chimneys with slow smoke (a few meshes rising and fading in `W.onUpdate`), turbine hall, pipes, a fence. Mine: an open-pit look (terraced rock rings), a conveyor, a huge dump truck, ore piles (pushable rocks), a sign. Bus terminal: hall with a "Mongol BUS terminal" sign, platform, three buses. Railway: sleepers (InstancedMesh), two rails, a station building with platform, a freight train (loco + 6 wagons) that shuttles along the track in `W.onUpdate`, with each car a moving `W.solid` (mutate x) and a horn (`W.sfx('train')`) when it reverses. Wind farm: 5 turbines whose rotors spin. A telecom/GPS mast with a blinking light. A few more gers (`W.ger`) near the lake and on the hills. An Open T billboard beside the ring road. Also `W.addPlace` for `town, mine, powerplant, busTerminal, railStation, windfarm, lake`.

**foliage.js**: forests and ground cover using `THREE.InstancedMesh` only (budget: ≤ 12 draw calls, ≤ 200k triangles): larch/pine (trunk + two cones) on the hills and mountain lower slopes with higher density on the north and east, birch near the river, saxaul bushes on the steppe, rocks (dodecahedra) everywhere sparse, grass tufts (thousands) on the plateau, reeds at the lake and river banks. Place with `W.isClear(x,z,r)` and `W.groundY`; never on water, roads, stations, places or above the snow line. Trees inside the drivable disc register `W.solid(x,z,0.6,'tree')`; rocks bigger than 1 m register solids too. Scale/tint variation through instance matrices (and `setColorAt` where it helps).

**missions.js**: the playable layer. A Missions chip (`W.hud.button`) and the E key at the depot open a mission board panel (sticky) listing: (1) **Delivery runs**: load cargo at the Open T depot, deliver to the town, the mine or the rail station against a timer; crates appear on `W.truckCargo`; a destination ring and `W.setTarget`; best time per route saved in `localStorage` under `khuslen.world.*` (wrapped in try/catch). (2) **Steppe Rally**: 7 gates placed along `W.roads.loop`, pass them in order from the start gantry at (0,−44) and finish back through it; lap timer in the HUD; best lap saved. (3) **Tracker hunt**: 8 hidden GPS trackers (small blinking boxes) around the map, collect by driving over; HUD counter; a chime per tracker and a reward message at 8/8. (4) **Big Air**: three jump ramps (meshes plus `W.addSurface`, kerbed with `yMax` solids) at spots chosen at runtime clear of roads and places (see `W.missions.spots.ramps`); best airtime from `W.lastAir`. (5) **Bowling**: ten pins (pushable cones) in a triangle on a lane chosen at runtime from candidates near the depot and the fuel station (`W.missions.spots.lane`), with a reset; strike detection and a score toast. (6) **Fuel theft alert**: a thief van spawns at the depot and flees along the ring road as a moving `W.solid`; ram it within 60 s to catch it (ties into the Fuel Tank Warner project). One active mission at a time, cancel from the board, HUD card with objective and timer, `W.markers`, `W.sfx` names below. Everything restores on `W.onReset`.

**audio.js**: Web Audio only (no files). Replace `W.audio` with `{ ready, muted, init(), sfx(name, opts), engine(speed01, throttle01, airborne), music(on), setMuted(bool) }` and add a mute chip (`W.hud.button('♪', …)`) that reflects state (`chip.classList.toggle('on')`). `init()` creates the AudioContext on the Start click (resume it on later `visibilitychange`/click if suspended) and must be safe to call twice. Engine: a looping diesel-ish tone (two detuned oscillators + lowpass + gentle noise) whose pitch and gain follow speed and throttle, quieter when airborne. SFX names used by core and missions: `open` (panel), `bonk` (hit a solid, `opts.v` speed), `hit` (knock a pushable), `land`, (`opts.hard`), `horn`, `skid`, `refuel`, `collect`, `checkpoint`, `success`, `fail`, `start`, `click`, `cargo`, `train`, `cash`. Unknown names must not throw. Music: a procedural, loopable steppe theme: a low drone (morin-khuur-like sawtooth through a lowpass with slow vibrato), a pentatonic melody (A minor pentatonic or similar, 90–100 bpm, scheduled ahead with the Web Audio clock), soft percussion, overall gain ≈ −18 dB so the engine and SFX sit on top. Must sound musical, not random: write a fixed 8–16 bar melody in code and vary ornaments. Remember `localStorage` for the mute preference (try/catch).

## Rules

- Three r128 only: `PlaneGeometry`/`BoxGeometry` etc. are BufferGeometries, legacy `Geometry` does not exist, `BufferGeometryUtils` is **not** available (no merging helper; use InstancedMesh or build one BufferGeometry yourself), `InstancedMesh` with `setMatrixAt`/`setColorAt` is available, `MeshStandardMaterial({ vertexColors: true })` reads a `color` attribute. No `outputEncoding`/sRGB changes (colours are tuned for the default).
- Use `W.rng`, never `Math.random`. No network, no external images except the four files in `img/`. No new libraries. No ES modules.
- Performance budget for the whole page: ≤ 260 draw calls, ≤ 700k triangles, shadows only on things near the truck matter (the shadow camera is ±48 m around it). Prefer InstancedMesh for anything repeated more than ~20 times. Do not add lights other than those listed for buildings.
- Nothing may throw during load or in a frame. Wrap `localStorage` in try/catch. Guard everything optional (`W.roads &&`, `W.places.town &&`).
- The page must still work with your module stubbed out (the test harness does this), and your module must work with the others stubbed out: never assume another module's output exists; fall back gracefully (e.g. flat ground, no roads).
- Keep the visual language: low-poly flat colours, the palette in `W.M`, Open T yellow `#f7bd0c` and blue `#1f4fd1` as accents, Mongolian steppe references (gers, larch, saxaul, the UB power-plant chimneys, mining trucks).
- Text the user reads is plain English, short, no emoji except where already used; Mongolian names are welcome on signs.

## Testing

`node test/drive.mjs --only <yourmodule> --shots /tmp/shots/<yourmodule>` serves the repo on a random port, loads the page in headless Chromium with your module plus core and stations (everything else stubbed), clicks Start, drives forward 2 s and prints JSON: errors (must be `[]`), fps, draw calls, triangles, car state, plus `intro.png`, `drive.png`, `after-eval.png` in the shots folder (Read them: they are real renders). `--teleport X,Z` moves the truck before driving, `--night` toggles night, `--mobile` uses a phone viewport, `--eval "JS"` runs code in the page after start with `W` bound (may `await`, `return` JSON). Example: `--teleport 28,-100 --drive 0 --eval "return {y: W.groundY(28,-100), places: Object.keys(W.places)}"`. Running without `--only` is the full integration. Chromium here is software-rendered, so fps is low in the harness; judge performance by draw calls and triangles.
