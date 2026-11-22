import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import { createService } from '../../functions/service.mjs';
import { application } from '../../functions/routes.mjs';
import { dayKey, hashIp } from '../../functions/client-ip.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeStorage {
  constructor() { this.files = new Map(); }
  async upload(path, bytes) { this.files.set(path, bytes); }
  async download(path) {
    if (!this.files.has(path)) throw new Error('not found');
    return new Response(this.files.get(path));
  }
  async remove(paths) { for (const path of paths) this.files.delete(path); }
}

class FakeEmbeddings {
  constructor() {
    this.configured = true;
    this.model = 'test-embedding';
    this.calls = [];
  }

  async embed(texts) {
    this.calls.push(texts);
    return texts.map((text) => (text.includes('无关') ? [0, 1] : [1, 0]));
  }
}

class FakeChat {
  constructor() {
    this.configured = true;
    this.model = 'test-chat';
    this.calls = [];
  }

  async complete(messages) { this.calls.push(messages); return '依据资料回答。[1]'; }
}

const NOW = new Date('2026-10-30T02:00:00Z');
const DAY = dayKey(NOW);
const TRUSTED_IP = '203.0.113.9';
const TRUSTED = { 'x-envoy-external-address': TRUSTED_IP };
const SESSION_HEADER = 'x-findanswer-session';

function setup() {
  const repository = new InMemoryRepository();
  const storage = new FakeStorage();
  const embeddings = new FakeEmbeddings();
  const chat = new FakeChat();
  const service = createService({
    repository, storage, embeddings, chat,
    clock: () => NOW, limits: LIMITS,
  });
  const app = application({ service, clock: () => NOW, limits: LIMITS });
  return { repository, storage, embeddings, chat, app };
}

function context(request) {
  return { request, requestId: 'request-test' };
}

function body(response) {
  return response.json();
}

function sessionHeaders(sessionId, extra = TRUSTED) {
  return { ...extra, [SESSION_HEADER]: sessionId };
}

async function newSession(app) {
  const response = await app(context(new Request(
    'https://site.test/functions/v1/app/api/sessions',
    { method: 'POST' },
  )));
  assert.equal(response.status, 201);
  return body(response);
}

function uploadRequest(name, text, headers) {
  const form = new FormData();
  form.append('file', new File([text], name, { type: 'text/plain' }));
  form.append('batch_id', 'batch-1');
  return new Request('https://site.test/functions/v1/app/api/documents', {
    method: 'POST', body: form, headers,
  });
}

