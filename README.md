# asmodify.github.io

Personal portfolio of Khuslen (@Asmodify), served by GitHub Pages at https://asmodify.github.io.

No build step: edit and push to `main`.

## Pages

- `index.html` is a drivable Three.js world: a yellow Open T truck on the Mongolian steppe, four project stations (park on a glowing ring to open a project), a town, a mine, a power plant, a railway with a freight train, a wind farm, forests, a river with a bridge, a lake, mountains, missions, music and sound effects.
- `classic.html` is the plain one-page portfolio (fleet map, fuel-theft demo, sentiment toy, screenshots).
- `world-v1.html` is the first single-file version of the 3D world, kept for reference.

## Layout

| Path | What it is |
| --- | --- |
| `js/core.js` | Engine: renderer, sky, lights, truck physics, camera, HUD, minimap, input, hooks. Everything else goes through the `W` object. |
| `js/audio.js` | Web Audio engine sound, sound effects and the procedural steppe theme (no audio files). |
| `js/terrain.js` | Heightfield, vertex-coloured ground, river, lake, mountains, snow. |
| `js/roads.js` | Ring road, spurs, dirt tracks, the bridge, signs, guard rails, start gantry. |
| `js/buildings.js` | Town, power plant, mine, bus terminal, railway and train, wind farm, extra gers. |
| `js/foliage.js` | Instanced forests, bushes, rocks, grass and reeds. |
| `js/stations.js` | The four project stations, the name blocks and plaza props. |
| `js/missions.js` | Playable missions: deliveries, rally, tracker hunt, big air, bowling, fuel-theft chase. |
| `js/main.js` | Boots the world once fonts are ready. |
| `vendor/three.r128.min.js` | three.js r128 (UMD build). |
| `img/` | Screenshots used on the billboard and in `classic.html`. |
| `CONTRACT.md` | The `W` API every module is written against, plus the world plan with coordinates. |
| `test/drive.mjs` | Headless test drive (Playwright + Chromium): boots the page, drives, reports errors, draw calls and screenshots. |

Script load order in `index.html` matters: core, audio, terrain, roads, buildings, foliage, stations, missions, main.

## Controls

WASD or arrows to drive, Shift to boost, Space to brake, E to interact, H for the horn, N for night, M to mute, C to change the camera, R to reset. On phones the on-screen buttons do the same.

## Testing

```
node test/drive.mjs --shots /tmp/shots            # full world, 2 s of driving, screenshots
node test/drive.mjs --only terrain,roads          # stub every other optional module
node test/drive.mjs --teleport 28,-100 --night    # look at the town at night
node test/drive.mjs --eval "return W.missions.list.map(m => m.id)"
```

It needs a global Playwright install (`npm i -g playwright`) and a Chromium it can find.
