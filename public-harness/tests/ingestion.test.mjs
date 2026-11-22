import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import { createIngestion } from '../../functions/ingestion.mjs';
import { createQuota } from '../../functions/quota.mjs';
import { sha256Hex } from '../../functions/text.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';
import { makeTextPdf } from '../fixtures/make-pdf.mjs';

class FakeStorage {
  constructor() {
    this.files = new Map();
    this.uploads = [];
    this.removed = [];
    this.failUpload = false;
    this.failRemove = false;
  }

  async upload(path, bytes) {
    if (this.failUpload) throw new Error('upload down');
    this.uploads.push(path);
    this.files.set(path, bytes);
  }

  async remove(paths) {
    if (this.failRemove) throw new Error('remove down');
    for (const path of paths) {
      this.files.delete(path);
      this.removed.push(path);
    }
  }
}

class FakeEmbeddings {
  constructor() {
    this.calls = 0;
    this.fail = false;
    this.delay = 0;
  }

  async embed(texts) {
    this.calls += 1;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.fail) throw new Error('embedding down');
    return texts.map(() => [1, 0]);
  }
}

class ScriptedEmbeddings {
  constructor(handler) {
    this.handler = handler;
    this.calls = 0;
  }

  async embed(texts) {
    this.calls += 1;
    return this.handler(texts, this.calls);
  }
}

const NOW = new Date('2026-10-30T02:00:00Z');
const DOC_ID = '00000000-0000-4000-8000-000000000001';
const SESSION = '1'.repeat(32);
const OTHER_SESSION = '2'.repeat(32);
const IP_HASH = 'a'.repeat(64);

// A document comfortably above 32 chunks (two embedding batches) and below
// the 500-chunk per-document cap.
const MULTI_BATCH_TEXT = 'a'.repeat(20000);

function setup(overrides = {}) {
  const repository = overrides.repository ?? new InMemoryRepository();
  const storage = overrides.storage ?? new FakeStorage();
  const embeddings = overrides.embeddings ?? new FakeEmbeddings();
  const clock = overrides.clock ?? (() => NOW);
  const quota = overrides.quota ?? {
    ...createQuota({ repository, storage, clock, limits: LIMITS }),
    ...(overrides.quotaPatch ?? {}),
  };
  const ingestion = createIngestion({
    repository,
    quota,
    storage,
    embeddings,
    clock,
    limits: LIMITS,
    randomUUID: overrides.randomUUID ?? (() => DOC_ID),
  });
  return { repository, storage, embeddings, quota, ingestion };
}

function uploadBytes(name, bytes, batchId = 'batch-1', overrides = {}) {
  return {
    sessionId: SESSION,
    name,
    bytes,
    batchId,
    ipDay: '2026-10-30',
    ipHash: IP_HASH,
    ...overrides,
  };
}

function upload(name = 'notes.txt', content = '第一段\n\n第二段', overrides = {}) {
  return uploadBytes(name, new TextEncoder().encode(content), 'batch-1', overrides);
}

function isAppError(error, code, status, message) {
  return error.code === code && error.status === status
    && (message === undefined || error.message === message);
}

const EMPTY_TEXT_MESSAGE = '文件没有可提取的文本内容。';
const DUPLICATE_MESSAGE = '该文件已上传，请勿重复上传。';
const EMBEDDING_MESSAGE = '嵌入服务暂时不可用，请稍后重试。';

function recordingRepository(events, faults = {}) {
  const repository = new InMemoryRepository();
  for (const name of [
    'insertChunks',
    'insertDocument',
    'deleteDocument',
    'deleteChunks',
    'deleteDailyRow',
    'deleteReservation',
  ]) {
    const original = repository[name].bind(repository);
    repository[name] = async (...args) => {
      events.push(name);
      if (faults[name]) throw faults[name];
      return original(...args);
    };
  }
  return repository;
}

function recordingStorage(events) {
  const storage = new FakeStorage();
  const uploadFile = storage.upload.bind(storage);
  const remove = storage.remove.bind(storage);
  storage.upload = async (...args) => {
    events.push('upload');
    return uploadFile(...args);
  };
  storage.remove = async (...args) => {
    events.push('remove');
    return remove(...args);
  };
  return storage;
}

