// Local API proxy — GEMINI_API_KEY never reaches the browser during local dev.
// Tries multiple models and retries on 429/503 (overload/rate-limit).

const MODELS = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
];
const MAX_RETRIES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { message: 'GEMINI_API_KEY is not set. Add it to .env.local and restart the local server.' }
    });
  }

  const runModel = async (model) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${key}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2 ** attempt * 1000); // 2s then 4s

      let upstream;
      try {
        upstream = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body)
        });
      } catch {
        continue; // network blip — retry
      }

      if (upstream.ok) {
        const data = await upstream.json();
        return { ok: true, model: model.id, label: model.label, data };
      }

      // Overloaded or rate limited — retry same model
      if (upstream.status === 503 || upstream.status === 429) {
        if (attempt < MAX_RETRIES - 1) continue;
        break; // exhausted retries on this model, try next
      }

      // 404 = model deprecated, any other error — skip to next model
      break;
    }
    return { ok: false, model: model.id, label: model.label };
  };

  const results = await Promise.all(MODELS.map(runModel));
  const successful = results.filter(r => r.ok);
  if (successful.length) {
    const primary = successful[0].data;
    return res.status(200).json({
      ...primary,
      _modelRuns: successful.map(r => ({
        model: r.model,
        label: r.label,
        response: r.data
      }))
    });
  }

  // Every model and every retry failed
  return res.status(503).json({
    error: {
      message: 'Gemini is currently overloaded across all available models. Please wait 30 seconds and try again.'
    }
  });
}
