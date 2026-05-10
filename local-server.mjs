import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const port = Number(process.env.PORT || 3000);

loadEnvFile(path.join(root, '.env.local'));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}

function sendFile(res, filePath) {
  res.writeHead(200, { 'Content-Type': contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function makeHandlerResponse(res) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      res.writeHead(this.statusCode, {
        ...this.headers,
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(JSON.stringify(body));
    },
    end(body = '') {
      res.writeHead(this.statusCode, this.headers);
      res.end(body);
    }
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function handleApi(req, res, url) {
  const route = path.basename(url.pathname);
  const filePath = path.join(root, 'api', `${route}.js`);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'API route not found.' }));
    return;
  }

  const mod = await import(`${pathToFileURL(filePath).href}?cacheBust=${Date.now()}`);
  const query = Object.fromEntries(url.searchParams.entries());
  const body = await readBody(req);
  await mod.default({ method: req.method, query, body }, makeHandlerResponse(res));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const filePath = path.join(root, path.normalize(requestedPath).replace(/^\/+/, ''));

    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    sendFile(res, filePath);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(port, () => {
  console.log(`WildlifeSound local server running at http://localhost:${port}/`);
});
