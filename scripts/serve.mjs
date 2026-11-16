#!/usr/bin/env node
/**
 * Zero-dependency static server for the playable demo.
 *
 *   npm run demo        → http://<host>:8080/  (serves the single-file demo)
 *
 * Binds 0.0.0.0 and accepts any Host header so it works behind a proxy/preview.
 * There is no build step: IRON-VERGE-playable-demo.html is fully self-contained.
 */
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 8080);
const demo = resolve(root, 'IRON-VERGE-playable-demo.html');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file;

  if (url === '/' || url === '/index.html' || url === '/demo.html' || url === '/IRON-VERGE-playable-demo.html') {
    file = demo;
  } else {
    // serve docs/ and build/ artefacts for convenience, never anything outside root
    const rel = normalize(url).replace(/^(\.\.[/\\])+/, '');
    file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
  }

  if (!existsSync(file) || !statSync(file).isFile()) {
    if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`not found: ${url}\n\nthe game lives at / (IRON-VERGE-playable-demo.html)`);
    return;
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
    // the demo needs no special headers; allow embedding so previews work
    'access-control-allow-origin': '*',
  }).end(body);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`IRON VERGE demo → http://0.0.0.0:${port}/`);
  console.log(`serving ${(statSync(demo).size / 1024).toFixed(1)} KB self-contained bundle`);
});