function assertNothingPersisted({ repository, storage }) {
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.chunks.size, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.daily.size, 0);
  assert.equal(storage.files.size, 0);
}

test('a successful upload stores the file, chunks, document and confirmed reservation for its session', async () => {
  const { repository, storage, ingestion } = setup();
  const document = await ingestion.ingest(upload());

  assert.equal(document.name, 'notes.txt');
  assert.equal(document.chunk_count, 1);
  assert.equal(document.session_id, SESSION);
  assert.equal(repository.documents.size, 1);
  assert.equal(repository.chunks.size, 1);
  assert.equal(storage.files.size, 1);
  assert.deepEqual(
    storage.uploads,
    [`visitors/${SESSION}/documents/${DOC_ID}.txt`],
  );
  const [reservation] = await repository.listReservations(SESSION);
  assert.equal(reservation.state, 'confirmed');
  assert.equal(reservation.chunk_count, 1);
  assert.equal(reservation.session_id, SESSION);
  const [chunk] = [...repository.chunks.values()];
  assert.equal(chunk.session_id, SESSION);
  assert.equal((await repository.listDailyRows('2026-10-30', IP_HASH)).length, 1);
});

test('a duplicate hash returns 409 before storing anything or consuming quota', async () => {
  const { repository, storage, ingestion } = setup();
  await ingestion.ingest(upload());
  const before = {
    documents: repository.documents.size,
    chunks: repository.chunks.size,
    files: storage.files.size,
    reservations: repository.reservations.size,
    daily: repository.daily.size,
  };

  await assert.rejects(
    () => ingestion.ingest(upload('other.txt', '第一段\n\n第二段', { batchId: 'batch-2' })),
    (error) => isAppError(error, 'duplicate', 409, DUPLICATE_MESSAGE),
  );
  assert.deepEqual({
    documents: repository.documents.size,
    chunks: repository.chunks.size,
    files: storage.files.size,
    reservations: repository.reservations.size,
    daily: repository.daily.size,
  }, before);
});

test('the same content may be uploaded by a different visitor session', async () => {
  let sequence = 0;
  const run = setup({
    randomUUID: () => `00000000-0000-4000-8000-${String(sequence += 1).padStart(12, '0')}`,
  });
  await run.ingestion.ingest(upload());
  const second = await run.ingestion.ingest(upload('copy.txt', '第一段\n\n第二段', {
    sessionId: OTHER_SESSION,
    ipHash: 'b'.repeat(64),
  }));

  assert.equal(second.session_id, OTHER_SESSION);
  assert.equal(run.repository.documents.size, 2);
  assert.equal(run.repository.chunks.size, 2);
  assert.equal((await run.repository.listDocuments(SESSION)).length, 1);
  assert.equal((await run.repository.listDocuments(OTHER_SESSION)).length, 1);
});

test('embedding failure removes the file, chunks, document, reservation and daily row', async () => {
  const embeddings = new FakeEmbeddings();
  embeddings.fail = true;
  const run = setup({ embeddings });

  await assert.rejects(
    () => run.ingestion.ingest(upload()),
    (error) => isAppError(error, 'embedding_failed', 502, EMBEDDING_MESSAGE),
  );
  assertNothingPersisted(run);
});

test('storage failure releases the reservation and its daily row', async () => {
  const storage = new FakeStorage();
  storage.failUpload = true;
  const { repository, ingestion } = setup({ storage });

  await assert.rejects(() => ingestion.ingest(upload()));
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.daily.size, 0);
});

test('a document above 500 chunks is rejected before embedding and releases its slot', async () => {
  const embeddings = new FakeEmbeddings();
  const run = setup({ embeddings });
  const content = 'a'.repeat(600 * 501);

  await assert.rejects(
    () => run.ingestion.ingest(upload('large.txt', content)),
    (error) => isAppError(error, 'document_too_large', 400),
  );
  assert.equal(embeddings.calls, 0);
  assertNothingPersisted(run);
});

