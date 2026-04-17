// Serverless proxy — GEMINI_API_KEY never reaches the browser.
// Set it in: Vercel dashboard → Project → Settings → Environment Variables
export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { message: 'GEMINI_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables.' }
    });
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // req.body is auto-parsed by Vercel; re-stringify for the upstream request
      body: JSON.stringify(req.body)
    }
  );

  const data = await upstream.json();
  return res.status(upstream.status).json(data);
}
