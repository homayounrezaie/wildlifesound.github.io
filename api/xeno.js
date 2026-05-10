// Xeno-canto reference recordings proxy.
// Keeps XENO_CANTO_API_KEY out of browser code.

const XC_ENDPOINT = 'https://xeno-canto.org/api/3/recordings';

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toAbsoluteUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function buildQuery(scientificName, commonName) {
  const scientific = cleanName(scientificName);
  const common = cleanName(commonName);

  if (/^[A-Z][a-z]+ [a-z-]+/.test(scientific)) {
    const [gen, sp] = scientific.split(/\s+/);
    return `gen:${gen.toLowerCase()} sp:${sp.toLowerCase()} q:">C"`;
  }

  if (common) return `en:"=${common.toLowerCase()}" q:">C"`;
  return '';
}

function normalizeRecording(recording) {
  return {
    id: recording.id,
    commonName: recording.en || '',
    scientificName: [recording.gen, recording.sp].filter(Boolean).join(' '),
    type: recording.type || '',
    quality: recording.q || '',
    length: recording.length || '',
    country: recording.cnt || '',
    location: recording.loc || '',
    recordist: recording.rec || '',
    license: toAbsoluteUrl(recording.lic),
    url: toAbsoluteUrl(recording.url),
    file: toAbsoluteUrl(recording.file),
    sonogram: toAbsoluteUrl(recording.sono?.large || recording.sono?.med || recording.sono?.small),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const key = process.env.XENO_CANTO_API_KEY;
  if (!key) {
    return res.status(200).json({ recordings: [], note: 'XENO_CANTO_API_KEY is not set' });
  }

  const query = buildQuery(req.query?.scientific, req.query?.common);
  if (!query) return res.status(400).json({ error: 'Missing species name' });

  const url = new URL(XC_ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('key', key);
  url.searchParams.set('per_page', '50');

  let upstream;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(9000) });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Xeno-canto request failed' });
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || data.error) {
    return res.status(upstream.status || 502).json({
      error: data.error?.message || 'Xeno-canto request failed',
    });
  }

  const recordings = (data.recordings || [])
    .filter(r => r.file && r.q && ['A', 'B'].includes(r.q))
    .slice(0, 3)
    .map(normalizeRecording);

  return res.status(200).json({ recordings });
}
