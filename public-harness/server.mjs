import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../functions/config.mjs';
import { application } from '../functions/routes.mjs';
import { createService } from '../functions/service.mjs';
import { InMemoryRepository } from './in-memory-repository.mjs';
import { FakeChat, FakeEmbeddings, FakeStorage } from './fakes.mjs';

const port = Number(process.argv[2] ?? 4174);
const root = resolve(fileURLToPath(new URL('../frontend/dist-public/', import.meta.url)));
const API_PATH = /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})\/api(?:\/|$)/;

const repository = new InMemoryRepository();
const service = createService({
  repository,
  storage: new FakeStorage(),
  embeddings: new FakeEmbeddings(),
  chat: new FakeChat(),
  limits: LIMITS,
});
const handle = application({ service, limits: LIMITS });

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function insideRoot(path) {
  return path === root || path.startsWith(root + sep);
}

async function staticFile(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const relative = normalize(requested).replace(/^[/\\]+/, '');
  let path = resolve(root, relative);
  if (!insideRoot(path)) return new Response('Not found.', { status: 404 });
  try {
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
  } catch {
    path = join(root, 'index.html');
  }
  if (!insideRoot(path)) return new Response('Not found.', { status: 404 });
  try {
    return new Response(await readFile(path), {
      headers: {
        'content-type': types[extname(path).toLowerCase()] ?? 'application/octet-stream',
      },
    });
  } catch {
    return new Response('Build the public frontend first.', { status: 404 });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let result;
    if (API_PATH.test(url.pathname)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      // The real gateway supplies this header; the harness impersonates that
      // trusted hop and never trusts a browser-supplied value.
      const headers = new Headers(request.headers);
      headers.delete('x-forwarded-for');
      headers.delete('x-real-ip');
      headers.delete('x-real-client-ip');
      headers.delete('x-envoy-external-address');
      headers.set('x-envoy-external-address', '203.0.113.9');
      const webRequest = new Request(url, {
        method: request.method,
        headers,
        body: body.length ? body : undefined,
      });
      result = await handle({ request: webRequest, requestId: 'local-harness' });
    } else {
      result = await staticFile(url.pathname);
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: '本地测试服务出错。', code: 'harness_error' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`FindAnswer public harness: http://127.0.0.1:${port}`);
});