test('the session chunk cap rejects an upload before embedding and cleans up', async () => {
  const embeddings = new FakeEmbeddings();
  const run = setup({ embeddings });
  await run.repository.insertDocument({
    id: '00000000-0000-4000-8000-000000000040',
    session_id: SESSION,
    name: 'filled.txt',
    sha256: 'filled',
    size: 1,
    chunk_count: LIMITS.sessionMaxChunks,
    object_path: `visitors/${SESSION}/documents/filled.txt`,
    created_at: NOW.toISOString(),
  });

  await assert.rejects(
    () => run.ingestion.ingest(upload()),
    (error) => isAppError(error, 'session_chunk_limit', 429),
  );
  assert.equal(embeddings.calls, 0);
  assert.equal(run.repository.documents.size, 1);
  assert.equal(run.repository.chunks.size, 0);
  assert.equal(run.repository.reservations.size, 0);
  assert.equal(run.repository.daily.size, 0);
  assert.equal(run.storage.files.size, 0);
});

test('the platform-wide chunk cap rejects an upload and cleans up', async () => {
  const embeddings = new FakeEmbeddings();
  const run = setup({ embeddings });
  await run.repository.insertDocument({
    id: '00000000-0000-4000-8000-000000000041',
    session_id: OTHER_SESSION,
    name: 'platform.txt',
    sha256: 'platform',
    size: 1,
    chunk_count: LIMITS.globalMaxChunks,
    object_path: `visitors/${OTHER_SESSION}/documents/platform.txt`,
    created_at: NOW.toISOString(),
  });

  await assert.rejects(
    () => run.ingestion.ingest(upload()),
    (error) => isAppError(error, 'capacity_full', 429, '体验名额已满，请稍后再试。'),
  );
  assert.equal(embeddings.calls, 0);
  assert.equal(run.repository.documents.size, 1);
  assert.equal(run.repository.reservations.size, 0);
  assert.equal(run.repository.daily.size, 0);
  assert.equal(run.storage.files.size, 0);
});

test('a duplicate found at document insert returns 409 and cleans up without touching the winner', async () => {
  const repository = new InMemoryRepository();
  const { ingestion, storage } = setup({ repository });
  const input = upload();

  // Another request commits the same content between our precheck and insert.
  await repository.insertDocument({
    id: '00000000-0000-4000-8000-000000000099',
    session_id: SESSION,
    name: 'other.txt',
    sha256: await sha256Hex(input.bytes),
    size: input.bytes.length,
    chunk_count: 1,
    object_path: `visitors/${SESSION}/documents/other.txt`,
    created_at: NOW.toISOString(),
  });
  repository.findDocumentByHash = async () => null;

  await assert.rejects(
    () => ingestion.ingest(input),
    (error) => isAppError(error, 'duplicate', 409, DUPLICATE_MESSAGE),
  );
  assert.equal(repository.documents.size, 1);
  assert.equal(repository.chunks.size, 0);
  assert.equal(storage.files.size, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.daily.size, 0);
});

test('a post-commit session cap overshoot removes only the losing upload', async () => {
  const repository = new InMemoryRepository();
  const listDocuments = repository.listDocuments.bind(repository);
  let calls = 0;
  repository.listDocuments = async (sessionId) => {
    calls += 1;
    if (calls < 3) return listDocuments(sessionId);
    return Array.from({ length: LIMITS.sessionMaxDocuments + 1 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      session_id: sessionId,
      name: `${index}.txt`,
      sha256: `sha-${index}`,
      size: 1,
      chunk_count: 1,
      object_path: null,
      created_at: NOW.toISOString(),
    }));
  };
  const run = setup({ repository });

  await assert.rejects(
    () => run.ingestion.ingest(upload()),
    (error) => isAppError(error, 'session_limit', 429),
  );
  assert.equal(calls, 3);
  assert.equal(run.repository.documents.size, 0);
  assert.equal(run.repository.chunks.size, 0);
  assert.equal(run.repository.reservations.size, 0);
  assert.equal(run.repository.daily.size, 0);
  assert.equal(run.storage.files.size, 0);
});

