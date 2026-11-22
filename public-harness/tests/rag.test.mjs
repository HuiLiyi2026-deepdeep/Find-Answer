import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import {
  createDeepSeekChat, createSiliconFlowEmbeddings,
} from '../../functions/providers.mjs';
import {
  INSUFFICIENT_EVIDENCE_ANSWER, NO_RETRIEVAL_ANSWER, createRag,
} from '../../functions/rag.mjs';
import { encodeVector } from '../../functions/text.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeEmbeddings {
  constructor(vector = [1, 0]) { this.vector = vector; this.calls = []; }
  async embed(texts) { this.calls.push(texts); return texts.map(() => this.vector); }
}

class FakeChat {
  constructor(answer) { this.answer = answer; this.calls = []; }
  async complete(messages) { this.calls.push(messages); return this.answer; }
}

async function seeded() {
  const repository = new InMemoryRepository();
  await repository.insertDocument({
    id: 'doc-1', session_id: SESSION, name: '资料.txt', sha256: 'sha-1', size: 10,
    chunk_count: 1, object_path: null, created_at: '2026-10-30T00:00:00Z',
  });
  await repository.insertChunks([{
    chunk_key: 'doc-1:0',
    session_id: SESSION,
    document_id: 'doc-1',
    file_name: '资料.txt',
    page: null,
    chunk_index: 0,
    text: 'FindAnswer 使用真实资料回答。',
    embedding: encodeVector([1, 0]),
    norm: '1',
  }]);
  return repository;
}

test('no chunks returns a refusal without embedding or chat calls', async () => {
  const repository = new InMemoryRepository();
  const embeddings = new FakeEmbeddings();
  const chat = new FakeChat('should not run');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  const result = await rag.ask(SESSION, '有人吗？', 5);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, NO_RETRIEVAL_ANSWER);
  assert.equal(embeddings.calls.length, 0);
  assert.equal(chat.calls.length, 0);
});

test('retrieval only sees the current visitor session', async () => {
  const repository = await seeded();
  await repository.insertDocument({
    id: 'doc-2', session_id: OTHER_SESSION, name: '别人的.txt', sha256: 'sha-2', size: 10,
    chunk_count: 1, object_path: null, created_at: '2026-10-30T00:00:00Z',
  });
  await repository.insertChunks([{
    chunk_key: 'doc-2:0',
    session_id: OTHER_SESSION,
    document_id: 'doc-2',
    file_name: '别人的.txt',
    page: null,
    chunk_index: 0,
    text: '另一个访客的资料。',
    embedding: encodeVector([1, 0]),
    norm: '1',
  }]);
  const embeddings = new FakeEmbeddings([1, 0]);

  const empty = createRag({
    repository,
    embeddings,
    chat: new FakeChat('should not run'),
    ...LIMITS,
  });
  const stranger = '3'.repeat(32);
  const strangerResult = await empty.ask(stranger, '资料里说了什么？', 5);
  assert.equal(strangerResult.status, 'no_answer');
  assert.equal(strangerResult.answer, NO_RETRIEVAL_ANSWER);
  assert.equal(embeddings.calls.length, 0);

  const mine = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('回答 [1]'),
    ...LIMITS,
  });
  const own = await mine.ask(SESSION, '资料里说了什么？', 5);
  assert.equal(own.status, 'answered');
  assert.deepEqual(own.citations.map((citation) => citation.document_id), ['doc-1']);

  const other = await mine.ask(OTHER_SESSION, '资料里说了什么？', 5);
  assert.equal(other.status, 'answered');
  assert.deepEqual(other.citations.map((citation) => citation.document_id), ['doc-2']);
});

test('unrelated vectors fall below the threshold and never call chat', async () => {
  const repository = await seeded();
  const embeddings = new FakeEmbeddings([0, 1]);
  const chat = new FakeChat('[1] 不应调用');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  const result = await rag.ask(SESSION, '无关问题', 5);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, NO_RETRIEVAL_ANSWER);
  assert.equal(chat.calls.length, 0);
});

