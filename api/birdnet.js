import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BIN = '/tmp/birdnet-test-venv313/bin/birdnet-analyze';

function extForMime(mimeType = '') {
  const mime = mimeType.split(';')[0].toLowerCase();
  return {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
  }[mime] || '.wav';
}

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      value += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else {
      value += ch;
    }
  }
  fields.push(value);
  return fields;
}

function runAnalyze(bin, inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      inputPath,
      '-o', outputDir,
      '--min_conf', process.env.BIRDNET_MIN_CONF || '0.03',
      '--top_n', process.env.BIRDNET_TOP_N || '8',
      '--rtype', 'csv',
      '--threads', process.env.BIRDNET_THREADS || '2',
      '--batch_size', '1',
    ];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `birdnet-analyze exited with ${code}`));
    });
  });
}

async function parseResults(outputDir) {
  const files = await fs.readdir(outputDir);
  const resultFile = files.find(file => file.endsWith('.BirdNET.results.csv'));
  if (!resultFile) return [];

  const text = await fs.readFile(path.join(outputDir, resultFile), 'utf8');
  const rows = text.trim().split(/\r?\n/).slice(1).map(parseCsvLine);
  const bySpecies = new Map();

  for (const row of rows) {
    const [start, end, scientificName, commonName, confidence] = row;
    const score = Math.round(Number(confidence) * 100);
    if (!commonName || !Number.isFinite(score)) continue;
    const key = `${scientificName}::${commonName}`.toLowerCase();
    const existing = bySpecies.get(key);
    if (!existing || score > existing.score) {
      bySpecies.set(key, {
        label: `${scientificName}_${commonName}`,
        commonName,
        scientificName,
        score,
        start: Number(start),
        end: Number(end),
        source: 'BirdNET',
      });
    }
  }

  return [...bySpecies.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  const base64Audio = req.body?.audio_base64;
  if (!base64Audio) return res.status(400).json({ error: { message: 'audio_base64 is required' } });

  const bin = process.env.BIRDNET_ANALYZE_BIN || DEFAULT_BIN;
  try {
    await fs.access(bin);
  } catch {
    return res.status(501).json({
      error: { message: 'BirdNET Python analyzer is not installed. Browser BirdNET fallback will be used.' }
    });
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wildlife-birdnet-'));
  const inputPath = path.join(tmpDir, `input${extForMime(req.body?.mime_type || 'audio/wav')}`);
  const outputDir = path.join(tmpDir, 'out');
  await fs.mkdir(outputDir);

  try {
    await fs.writeFile(inputPath, Buffer.from(base64Audio, 'base64'));
    await runAnalyze(bin, inputPath, outputDir);
    const detections = await parseResults(outputDir);
    return res.status(200).json({ results: [{ model: 'BirdNET', detections }] });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message || 'BirdNET analysis failed' } });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
