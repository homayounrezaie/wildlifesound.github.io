// Serverless proxy — IUCN_API_TOKEN never reaches the browser.
// Set it in: Vercel dashboard → Project → Settings → Environment Variables
// Usage: GET /api/iucn?type=species&name=Passer+domesticus
//         GET /api/iucn?type=narrative&name=Passer+domesticus
export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const token = process.env.IUCN_API_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'IUCN_API_TOKEN is not set. Add it in Vercel → Project Settings → Environment Variables.'
    });
  }

  const { type, name } = req.query;
  if (!type || !name) {
    return res.status(400).json({ error: 'Missing required query params: type, name.' });
  }
  if (type !== 'species' && type !== 'narrative') {
    return res.status(400).json({ error: 'type must be "species" or "narrative".' });
  }

  const enc = encodeURIComponent(name);
  const url = type === 'narrative'
    ? `https://apiv3.iucnredlist.org/api/v3/species/narrative/${enc}?token=${token}`
    : `https://apiv3.iucnredlist.org/api/v3/species/${enc}?token=${token}`;

  const upstream = await fetch(url);
  const data     = await upstream.json();
  return res.status(upstream.status).json(data);
}