test('a processing deadline stops embedding and cleans up', async () => {
  let ticks = 0;
  const clock = () => new Date(NOW.getTime() + (ticks === 0 ? 0 : 60000));
  const embeddings = new FakeEmbeddings();
  embeddings.embed = async (texts) => {
    ticks += 1;
    return texts.map(() => [1, 0]);
  };
  const run = setup({ clock, embeddings });

  await assert.rejects(
    () => run.ingestion.ingest(upload('long.txt', MULTI_BATCH_TEXT)),
    (error) => isAppError(error, 'processing_timeout', 503),
  );
  assert.equal(ticks, 1);
  assertNothingPersisted(run);
});

test('cleanup deletes the document before chunks, the object and the daily row, and releases last', async () => {
  const events = [];
  const repository = recordingRepository(events);
  const storage = recordingStorage(events);
  const { ingestion } = setup({
    repository,
    storage,
    quotaPatch: {
      confirm: async () => {
        events.push('confirm');
        return false;
      },
    },
  });

  await assert.rejects(
    () => ingestion.ingest(upload()),
    (error) => isAppError(error, 'upload_interrupted', 409),
  );
  const ordered = events.filter((event) => [
    'insertChunks',
    'insertDocument',
    'deleteDocument',
    'deleteChunks',
    'remove',
    'deleteDailyRow',
    'deleteReservation',
  ].includes(event));
  assert.deepEqual(ordered, [
    'insertChunks',
    'insertDocument',
    'deleteDocument',
    'deleteChunks',
    'remove',
    'deleteDailyRow',
    'deleteReservation',
  ]);
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.chunks.size, 0);
  assert.equal(storage.files.size, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.daily.size, 0);
});

test('a failing document delete leaves chunks and object intact and marks the reservation cleaning', async () => {
  const events = [];
  const repository = recordingRepository(events, {
    deleteDocument: new Error('document delete down'),
  });
  const storage = recordingStorage(events);
  const { ingestion } = setup({
    repository,
    storage,
    quotaPatch: { confirm: async () => false },
  });

  await assert.rejects(
    () => ingestion.ingest(upload()),
    (error) => isAppError(error, 'upload_interrupted', 409),
  );
  assert.equal(repository.documents.size, 1);
  assert.equal(repository.chunks.size, 1);
  assert.equal(storage.files.size, 1);
  assert.ok(!events.includes('deleteChunks'));
  assert.ok(!events.includes('remove'));
  const reservations = await repository.listReservations(SESSION);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].state, 'cleaning');
  assert.equal(repository.daily.size, 1);
});

test('a failing chunk delete leaves a cleaning reservation and no document', async () => {
  const events = [];
  const repository = recordingRepository(events, {
    deleteChunks: new Error('chunk delete down'),
  });
  const storage = recordingStorage(events);
  const { ingestion } = setup({
    repository,
    storage,
    quotaPatch: { confirm: async () => false },
  });

  await assert.rejects(
    () => ingestion.ingest(upload()),
    (error) => isAppError(error, 'upload_interrupted', 409),
  );
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.chunks.size, 1);
  assert.equal(storage.files.size, 1);
  assert.ok(!events.includes('remove'));
  const reservations = await repository.listReservations(SESSION);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].state, 'cleaning');
});

test('a whitespace-only text file fails with empty_text and releases its reservation', async () => {
  const run = setup();

  await assert.rejects(
    () => run.ingestion.ingest(upload('blank.txt', '   \n\n\t  ')),
    (error) => isAppError(error, 'empty_text', 400, EMPTY_TEXT_MESSAGE),
  );
  assertNothingPersisted(run);
});

test('a PDF without extractable text fails with empty_text and releases its reservation', async () => {
  const run = setup();

  await assert.rejects(
    () => run.ingestion.ingest(uploadBytes('blank.pdf', makeTextPdf(''))),
    (error) => isAppError(error, 'empty_text', 400, EMPTY_TEXT_MESSAGE),
  );
  assertNothingPersisted(run);
});