test('valid citations map to the stored chunk', async () => {
  const repository = await seeded();
  const embeddings = new FakeEmbeddings([1, 0]);
  const chat = new FakeChat('回答依据资料。[1]');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  const result = await rag.ask(SESSION, 'FindAnswer 如何回答？', 5);
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.citations, [{
    number: 1,
    chunk_id: 'doc-1:0',
    document_id: 'doc-1',
    file_name: '资料.txt',
    page: null,
    chunk_index: 0,
    text: 'FindAnswer 使用真实资料回答。',
  }]);
});

for (const answer of ['没有引用', '[2] 越界', '[1] 和 [9] 混合', 'NO_ANSWER', '[0] 非法']) {
  test(`refuses the whole answer for ${JSON.stringify(answer)}`, async () => {
    const repository = await seeded();
    const rag = createRag({
      repository,
      embeddings: new FakeEmbeddings([1, 0]),
      chat: new FakeChat(answer),
      ...LIMITS,
    });
    const result = await rag.ask(SESSION, 'FindAnswer 如何回答？', 5);
    assert.equal(result.status, 'no_answer');
    assert.equal(result.answer, INSUFFICIENT_EVIDENCE_ANSWER);
    assert.deepEqual(result.citations, []);
  });
}

test('embedding provider validates response order and shape', async () => {
  const provider = createSiliconFlowEmbeddings({
    apiKey: 'test-siliconflow-key',
    model: 'test-model',
    fetchImpl: async () => Response.json({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }),
  });
  const vectors = await provider.embed(['a', 'b']);
  assert.deepEqual(vectors, [[1, 0], [0, 1]]);

  const invalid = createSiliconFlowEmbeddings({
    apiKey: 'test-siliconflow-key',
    model: 'test-model',
    fetchImpl: async () => Response.json({
      data: [{ index: 0, embedding: [] }],
    }),
  });
  await assert.rejects(
    () => invalid.embed(['a']),
    (error) => error.code === 'embedding_failed' && error.status === 502,
  );
});

test('chat provider sends temperature zero and refuses an empty body', async () => {
  let body;
  const provider = createDeepSeekChat({
    apiKey: 'test-deepseek-key',
    model: 'test-chat',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    },
  });
  assert.equal(await provider.complete([{ role: 'user', content: 'hi' }]), 'OK');
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);

  const empty = createDeepSeekChat({
    apiKey: 'test-deepseek-key',
    model: 'test-chat',
    fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }),
  });
  await assert.rejects(() => empty.complete([{ role: 'user', content: 'hi' }]));
});

async function seededLibrary(rows) {
  const repository = new InMemoryRepository();
  await repository.insertDocument({
    id: 'doc-1', session_id: SESSION, name: '资料.txt', sha256: 'sha-1', size: 10,
    chunk_count: rows.length, object_path: null, created_at: '2026-10-30T00:00:00Z',
  });
  await repository.insertChunks(rows.map((row, index) => ({
    chunk_key: `doc-1:${index}`,
    session_id: row.session_id ?? SESSION,
    document_id: 'doc-1',
    file_name: row.file_name ?? '资料.txt',
    page: row.page ?? null,
    chunk_index: index,
    text: row.text,
    embedding: encodeVector(row.vector),
    norm: row.norm ?? '1',
  })));
  return repository;
}

test('threshold filters after scoring: only the perfect hit is cited', async () => {
  const repository = await seededLibrary([
    { text: '完美匹配。', vector: [1, 0] },
    { text: '弱相关。', vector: [0.1, Math.sqrt(1 - 0.01)] },
    { text: '无关。', vector: [0, 1] },
  ]);
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('只有 [1] 有效。'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'answered');
  assert.equal(result.retrieval.count, 1);
  assert.equal(result.retrieval.hits[0].id, 'doc-1:0');
  assert.deepEqual(result.citations.map((citation) => citation.chunk_id), ['doc-1:0']);
});

