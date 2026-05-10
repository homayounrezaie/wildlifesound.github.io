// Bird detection via multiple HuggingFace models running in parallel.
// Each model's detections are tagged with their model name so the UI
// can show which model identified each species.
//
// Models:
//   1. DBD-research-group/AST-BirdSet-XCL — 4,941 species, eBird codes
//   2. dima806/bird_sounds_classification  — broad bird classifier, common labels

const HF_BASE = 'https://router.huggingface.co/hf-inference/models';

const MODELS = [
  { id: 'DBD-research-group/AST-BirdSet-XCL', source: 'BirdNET/AST' },
  { id: 'dima806/bird_sounds_classification',  source: 'BirdNET/W2V' },
];

async function queryModel(model, audioBuffer, mimeType, token) {
  const url = `${HF_BASE}/${model.id}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': mimeType || 'audio/webm',
        'Accept': 'application/json',
      },
      body: audioBuffer,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    return { model: model.source, error: err.message, detections: [] };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 503 = model loading — return retry hint
    if (res.status === 503) {
      let eta = 25;
      try { eta = JSON.parse(text).estimated_time || 25; } catch {}
      return { model: model.source, loading: true, retry_after: Math.ceil(eta), detections: [] };
    }
    return { model: model.source, error: `HTTP ${res.status}`, detections: [] };
  }

  const raw = await res.json().catch(() => []);
  const detections = (Array.isArray(raw) ? raw : [])
    .filter(d => d.score > 0.01)
    .slice(0, 8)
    .map(d => ({
      label: d.label,
      score: Math.round(d.score * 100),
      source: model.source,
    }));

  return { model: model.source, detections };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const token = process.env.HF_TOKEN;
  if (!token) {
    return res.status(200).json({ results: [], note: 'HF_TOKEN not set' });
  }

  const { audio, mimeType } = req.body || {};
  if (!audio) return res.status(400).json({ error: 'Missing audio (base64)' });

  const audioBuffer = Buffer.from(audio, 'base64');

  // Query all models in parallel
  const modelResults = await Promise.all(
    MODELS.map(m => queryModel(m, audioBuffer, mimeType, token))
  );

  // If any model is still loading, tell client to retry after the longest wait
  const loadingModels = modelResults.filter(r => r.loading);
  if (loadingModels.length === MODELS.length) {
    const maxWait = Math.max(...loadingModels.map(r => r.retry_after || 25));
    return res.status(503).json({ error: 'Models loading', retry_after: maxWait });
  }

  return res.status(200).json({ results: modelResults });
}