function jsonRequest(path, payload, headers = {}) {
  return new Request(`https://site.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

test('a new visitor gets a fresh 32-hex session that is required by every data route', async () => {
  const { app, repository } = setup();
  const first = await newSession(app);
  const second = await newSession(app);

  assert.match(first.session_id, /^[0-9a-f]{32}$/);
  assert.notEqual(first.session_id, second.session_id);
  assert.equal(repository.sessions.size, 2);
  assert.ok(new Date(first.expires_at).getTime() > NOW.getTime());

  const missing = await app(context(new Request(
    'https://site.test/app/api/health', { headers: TRUSTED },
  )));
  assert.equal(missing.status, 401);
  assert.equal((await body(missing)).code, 'session_expired');

  const malformed = await app(context(new Request(
    'https://site.test/app/api/documents', {
      headers: sessionHeaders('not-a-session'),
    },
  )));
  assert.equal(malformed.status, 401);

  const unknown = await app(context(new Request(
    'https://site.test/app/api/documents', {
      headers: sessionHeaders('0'.repeat(32)),
    },
  )));
  assert.equal(unknown.status, 401);
  assert.equal((await body(unknown)).code, 'session_expired');
});

test('an expired session is reported and cleared on access', async () => {
  const { app, repository } = setup();
  const session = await newSession(app);
  repository.sessions.get(session.session_id).expires_at = '2026-10-30T01:00:00Z';

  const response = await app(context(new Request(
    'https://site.test/app/api/health',
    { headers: sessionHeaders(session.session_id) },
  )));
  assert.equal(response.status, 401);
  assert.equal((await body(response)).detail, '体验会话已过期，请刷新页面重新开始。');
  assert.equal(repository.sessions.has(session.session_id), false);
});

test('health reports session quota and public capabilities without secrets or IP values', async () => {
  const { app } = setup();
  const { session_id: sessionId } = await newSession(app);
  const response = await app(context(new Request(
    'https://site.test/functions/v1/app/api/health',
    { headers: sessionHeaders(sessionId) },
  )));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.mode, 'public');
  assert.deepEqual(payload.capabilities, {
    upload: true, delete: false, manage_connections: false,
  });
  assert.equal(payload.trusted_ip, true);
  assert.equal(payload.quota.scope, 'session');
  assert.equal(payload.quota.documents_limit, 20);
  assert.equal(payload.quota.chunks_limit, 200);
  assert.equal(payload.quota.batch_limit, 50);
  assert.equal(payload.quota.daily_uploads_remaining, 30);
  assert.equal(payload.document_count, 0);
  assert.equal(JSON.stringify(payload).includes(TRUSTED_IP), false);
  assert.equal(JSON.stringify(payload).toLowerCase().includes('key"'), false);
});

test('health blocks uploads but keeps Q&A when no trusted IP is present', async () => {
  const { app } = setup();
  const { session_id: sessionId } = await newSession(app);
  const response = await app(context(new Request(
    'https://site.test/functions/v1/app/api/health',
    { headers: sessionHeaders(sessionId, {}) },
  )));
  const payload = await body(response);
  assert.equal(payload.capabilities.upload, false);
  assert.equal(payload.trusted_ip, false);
  assert.equal(payload.upload_blocked_reason, '无法确认客户端 IP，暂时不能上传。');
});

test('accepts logical, provider-stripped and physical Function paths', async () => {
  const { app } = setup();
  const { session_id: sessionId } = await newSession(app);
  for (const path of [
    '/functions/v1/app/api/health',
    '/app/api/health',
    '/functions/v1/app-d0123456789abcdef0123456789abcdef/api/health',
  ]) {
    const response = await app(context(new Request(`https://site.test${path}`, {
      headers: sessionHeaders(sessionId),
    })));
    assert.equal(response.status, 200);
  }
});

test('upload stores the document under the visitor path and repeats return 409', async () => {
  const { app, repository, storage } = setup();
  const { session_id: sessionId } = await newSession(app);
  const first = await app(context(uploadRequest(
    'notes.txt', '第一段\n\n第二段', sessionHeaders(sessionId),
  )));
  assert.equal(first.status, 201);
  const document = await body(first);
  assert.equal(document.name, 'notes.txt');
  assert.equal(document.session_id, sessionId);
  assert.equal(repository.documents.size, 1);
  assert.equal(storage.files.size, 1);
  const [path] = storage.files.keys();
  assert.ok(path.startsWith(`visitors/${sessionId}/documents/`), path);

  const second = await app(context(uploadRequest(
    'notes.txt', '第一段\n\n第二段', sessionHeaders(sessionId),
  )));
  assert.equal(second.status, 409);
  assert.equal((await body(second)).detail, '该文件已上传，请勿重复上传。');
  assert.equal(repository.documents.size, 1);
});

test('upload without a trusted IP fails closed before reading the body', async () => {
  const { app } = setup();
  const { session_id: sessionId } = await newSession(app);
  const response = await app(context(uploadRequest(
    'notes.txt', 'text', sessionHeaders(sessionId, {}),
  )));
  assert.equal(response.status, 403);
  assert.equal((await body(response)).code, 'upload_unavailable');
});