test('the score threshold is inclusive at the achieved score', async () => {
  // Vectors are stored as float16, so a decoded vector's recomputed norm is not
  // exactly 1 and its cosine cannot land on exactly 0.25. Assert the cosine is
  // ~0.25 and then probe the inclusive (`>=`) comparison at the score itself.
  const repository = await seededLibrary([
    { text: '恰好达标。', vector: [0.25, 0.968] },
  ]);
  const build = (scoreThreshold) => createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('[1]'),
    ...LIMITS,
    scoreThreshold,
  });

  const reference = await build(LIMITS.scoreThreshold).retrieve(SESSION, '问题', 5);
  assert.equal(reference.count, 1);
  const { score } = reference.hits[0];
  assert.ok(Math.abs(score - 0.25) < 1e-3, `expected ~0.25, got ${score}`);

  const inclusive = await build(score).retrieve(SESSION, '问题', 5);
  assert.equal(inclusive.count, 1);
  assert.equal(inclusive.hits[0].score, score);

  const exclusive = await build(score + 1e-9).retrieve(SESSION, '问题', 5);
  assert.equal(exclusive.count, 0);
});

test('top-k is applied before citation numbering', async () => {
  const repository = await seededLibrary([
    { text: '最高分。', vector: [1, 0] },
    { text: '第二分。', vector: [0.9, Math.sqrt(1 - 0.81)] },
    { text: '第三分。', vector: [0.8, 0.6] },
  ]);
  const chat = new FakeChat('[3] 越界');
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat,
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 2);
  assert.equal(result.retrieval.count, 2);
  assert.equal(result.retrieval.hits.length, 2);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, INSUFFICIENT_EVIDENCE_ANSWER);
  assert.deepEqual(result.citations, []);
});

test('[1][2] with a single hit refuses the whole answer', async () => {
  const repository = await seeded();
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('[1][2] 混合引用'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, INSUFFICIENT_EVIDENCE_ANSWER);
  assert.deepEqual(result.citations, []);
});

test('[abc] alone refuses because no valid citation exists', async () => {
  const repository = await seeded();
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('资料 [abc] 没有编号'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, INSUFFICIENT_EVIDENCE_ANSWER);
  assert.deepEqual(result.citations, []);
});

for (const answer of ['[1] 和 [abc] 混合', '[1] 参考 [资料](https://example.com)']) {
  test(`a valid [1] cannot rescue a malformed marker in ${JSON.stringify(answer)}`, async () => {
    const repository = await seeded();
    const rag = createRag({
      repository,
      embeddings: new FakeEmbeddings([1, 0]),
      chat: new FakeChat(answer),
      ...LIMITS,
    });
    const result = await rag.ask(SESSION, '问题', 5);
    assert.equal(result.status, 'no_answer');
    assert.equal(result.answer, INSUFFICIENT_EVIDENCE_ANSWER);
    assert.deepEqual(result.citations, []);
  });
}

test('full-width 【1】 is accepted as a citation', async () => {
  const repository = await seeded();
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('回答【1】'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.citations.map((citation) => citation.chunk_id), ['doc-1:0']);
});

test('duplicate [1][1] collapses to one citation', async () => {
  const repository = await seeded();
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('回答 [1] 再次 [1]'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'answered');
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].number, 1);
  assert.equal(result.citations[0].chunk_id, 'doc-1:0');
});

test('a wrong-dimension query vector is a sanitized 502 and never calls chat', async () => {
  const repository = await seeded();
  const embeddings = new FakeEmbeddings([1, 0, 0]);
  const chat = new FakeChat('should not run');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  await assert.rejects(() => rag.ask(SESSION, '问题', 5), (error) => {
    assert.equal(error.code, 'embedding_failed');
    assert.equal(error.status, 502);
    assert.equal(error.message, '嵌入服务暂时不可用，请稍后重试。');
    return true;
  });
  assert.equal(embeddings.calls.length, 1);
  assert.equal(chat.calls.length, 0);
});

test('the question is trimmed before embedding and prompting', async () => {
  const repository = await seeded();
  const embeddings = new FakeEmbeddings([1, 0]);
  const chat = new FakeChat('[1]');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  await rag.ask(SESSION, '  FindAnswer 如何回答？  ', 5);
  assert.deepEqual(embeddings.calls, [['FindAnswer 如何回答？']]);
  assert.equal(chat.calls.length, 1);
  assert.ok(chat.calls[0][1].content.startsWith('问题：FindAnswer 如何回答？'));
});

