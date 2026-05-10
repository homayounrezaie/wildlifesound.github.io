// Optional NatureLM-audio proxy.
// NatureLM is not hosted by Hugging Face Inference Providers, so this route
// forwards audio to a user-run NatureLM service when NATURELM_API_URL is set.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  const upstreamUrl = process.env.NATURELM_API_URL;
  if (!upstreamUrl) {
    return res.status(200).json({
      model: 'NatureLM-audio',
      disabled: true,
      message: 'Set NATURELM_API_URL to a running NatureLM service.',
      species: []
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.NATURELM_API_TOKEN || process.env.HF_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        audio_base64: req.body?.audio_base64,
        mime_type: req.body?.mime_type || 'audio/webm',
        query: req.body?.query || 'What species are audible in this audio?'
      }),
      signal: AbortSignal.timeout(120_000)
    });
  } catch (err) {
    return res.status(502).json({
      error: { message: `NatureLM-audio request failed: ${err.message}` }
    });
  }

  const contentType = upstream.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await upstream.json().catch(() => ({}))
    : { raw_text: await upstream.text().catch(() => '') };

  if (!upstream.ok) {
    return res.status(upstream.status).json({
      error: { message: payload?.error?.message || payload?.message || `NatureLM-audio HTTP ${upstream.status}` }
    });
  }

  return res.status(200).json({
    model: 'NatureLM-audio',
    ...payload
  });
}