test('one visitor session never lists, opens or answers from another visitor data', async () => {
  const { app, repository, storage, embeddings, chat } = setup();
  const mine = await newSession(app);
  const other = await newSession(app);
  const upload = await app(context(uploadRequest(
    'notes.txt', 'FindAnswer 使用真实资料。', sessionHeaders(mine.session_id),
  )));
  assert.equal(upload.status, 201);
  const document = await body(upload);

  const list = await app(context(new Request('https://site.test/app/api/documents', {
    headers: sessionHeaders(other.session_id),
  })));
  assert.deepEqual(await body(list), { documents: [] });

  const chunks = await app(context(new Request(
    `https://site.test/app/api/documents/${document.id}/chunks`,
    { headers: sessionHeaders(other.session_id) },
  )));
  assert.equal(chunks.status, 404);

  const ownChunks = await app(context(new Request(
    `https://site.test/app/api/documents/${document.id}/chunks`,
    { headers: sessionHeaders(mine.session_id) },
  )));
  assert.equal(ownChunks.status, 200);
  assert.equal((await body(ownChunks)).chunks[0].file_name, 'notes.txt');

  const forbiddenDelete = await app(context(new Request(
    `https://site.test/app/api/documents/${document.id}`,
    { method: 'DELETE', headers: sessionHeaders(other.session_id) },
  )));
  assert.equal(forbiddenDelete.status, 403);

  const embeddingCalls = embeddings.calls.length;
  const strangerAsk = await app(context(jsonRequest(
    '/app/api/ask', { question: '资料里说了什么？' }, sessionHeaders(other.session_id),
  )));
  assert.equal((await body(strangerAsk)).status, 'no_answer');
  assert.equal(embeddings.calls.length, embeddingCalls);
  assert.equal(chat.calls.length, 0);
  assert.equal(repository.documents.size, 1);
  assert.equal(storage.files.size, 1);
});

test('the session document cap blocks further uploads and health explains why', async () => {
  const { app, repository } = setup();
  const { session_id: sessionId } = await newSession(app);
  for (let index = 1; index <= 20; index += 1) {
    repository.documents.set(`seed-${index}`, {
      id: `seed-${index}`,
      session_id: sessionId,
      name: `${index}.txt`,
      sha256: `sha-${index}`,
      size: 1,
      chunk_count: 0,
      object_path: `visitors/${sessionId}/documents/seed-${index}.txt`,
      created_at: NOW.toISOString(),
    });
  }

  const health = await app(context(new Request('https://site.test/app/api/health', {
    headers: sessionHeaders(sessionId),
  })));
  const healthPayload = await body(health);
  assert.equal(healthPayload.capabilities.upload, false);
  assert.match(healthPayload.upload_blocked_reason, /20 份资料上限/);

  const response = await app(context(uploadRequest(
    'new.txt', 'new content', sessionHeaders(sessionId),
  )));
  assert.equal(response.status, 429);
  assert.equal((await body(response)).code, 'session_limit');
  assert.equal(repository.documents.size, 20);
});

test('the session chunk cap blocks an upload that would exceed 200 chunks', async () => {
  const { app, repository, storage } = setup();
  const { session_id: sessionId } = await newSession(app);
  repository.documents.set('seed', {
    id: 'seed',
    session_id: sessionId,
    name: 'filled.txt',
    sha256: 'filled',
    size: 1,
    chunk_count: LIMITS.sessionMaxChunks,
    object_path: `visitors/${sessionId}/documents/filled.txt`,
    created_at: NOW.toISOString(),
  });

  const response = await app(context(uploadRequest(
    'new.txt', 'new content', sessionHeaders(sessionId),
  )));
  assert.equal(response.status, 429);
  assert.equal((await body(response)).code, 'session_chunk_limit');
  assert.equal(repository.documents.size, 1);
  assert.equal(storage.files.size, 0);
  assert.equal(repository.daily.size, 0);
});

test('daily quota returns a terminal 429 code and leaves the session empty', async () => {
  const { app, repository } = setup();
  const { session_id: sessionId } = await newSession(app);
  const ipHash = await hashIp(TRUSTED_IP);
  for (let index = 1; index <= 30; index += 1) {
    repository.daily.set(`r-${index}`, {
      id: `r-${index}`,
      ip_day: DAY,
      ip_hash: ipHash,
      created_at: NOW.toISOString(),
    });
  }

  const health = await app(context(new Request('https://site.test/app/api/health', {
    headers: sessionHeaders(sessionId),
  })));
  const healthPayload = await body(health);
  assert.equal(healthPayload.capabilities.upload, false);
  assert.equal(healthPayload.upload_blocked_reason, '今日体验上传额度已用完，请明天再试。');

  const response = await app(context(uploadRequest(
    'new.txt', 'new content', sessionHeaders(sessionId),
  )));
  assert.equal(response.status, 429);
  const payload = await body(response);
  assert.equal(payload.code, 'daily_limit');
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.daily.size, 30);
});

