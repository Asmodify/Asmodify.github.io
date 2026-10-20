/* main.js — boot. Gives the fonts a moment (canvas labels look better with them), then starts
   the engine; buildings.js redraws its signs if the fonts arrive later. Module load order is fixed
   by index.html: core, audio, terrain, roads, buildings, stations, missions, foliage, main. */
(async () => {
  const intro = document.getElementById('intro');
  if (!window.THREE || !window.W) { intro.querySelector('p').innerHTML = 'The 3D engine could not load. <a href="classic.html">Open the classic portfolio.</a>'; return; }
  try { await Promise.race([Promise.all([document.fonts.load('800 64px Archivo'), document.fonts.load('500 20px "IBM Plex Mono"'), document.fonts.load('600 20px "IBM Plex Sans"')]), new Promise(r => setTimeout(r, 1200))]); } catch (e) { }
  try { W.boot(); } catch (e) { console.error(e); intro.querySelector('p').innerHTML = 'The world failed to build. <a href="classic.html">Open the classic portfolio.</a>'; return; }
  window.__world = W; // handy for debugging and for the test harness
})();
