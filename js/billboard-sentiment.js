/* SentimentAI station: a "try the model" box for the 3D world's SentimentAI panel.
 *
 * Needs js/sentiment-live.js loaded first. Usage from the world code, once the panel for the
 * `senti` station is in the DOM:
 *
 *   mountSentimentPanel(panelEl, {
 *     onResult: r => tintBillboard(r.label, r.polarity),   // optional: recolour the 3D billboard
 *   });
 *
 * Key events inside the box are stopped from bubbling, so typing W/A/S/D or arrows does not drive
 * the truck while a visitor writes a comment. Returns a function that removes the box. */
(function () {
  const COLORS = { positive: '#1f9d55', negative: '#d64545', neutral: '#8a8f98' };
  const MODEL_NAMES = { transformer: 'Mongolian BERT', lexicon: 'lexicon' };

  function mountSentimentPanel(panel, { onResult } = {}) {
    const box = document.createElement('form');
    box.className = 'senti-live';
    box.innerHTML = `
      <label for="sentiLiveText">Try the model</label>
      <div style="display:flex;gap:8px;margin-top:6px">
        <input id="sentiLiveText" maxlength="1000" autocomplete="off" style="flex:1;min-width:0;padding:6px 8px;font:inherit"
               value="Энэ апп үнэхээр гоё байна">
        <button type="submit" style="padding:6px 12px;font:inherit;cursor:pointer">Score</button>
      </div>
      <p class="senti-live-out" aria-live="polite" style="margin:6px 0 0;font-family:monospace"></p>`;
    const input = box.querySelector('input'), btn = box.querySelector('button'), out = box.querySelector('.senti-live-out');
    const stop = e => e.stopPropagation();
    box.addEventListener('keydown', stop);
    box.addEventListener('keyup', stop);

    box.addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !window.SentimentLive) return;
      btn.disabled = true; out.style.color = ''; out.textContent = 'asking the model…';
      try {
        const r = await SentimentLive.analyze(text, { onWaking: () => { out.textContent = 'waking the model up, this can take a minute…'; } });
        out.style.color = COLORS[r.label];
        out.textContent = `${r.label} · ${Math.round(r.confidence * 100)}% · ${MODEL_NAMES[r.model] || r.model}`;
        onResult?.(r);
      } catch {
        out.textContent = 'the live model is offline right now, try again later';
      } finally { btn.disabled = false; }
    });

    panel.appendChild(box);
    return () => box.remove();
  }

  window.mountSentimentPanel = mountSentimentPanel;
})();