test('ending an experience purges the session data but keeps the daily ledger', async () => {
  const { app, repository, storage } = setup();
  const { session_id: sessionId } = await newSession(app);
  const upload = await app(context(uploadRequest(
    'notes.txt', '第一段\n\n第二段', sessionHeaders(sessionId),
  )));
  assert.equal(upload.status, 201);
  assert.equal(repository.documents.size, 1);
  assert.equal(repository.chunks.size, 1);
  assert.equal(repository.daily.size, 1);
  repository.attempts.set(`${sessionId}:b:1`, {
    attempt_key: `${sessionId}:b:1`,
    session_id: sessionId,
    batch_id: 'b',
    created_at: NOW.toISOString(),
  });

  const response = await app(context(new Request('https://site.test/app/api/session', {
    method: 'DELETE',
    headers: sessionHeaders(sessionId),
  })));
  assert.equal(response.status, 200);
  const fresh = await body(response);
  assert.match(fresh.session_id, /^[0-9a-f]{32}$/);
  assert.notEqual(fresh.session_id, sessionId);

  assert.equal(repository.documents.size, 0);
  assert.equal(repository.chunks.size, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.attempts.size, 0);
  assert.equal(storage.files.size, 0);
  assert.equal(repository.daily.size, 1);
  assert.equal(repository.sessions.has(sessionId), false);

  const stale = await app(context(new Request('https://site.test/app/api/health', {
    headers: sessionHeaders(sessionId),
  })));
  assert.equal(stale.status, 401);

  const empty = await app(context(new Request('https://site.test/app/api/documents', {
    headers: sessionHeaders(fresh.session_id),
  })));
  assert.deepEqual(await body(empty), { documents: [] });
});

test('ending an experience requires a live session', async () => {
  const { app } = setup();
  const response = await app(context(new Request('https://site.test/app/api/session', {
    method: 'DELETE',
  })));
  assert.equal(response.status, 401);
});

test('visitors cannot delete documents or change connections even with a valid body', async () => {
  const { app, repository } = setup();
  const { session_id: sessionId } = await newSession(app);
  repository.documents.set('doc-1', {
    id: 'doc-1', session_id: sessionId, name: 'a.txt', sha256: 'a', size: 1,
    chunk_count: 1, object_path: null, created_at: NOW.toISOString(),
  });

  const deletion = await app(context(new Request(
    'https://site.test/app/api/documents/doc-1',
    { method: 'DELETE', headers: sessionHeaders(sessionId) },
  )));
  assert.equal(deletion.status, 403);
  assert.equal((await body(deletion)).code, 'forbidden');

  const connection = await app(context(new Request(
    'https://site.test/app/api/connections/siliconflow',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: 'should-never-be-used' }),
    },
  )));
  assert.equal(connection.status, 403);
  assert.equal(JSON.stringify(await body(connection)).includes('should-never-be-used'), false);
  assert.equal(repository.documents.size, 1);
});

test('connections status is read-only metadata about the publisher API', async () => {
  const { app } = setup();
  const response = await app(context(new Request(
    'https://site.test/app/api/connections/status',
  )));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.mode, 'public');
  assert.equal(payload.manage_connections, false);
  assert.equal(payload.note, 'API 为发布者个人 API，密钥保存在服务端，访客无法查看或修改。');
  assert.deepEqual(payload.providers, [
    {
      provider: 'siliconflow',
      role: 'embedding',
      label: '硅基流动',
      model: 'test-embedding',
      configured: true,
    },
    {
      provider: 'deepseek',
      role: 'chat',
      label: 'DeepSeek',
      model: 'test-chat',
      configured: true,
    },
  ]);
  assert.equal(JSON.stringify(payload).toLowerCase().includes('key'), false);
});

test('ask refuses without evidence in this session and does not call chat', async () => {
  const { app, chat } = setup();
  const { session_id: sessionId } = await newSession(app);
  const response = await app(context(jsonRequest(
    '/app/api/ask', { question: '没有资料的答案', top_k: 5 }, sessionHeaders(sessionId),
  )));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.status, 'no_answer');
  assert.equal(payload.answer, '你提供的资料中没有这个问题的答案。');
  assert.equal(chat.calls.length, 0);
});

