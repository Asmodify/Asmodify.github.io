/* Live SentimentAI client: calls the Gradio Space that serves the thesis model.
 *
 *   const r = await SentimentLive.analyze('Энэ апп үнэхээр гоё байна', { onWaking })
 *   // { label, polarity, confidence, distribution, emotion, language, model, ... }
 *
 * Gradio's REST API is two steps: POST queues the call and returns an event id, then a GET streams
 * server-sent events until `event: complete` (or `event: error`). A free Space sleeps when idle, so
 * the first call can take a while; `onWaking` fires if the answer has not arrived after 4 s.
 * Throws on any failure so callers can fall back to something local. */
(function () {
  const ENDPOINT = 'https://kkhaito-sentimentai.hf.space';
  const TIMEOUT_MS = 90000;

  async function analyze(text, { onWaking, signal } = {}) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort);
    const timer = setTimeout(abort, TIMEOUT_MS);
    const waking = onWaking ? setTimeout(onWaking, 4000) : 0;
    try {
      const post = await fetch(`${ENDPOINT}/gradio_api/call/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [String(text).slice(0, 1000)] }),
        signal: ctrl.signal,
      });
      if (!post.ok) throw new Error(`queue failed: HTTP ${post.status}`);
      const { event_id } = await post.json();
      const res = await fetch(`${ENDPOINT}/gradio_api/call/analyze/${event_id}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`result failed: HTTP ${res.status}`);
      const body = await res.text();
      // Each SSE message is "event: <name>\ndata: <json>"; take the last one that finished.
      let event = '';
      for (const line of body.split('\n')) {
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (event === 'complete') return JSON.parse(data)[0];
        if (event === 'error') throw new Error(`model error: ${data}`);
      }
      throw new Error('no result in response');
    } finally {
      clearTimeout(timer);
      clearTimeout(waking);
      signal?.removeEventListener('abort', abort);
    }
  }

  window.SentimentLive = { endpoint: ENDPOINT, analyze };
})();
