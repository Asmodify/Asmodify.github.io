#!/usr/bin/env node
/* Headless test drive for the 3D world.
   Serves the repo root on an ephemeral port, loads index.html in headless Chromium
   (SwiftShader WebGL), clicks Start, drives for a bit, and reports console errors,
   page errors, fps, renderer stats and the result of an optional script.

   usage: node test/drive.mjs [--page index.html] [--shots DIR] [--drive SECONDS] [--only mod1,mod2]
                              [--mobile] [--night] [--teleport X,Z] [--eval "JS"] [--eval-file FILE]
   --eval runs in the page after start; it may return a promise; `W` is the world.
   Exit code 1 when any error was captured. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes(name);
const page = opt('--page', 'index.html'), shots = opt('--shots', null), driveS = +opt('--drive', '2');
let evalJs = opt('--eval', null); const evalFile = opt('--eval-file', null); if (evalFile) evalJs = fs.readFileSync(evalFile, 'utf8');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };
// --only terrain,roads : serve every other optional module (audio, terrain, roads, buildings, foliage, missions)
// as an empty stub, so a module can be tested on its own while the others are being written.
const only = opt('--only', null); const onlySet = only ? new Set(only.split(',').map(s => s.trim())) : null;
const OPTIONAL = ['audio', 'terrain', 'roads', 'buildings', 'foliage', 'missions'];
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const p = path.join(root, rel);
  const mod = rel.match(/^js\/(\w+)\.js$/);
  if (onlySet && mod && OPTIONAL.includes(mod[1]) && !onlySet.has(mod[1])) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`/* ${mod[1]} stubbed by --only */`); return; }
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('not found: ' + req.url); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let pw;
try { pw = await import(path.join(execSync('npm root -g').toString().trim(), 'playwright/index.mjs')); }
catch (e) { pw = await import(createRequire(import.meta.url).resolve('playwright')); }
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = flag('--mobile') ? { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } };
const p = await browser.newPage(ctx);
const errors = [], warnings = [];
p.on('pageerror', e => errors.push('pageerror: ' + e.message));
p.on('console', m => { const t = m.text(); if (m.type() === 'error') errors.push('console.error: ' + t); else if (m.type() === 'warning') warnings.push(t); });
p.on('requestfailed', r => errors.push('request failed: ' + r.url()));
p.on('response', r => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });

const url = `http://127.0.0.1:${port}/${page}`;
const t0 = Date.now();
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__world && window.__world.scene, null, { timeout: 60000 }).catch(() => errors.push('world did not boot within 60s'));
const bootMs = Date.now() - t0;
if (shots) { fs.mkdirSync(shots, { recursive: true }); await p.screenshot({ path: path.join(shots, 'intro.png') }); }
await p.click('#start').catch(e => errors.push('no #start: ' + e.message));
if (flag('--night')) await p.keyboard.press('KeyN');
const tp = opt('--teleport', null);
if (tp) { const [x, z] = tp.split(',').map(Number); await p.evaluate(([x, z]) => { const c = window.__world.car; c.x = x; c.z = z; c.v = 0; c.airborne = false; c.y = window.__world.groundY(x, z); }, [x, z]); }
await p.waitForTimeout(800);
if (driveS > 0) { await p.keyboard.down('KeyW'); await p.waitForTimeout(driveS * 1000); await p.keyboard.up('KeyW'); await p.waitForTimeout(600); }
if (shots) await p.screenshot({ path: path.join(shots, 'drive.png') });

let evalResult = null;
if (evalJs) {
  try { evalResult = await p.evaluate(`(async () => { const W = window.__world; ${evalJs} })()`); }
  catch (e) { errors.push('eval failed: ' + e.message); }
}
if (shots) await p.screenshot({ path: path.join(shots, 'after-eval.png') });

const stats = await p.evaluate(() => { const W = window.__world; const i = W.renderer.info; return { fps: Math.round(W.fps), calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, solids: W.solids.length, bodies: W.bodies.length, stations: W.stations.length, car: { x: +W.car.x.toFixed(1), y: +W.car.y.toFixed(2), z: +W.car.z.toFixed(1), kmh: Math.round(W.car.kmh), onRoad: W.car.onRoad } }; }).catch(e => ({ statsError: e.message }));
await browser.close(); server.close();
console.log(JSON.stringify({ url, bootMs, stats, evalResult, warnings: warnings.slice(0, 10), errors }, null, 2));
process.exit(errors.length ? 1 : 0);