test('citations always come from stored rows, not model prose', async () => {
  const repository = await seeded();
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('据 evil.txt 第 99 页记载 [1]'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.citations, [{
    number: 1,
    chunk_id: 'doc-1:0',
    document_id: 'doc-1',
    file_name: '资料.txt',
    page: null,
    chunk_index: 0,
    text: 'FindAnswer 使用真实资料回答。',
  }]);
});

test('no Q&A history is persisted through the repository', async () => {
  const backing = await seeded();
  const repository = {
    async listAllChunks(sessionId) { return backing.listAllChunks(sessionId); },
  };
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('[1]'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'answered');
  assert.deepEqual(
    Object.keys(backing).sort(),
    ['attempts', 'chunks', 'daily', 'documents', 'reservations', 'sessions'],
  );
  assert.equal(backing.documents.size, 1);
  assert.equal(backing.chunks.size, 1);
  assert.equal(backing.reservations.size, 0);
  assert.equal(backing.attempts.size, 0);
  assert.equal(backing.daily.size, 0);
  assert.equal(backing.sessions.size, 0);
});

test('a corrupt stored norm cannot inflate the cosine score', async () => {
  // True norm of the decoded [0.6, 0.8] is 1, so the real cosine with [1, 0]
  // is 0.6. Dividing by the stored norm would yield 0.6 / 0.0001 = 6000.
  const repository = await seededLibrary([
    { text: '真实分数是 0.6。', vector: [0.6, 0.8], norm: '0.0001' },
  ]);
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat: new FakeChat('回答 [1]'),
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.status, 'answered');
  assert.equal(result.retrieval.count, 1);
  const { score } = result.retrieval.hits[0];
  assert.ok(Math.abs(score - 0.6) < 1e-3, `expected ~0.6, got ${score}`);
  assert.ok(score < 1, `stored norm inflated the score to ${score}`);
});

test('a corrupt stored norm cannot lift a weak chunk past the threshold', async () => {
  const repository = await seededLibrary([
    { text: '弱相关但 norm 巨大。', vector: [0.1, Math.sqrt(1 - 0.01)], norm: '1e9' },
    { text: '弱相关但 norm 极小。', vector: [0.2, Math.sqrt(1 - 0.04)], norm: '0.0001' },
  ]);
  const chat = new FakeChat('[1]');
  const rag = createRag({
    repository,
    embeddings: new FakeEmbeddings([1, 0]),
    chat,
    ...LIMITS,
  });
  const result = await rag.ask(SESSION, '问题', 5);
  assert.equal(result.retrieval.count, 0);
  assert.deepEqual(result.retrieval.hits, []);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, NO_RETRIEVAL_ANSWER);
  assert.deepEqual(result.citations, []);
  assert.equal(chat.calls.length, 0);
});

