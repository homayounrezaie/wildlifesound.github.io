// Serverless proxy for global sightings — reads and writes to Supabase.
// SUPABASE_URL and SUPABASE_SERVICE_KEY are optional and can live in .env.local.
// If Supabase is not configured, reads return an empty public map and writes are disabled.
//
// GET  /api/sightings        → return all sightings (public, anyone sees the map)
// POST /api/sightings        → save a new sighting (Auth0-verified users only)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    if (req.method === 'GET') return res.status(200).json([]);
    if (req.method === 'POST') {
      return res.status(503).json({
        error: 'Sightings database is not configured. Analysis still works, but logging sightings is disabled.'
      });
    }
  }

  const sbHeaders = {
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type':  'application/json'
  };

  // ── GET: fetch all sightings ordered newest first ──────────────────────
  if (req.method === 'GET') {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/sightings?select=*&order=timestamp.desc`,
      { headers: sbHeaders }
    );
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(r.ok ? data : { error: data });
  }

  // ── POST: insert a new sighting ────────────────────────────────────────
  if (req.method === 'POST') {
    const { common_name, scientific_name, iucn_category,
            lat, lng, city, user_sub, user_email } = req.body || {};

    if (!common_name || !user_sub) {
      return res.status(400).json({ error: 'Missing required fields: common_name, user_sub.' });
    }

    const record = {
      id:              `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp:       new Date().toISOString(),
      common_name,
      scientific_name: scientific_name || null,
      iucn_category:   iucn_category   || 'DD',
      lat:             lat   ?? null,
      lng:             lng   ?? null,
      city:            city  || null,
      user_sub,
      user_email:      user_email || null
    };

    const r = await fetch(`${supabaseUrl}/rest/v1/sightings`, {
      method:  'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body:    JSON.stringify(record)
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.message || err.hint || 'Insert failed.' });
    }

    return res.status(201).json({ success: true, record });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