test('a throw on the second embedding batch is sanitized and leaves no partial library', async () => {
  const embeddings = new ScriptedEmbeddings((texts, call) => {
    if (call === 1) return texts.map(() => [1, 0]);
    throw new Error('provider body sk-secret and raw document text');
  });
  const run = setup({ embeddings });

  await assert.rejects(
    () => run.ingestion.ingest(upload('long.txt', MULTI_BATCH_TEXT)),
    (error) => isAppError(error, 'embedding_failed', 502, EMBEDDING_MESSAGE)
      && !error.message.includes('sk-secret')
      && !error.message.includes('raw document text'),
  );
  assert.equal(embeddings.calls, 2);
  assertNothingPersisted(run);
});

test('a second batch with the wrong vector count fails with embedding_failed', async () => {
  const embeddings = new ScriptedEmbeddings((texts, call) => (
    call === 1
      ? texts.map(() => [1, 0])
      : texts.slice(1).map(() => [1, 0])
  ));
  const run = setup({ embeddings });

  await assert.rejects(
    () => run.ingestion.ingest(upload('long.txt', MULTI_BATCH_TEXT)),
    (error) => isAppError(error, 'embedding_failed', 502, EMBEDDING_MESSAGE),
  );
  assert.equal(embeddings.calls, 2);
  assertNothingPersisted(run);
});

test('a second batch with a different vector dimension fails with embedding_failed', async () => {
  const embeddings = new ScriptedEmbeddings((texts, call) => (
    call === 1
      ? texts.map(() => [1, 0])
      : texts.map(() => [1, 0, 0])
  ));
  const run = setup({ embeddings });

  await assert.rejects(
    () => run.ingestion.ingest(upload('long.txt', MULTI_BATCH_TEXT)),
    (error) => isAppError(error, 'embedding_failed', 502, EMBEDDING_MESSAGE),
  );
  assert.equal(embeddings.calls, 2);
  assertNothingPersisted(run);
});

test('a non-finite vector value fails with embedding_failed', async () => {
  const embeddings = new ScriptedEmbeddings((texts) => (
    texts.map(() => [1, Number.POSITIVE_INFINITY])
  ));
  const run = setup({ embeddings });

  await assert.rejects(
    () => run.ingestion.ingest(upload()),
    (error) => isAppError(error, 'embedding_failed', 502, EMBEDDING_MESSAGE),
  );
  assertNothingPersisted(run);
});

test('a false heartbeat between batches aborts with upload_interrupted and cleans up', async () => {
  const embeddings = new FakeEmbeddings();
  const run = setup({
    embeddings,
    quotaPatch: { heartbeat: async () => false },
  });

  await assert.rejects(
    () => run.ingestion.ingest(upload('long.txt', MULTI_BATCH_TEXT)),
    (error) => isAppError(error, 'upload_interrupted', 409),
  );
  assert.equal(embeddings.calls, 1);
  assertNothingPersisted(run);
});

test('a lost confirm after commit cleans up and reports the interruption', async () => {
  const run = setup({
    quotaPatch: { confirm: async () => null },
  });

  await assert.rejects(
    () => run.ingestion.ingest(upload()),
    (error) => isAppError(error, 'upload_interrupted', 409),
  );
  assertNothingPersisted(run);
});

test('validation runs in order and touches no bookkeeping', async () => {
  const run = setup();

  await assert.rejects(
    () => run.ingestion.ingest({ ...upload('photo.png', ''), batchId: '' }),
    (error) => isAppError(error, 'unsupported_file', 400),
  );
  await assert.rejects(
    () => run.ingestion.ingest({ ...upload(), name: '   ' }),
    (error) => isAppError(error, 'invalid_file_name', 400),
  );
  await assert.rejects(
    () => run.ingestion.ingest(upload('notes.txt', '')),
    (error) => isAppError(error, 'empty_file', 400),
  );
  await assert.rejects(
    () => run.ingestion.ingest({ ...upload(), batchId: '' }),
    (error) => isAppError(error, 'invalid_batch', 400),
  );
  assert.equal(run.repository.attempts.size, 0);
  assert.equal(run.repository.reservations.size, 0);
  assert.equal(run.repository.daily.size, 0);
  assert.equal(run.storage.files.size, 0);
});