test('providers use fixed URLs and ignore per-call overrides', async () => {
  let embeddingCall;
  const embeddings = createSiliconFlowEmbeddings({
    apiKey: 'test-siliconflow-key',
    model: 'test-model',
    baseUrl: 'https://evil.example/v1',
    url: 'https://evil.example/v1',
    headers: { 'x-evil': '1' },
    fetchImpl: async (url, init) => {
      embeddingCall = { url, init };
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    },
  });
  await embeddings.embed(['q'], {
    apiKey: 'evil-key', model: 'evil-model', baseUrl: 'https://evil.example',
  });
  assert.equal(embeddingCall.url, 'https://api.siliconflow.cn/v1/embeddings');
  assert.deepEqual(Object.keys(embeddingCall.init.headers).sort(), ['authorization', 'content-type']);
  assert.equal(embeddingCall.init.headers.authorization, 'Bearer test-siliconflow-key');
  const embeddingBody = JSON.parse(embeddingCall.init.body);
  assert.equal(embeddingBody.model, 'test-model');
  assert.deepEqual(embeddingBody.input, ['q']);

  let chatCall;
  const chat = createDeepSeekChat({
    apiKey: 'test-deepseek-key',
    model: 'test-chat',
    baseUrl: 'https://evil.example/v1',
    headers: { 'x-evil': '1' },
    fetchImpl: async (url, init) => {
      chatCall = { url, init };
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    },
  });
  const messages = [{ role: 'user', content: 'hi' }];
  await chat.complete(messages, { apiKey: 'evil-key', model: 'evil-model', temperature: 1 });
  assert.equal(chatCall.url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(Object.keys(chatCall.init.headers).sort(), ['authorization', 'content-type']);
  assert.equal(chatCall.init.headers.authorization, 'Bearer test-deepseek-key');
  const chatBody = JSON.parse(chatCall.init.body);
  assert.equal(chatBody.model, 'test-chat');
  assert.equal(chatBody.temperature, 0);
  assert.equal(chatBody.stream, false);
  assert.deepEqual(chatBody.messages, messages);
});

const SESSION = '1'.repeat(32);
const OTHER_SESSION = '2'.repeat(32);
const SECRET_BODY = 'upstream-secret-body';

const EMBEDDING_FAILURES = [
  ['http 401', async () => Response.json({ error: { message: SECRET_BODY } }, { status: 401 })],
  ['http 429', async () => Response.json({ error: { message: SECRET_BODY } }, { status: 429 })],
  ['timeout', async () => {
    throw new Error(`aborted ${SECRET_BODY} test-siliconflow-key`);
  }],
  ['malformed json', async () => new Response(SECRET_BODY, { status: 200 })],
  ['invalid shape', async () => Response.json({ data: null })],
];

for (const [label, fetchImpl] of EMBEDDING_FAILURES) {
  test(`embedding provider ${label} is sanitized`, async () => {
    const provider = createSiliconFlowEmbeddings({
      apiKey: 'test-siliconflow-key', model: 'test-model', fetchImpl,
    });
    await assert.rejects(() => provider.embed(['q']), (error) => {
      assert.equal(error.code, 'embedding_failed');
      assert.equal(error.status, 502);
      assert.equal(error.message, '嵌入服务暂时不可用，请稍后重试。');
      assert.ok(!error.message.includes(SECRET_BODY));
      assert.ok(!error.message.includes('test-siliconflow-key'));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

const CHAT_FAILURES = [
  ['http 401', async () => Response.json({ error: { message: SECRET_BODY } }, { status: 401 })],
  ['http 429', async () => Response.json({ error: { message: SECRET_BODY } }, { status: 429 })],
  ['timeout', async () => {
    throw new Error(`aborted ${SECRET_BODY} test-deepseek-key`);
  }],
  ['malformed json', async () => new Response(SECRET_BODY, { status: 200 })],
  ['invalid shape', async () => Response.json({ choices: [] })],
];

for (const [label, fetchImpl] of CHAT_FAILURES) {
  test(`chat provider ${label} is sanitized`, async () => {
    const provider = createDeepSeekChat({
      apiKey: 'test-deepseek-key', model: 'test-chat', fetchImpl,
    });
    await assert.rejects(
      () => provider.complete([{ role: 'user', content: 'hi' }]),
      (error) => {
        assert.equal(error.code, 'chat_failed');
        assert.equal(error.status, 502);
        assert.equal(error.message, '回答服务暂时不可用，请稍后重试。');
        assert.ok(!error.message.includes(SECRET_BODY));
        assert.ok(!error.message.includes('test-deepseek-key'));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });
}

test('unconfigured providers fail closed without fetching', async () => {
  let fetches = 0;
  const embeddings = createSiliconFlowEmbeddings({
    apiKey: '', model: 'test-model', fetchImpl: async () => { fetches += 1; },
  });
  const chat = createDeepSeekChat({
    apiKey: '', model: 'test-chat', fetchImpl: async () => { fetches += 1; },
  });
  assert.equal(embeddings.configured, false);
  assert.equal(chat.configured, false);
  await assert.rejects(
    () => embeddings.embed(['q']),
    (error) => error.code === 'embedding_not_configured' && error.status === 503,
  );
  await assert.rejects(
    () => chat.complete([{ role: 'user', content: 'hi' }]),
    (error) => error.code === 'chat_not_configured' && error.status === 503,
  );
  assert.equal(fetches, 0);
});

