// Serverless proxy for IUCN Red List API v4.
// IUCN_API_TOKEN is optional and can live in .env.local.
// If it is not configured, the app still works with unknown conservation data.
//
// Usage: GET /api/iucn?name=Passer+domesticus
// Returns: { category, populationTrend, habitat }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const token = process.env.IUCN_API_TOKEN;
  if (!token) {
    return res.status(200).json({
      category: 'DD',
      populationTrend: 'Unknown',
      habitat: null,
      source: 'fallback'
    });
  }

  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing ?name= parameter.' });

  // Split "Genus species" into separate params required by v4 API
  const parts        = name.trim().split(/\s+/);
  const genus_name   = parts[0];
  const species_name = parts.slice(1).join(' ');

  if (!genus_name || !species_name) {
    return res.status(400).json({ error: 'name must be two words: "Genus species".' });
  }

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  const base    = 'https://api.iucnredlist.org/api/v4';

  try {
    // ── Step 1: taxa lookup → get latest assessment_id + category ──────────
    const taxaRes = await fetch(
      `${base}/taxa/scientific_name?genus_name=${encodeURIComponent(genus_name)}&species_name=${encodeURIComponent(species_name)}`,
      { headers }
    );
    const taxaData = await taxaRes.json();

    const assessments = taxaData.assessments || [];
    // Prefer the one marked latest; fall back to first
    const latest = assessments.find(a => a.latest === true) ?? assessments[0];

    if (!latest) {
      // Species not found in IUCN database
      return res.status(200).json({ category: 'DD', populationTrend: 'Unknown', habitat: null });
    }

    const category    = latest.red_list_category_code ?? 'DD';
    const assessmentId = latest.assessment_id;

    if (!assessmentId) {
      return res.status(200).json({ category, populationTrend: 'Unknown', habitat: null });
    }

    // ── Step 2: full assessment → population trend + habitat ───────────────
    const assessRes  = await fetch(`${base}/assessment/${assessmentId}`, { headers });
    const assessData = await assessRes.json();

    // v4 API uses nested objects — try the most likely field paths defensively
    const populationTrend =
      assessData.population_trend?.code ??
      assessData.population_trend?.description?.en ??
      assessData.populationTrend?.code ??
      'Unknown';

    const rawHabitat =
      assessData.habitat_and_ecology?.narrative?.en ??
      assessData.habitat_and_ecology?.habitat_narrative?.en ??
      assessData.habitat_narrative?.en ??
      assessData.habitat?.en ??
      null;

    let habitat = null;
    if (rawHabitat) {
      const clean = rawHabitat.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      habitat = clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
    }

    return res.status(200).json({ category, populationTrend, habitat });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