test('ask returns a mapped citation when evidence exists', async () => {
  const { app } = setup();
  const { session_id: sessionId } = await newSession(app);
  await app(context(uploadRequest(
    'notes.txt', 'FindAnswer 使用真实资料。', sessionHeaders(sessionId),
  )));
  const response = await app(context(jsonRequest(
    '/app/api/ask', { question: 'FindAnswer 如何回答？' }, sessionHeaders(sessionId),
  )));
  const payload = await body(response);
  assert.equal(payload.status, 'answered');
  assert.equal(payload.citations[0].file_name, 'notes.txt');
  assert.equal(payload.citations[0].document_id, payload.retrieval.hits[0].document_id);
});

test('rejects malformed JSON, oversized JSON, unknown paths and wrong methods', async () => {
  const { app } = setup();
  const { session_id: sessionId } = await newSession(app);
  const headers = sessionHeaders(sessionId);
  const malformed = await app(context(new Request('https://site.test/app/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{',
  })));
  assert.equal(malformed.status, 400);

  const oversized = await app(context(new Request('https://site.test/app/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ question: 'x'.repeat(9000) }),
  })));
  assert.equal(oversized.status, 413);

  const unknown = await app(context(new Request('https://site.test/app/api/nope')));
  assert.equal(unknown.status, 404);

  const wrongMethod = await app(context(new Request('https://site.test/app/api/health', {
    method: 'POST',
  })));
  assert.equal(wrongMethod.status, 405);
});

test('unexpected repository failures return a sanitized 500', async () => {
  const service = {
    resolveSession: async () => {},
    health: async () => { throw new Error('postgres password leaked'); },
  };
  const isolated = application({ service, clock: () => NOW, limits: LIMITS });
  const response = await isolated(context(new Request('https://site.test/app/api/health')));
  assert.equal(response.status, 500);
  const text = JSON.stringify(await body(response));
  assert.equal(text.includes('postgres'), false);
  assert.equal(text.includes('password'), false);
});

// Probe: the multipart body ceiling is enforced before any parsing or storage.
test('rejects a multipart upload above the 21 MiB body limit', async () => {
  const { app, repository } = setup();
  const { session_id: sessionId } = await newSession(app);
  const form = new FormData();
  form.append('file', new File(['a'.repeat(21 * 1024 * 1024)], 'big.txt', {
    type: 'text/plain',
  }));
  form.append('batch_id', 'batch-big');
  const response = await app(context(new Request(
    'https://site.test/app/api/documents',
    { method: 'POST', body: form, headers: sessionHeaders(sessionId) },
  )));
  assert.equal(response.status, 413);
  assert.equal((await body(response)).code, 'payload_too_large');
  assert.equal(repository.documents.size, 0);
});

// Probe: the DELETE guard fires even when the caller sends a valid JSON body.
test('DELETE is forbidden with a valid body and mutates nothing', async () => {
  const { app, repository } = setup();
  const { session_id: sessionId } = await newSession(app);
  repository.documents.set('doc-1', {
    id: 'doc-1', session_id: sessionId, name: 'a.txt', sha256: 'a', size: 1,
    chunk_count: 1, object_path: null, created_at: NOW.toISOString(),
  });
  const response = await app(context(new Request(
    'https://site.test/app/api/documents/doc-1',
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...sessionHeaders(sessionId) },
      body: JSON.stringify({ reason: 'visitor request' }),
    },
  )));
  assert.equal(response.status, 403);
  const payload = await body(response);
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'detail']);
  assert.equal(payload.code, 'forbidden');
  assert.equal(repository.documents.size, 1);
});

// Probe: the unexpected-error log keeps the request id and error name only.
test('unexpected failures log only a request id and an error name', async () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  try {
    const service = {
      resolveSession: async () => {},
      health: async () => { throw new Error('postgres password leaked'); },
    };
    const isolated = application({ service, clock: () => NOW, limits: LIMITS });
    const response = await isolated(context(new Request(
      'https://site.test/app/api/health',
    )));
    assert.equal(response.status, 500);
  } finally {
    console.error = original;
  }
  const text = JSON.stringify(logged);
  assert.equal(text.includes('postgres'), false);
  assert.equal(text.includes('password'), false);
  assert.equal(text.includes('request-test'), true);
  assert.equal(text.includes('Error'), true);
});
