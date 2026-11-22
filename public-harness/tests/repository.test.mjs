import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository, isUniqueViolation } from '../../functions/repository.mjs';
import { UniqueConflict } from '../../functions/errors.mjs';

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.calls = [];
  }

  select(columns, options) { this.calls.push(['select', columns, options]); return this; }
  order(column, options) { this.calls.push(['order', column, options]); return this; }
  limit(value) { this.calls.push(['limit', value]); return this; }
  range(from, to) { this.calls.push(['range', from, to]); return this; }
  eq(column, value) { this.calls.push(['eq', column, value]); return this; }
  insert(values) { this.calls.push(['insert', values]); return this; }
  update(values) { this.calls.push(['update', values]); return this; }
  delete() { this.calls.push(['delete']); return this; }
  then(resolve, reject) {
    return Promise.resolve(this.db.next(this.table, this.calls)).then(resolve, reject);
  }
}

class FakeDb {
  constructor(results) {
    this.results = results;
    this.queries = [];
  }

  from(table) {
    const query = new FakeQuery(this, table);
    this.queries.push(query);
    return query;
  }

  next(table) {
    const queue = this.results[table];
    if (!queue || queue.length === 0) return { data: [], error: null };
    const value = queue.shift();
    return value instanceof Error ? { data: null, error: value } : value;
  }
}

function callsOf(query, name) {
  return query.calls.filter((call) => call[0] === name);
}

function mutationQueries(db) {
  return db.queries.filter((query) => query.calls.some((call) => call[0] === 'update'
    || call[0] === 'delete' || call[0] === 'insert'));
}

test('unique violations map to UniqueConflict', async () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ code: '42501' }), false);
  assert.equal(isUniqueViolation(null), false);

  const db = new FakeDb({
    visitor_documents: [{ data: null, error: { code: '23505' } }],
  });
  const repository = createRepository(db);
  await assert.rejects(
    () => repository.insertDocument({
      id: '00000000-0000-4000-8000-000000000001',
      session_id: 'a'.repeat(32),
      name: 'a.txt', sha256: 'a', size: 1, chunk_count: 1,
      object_path: 'visitors/aaa/documents/1.txt',
      created_at: '2026-10-30T00:00:00Z',
    }),
    UniqueConflict,
  );
});

test('session chunks paginate 1000-row pages and never cross sessions', async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({ chunk_key: `c${index}` }));
  const second = [{ chunk_key: 'c1000' }];
  const db = new FakeDb({
    visitor_chunks: [{ data: first, error: null }, { data: second, error: null }],
  });
  const repository = createRepository(db);
  const rows = await repository.listAllChunks('a'.repeat(32));

  assert.equal(rows.length, 1001);
  assert.deepEqual(
    db.queries.map((query) => callsOf(query, 'range')[0]),
    [['range', 0, 999], ['range', 1000, 1999]],
  );
  for (const query of db.queries) {
    assert.deepEqual(callsOf(query, 'eq'), [['eq', 'session_id', 'a'.repeat(32)]]);
    assert.equal(callsOf(query, 'in').length, 0);
  }
});

test('platform chunk totals page across every document', async () => {
  const first = Array.from({ length: 1000 }, () => ({ chunk_count: '2' }));
  const second = [{ chunk_count: 3 }];
  const db = new FakeDb({
    visitor_documents: [{ data: first, error: null }, { data: second, error: null }],
  });
  const repository = createRepository(db);

  assert.equal(await repository.sumAllChunkCounts(), 2003);
  assert.deepEqual(
    db.queries.map((query) => callsOf(query, 'range')[0]),
    [['range', 0, 999], ['range', 1000, 1999]],
  );
});

test('documents are normalized and scoped to the visitor session', async () => {
  const db = new FakeDb({
    visitor_documents: [{
      data: [{
        id: 'd1', session_id: 'a'.repeat(32), name: 'a.txt', sha256: 'a',
        size: '12', chunk_count: '2', object_path: 'visitors/a/documents/d1.txt',
        created_at: '2026-10-30T00:00:00Z',
      }],
      error: null,
    }],
  });
  const repository = createRepository(db);
  const [document] = await repository.listDocuments('a'.repeat(32));

  assert.equal(document.size, 12);
  assert.equal(document.chunk_count, 2);
  assert.deepEqual(callsOf(db.queries[0], 'eq'), [['eq', 'session_id', 'a'.repeat(32)]]);
});

test('reservation updates are conditional on session, id and expected state', async () => {
  const sessionId = 'a'.repeat(32);
  const db = new FakeDb({
    visitor_reservations: [
      { data: null, error: null },
      { data: [{ id: 'r1', session_id: sessionId, state: 'confirmed', chunk_count: '2' }], error: null },
    ],
  });
  const repository = createRepository(db);
  const updated = await repository.updateReservation(sessionId, 'r1', ['reserved'], {
    state: 'confirmed',
  });

  assert.equal(updated.state, 'confirmed');
  assert.equal(updated.chunk_count, 2);
  const write = db.queries[0].calls;
  assert.deepEqual(
    callsOf(db.queries[0], 'eq'),
    [['eq', 'session_id', sessionId], ['eq', 'id', 'r1'], ['eq', 'state', 'reserved']],
  );
  assert.equal(write.some((call) => call[0] === 'in'), false);
  assert.equal(write.some((call) => call[0] === 'select'), false);
  assert.equal(write.some((call) => call[0] === 'limit'), false);
  assert.deepEqual(
    callsOf(db.queries[1], 'eq'),
    [['eq', 'session_id', sessionId], ['eq', 'id', 'r1']],
  );
});

test('reservation CAS tries each allowed state and reports a lost race', async () => {
  const sessionId = 'b'.repeat(32);
  const db = new FakeDb({
    visitor_reservations: [
      { data: null, error: null },
      { data: [{ id: 'r2', session_id: sessionId, state: 'committing' }], error: null },
      { data: null, error: null },
      { data: [{ id: 'r2', session_id: sessionId, state: 'cleaning' }], error: null },
    ],
  });
  const repository = createRepository(db);
  const updated = await repository.updateReservation(sessionId, 'r2', ['reserved', 'committing'], {
    state: 'cleaning',
  });

  assert.equal(updated.state, 'cleaning');
  assert.deepEqual(
    mutationQueries(db).map((query) => callsOf(query, 'eq').at(-1)),
    [['eq', 'state', 'reserved'], ['eq', 'state', 'committing']],
  );

  const missed = new FakeDb({
    visitor_reservations: [
      { data: null, error: null },
      { data: [{ id: 'r3', session_id: sessionId, state: 'reserved' }], error: null },
    ],
  });
  const missedRepo = createRepository(missed);
  assert.equal(
    await missedRepo.updateReservation(sessionId, 'r3', ['reserved'], { state: 'confirmed' }),
    null,
  );
});

test('stale reservations are filtered in JS from one bounded read, oldest first', async () => {
  const db = new FakeDb({
    visitor_reservations: [{
      data: [
        { id: 'fresh', state: 'reserved', expires_at: '2026-10-30T07:00:00Z' },
        { id: 'old', state: 'committing', expires_at: '2026-10-30T04:00:00+00:00' },
        { id: 'oldest', state: 'cleaning', expires_at: '2026-10-30T03:00:00Z' },
        { id: 'done', state: 'confirmed', expires_at: '2026-10-30T02:00:00Z' },
      ],
      error: null,
    }],
  });
  const repository = createRepository(db);
  const stale = await repository.listStaleReservations('2026-10-30T06:00:00Z', 2);

  assert.deepEqual(stale.map((row) => row.id), ['oldest', 'old']);
  assert.equal(db.queries.length, 1);
  const used = new Set(db.queries.flatMap((query) => query.calls.map((call) => call[0])));
  assert.equal(used.has('in'), false);
  assert.equal(used.has('lt'), false);
});

test('old batch attempts are pruned per key from a bounded, session-scoped read', async () => {
  const sessionId = 'c'.repeat(32);
  const db = new FakeDb({
    visitor_batch_attempts: [
      {
        data: [
          { attempt_key: `${sessionId}:b:old-1`, created_at: '2026-10-20T00:00:00Z' },
          { attempt_key: `${sessionId}:b:new-1`, created_at: '2026-10-30T00:00:00Z' },
        ],
        error: null,
      },
      { data: [], error: null },
    ],
  });
  const repository = createRepository(db);
  await repository.deleteOldAttempts(sessionId, '2026-10-28T00:00:00Z');

  assert.equal(db.queries.length, 2);
  assert.deepEqual(callsOf(db.queries[0], 'eq'), [['eq', 'session_id', sessionId]]);
  assert.deepEqual(
    db.queries[1].calls,
    [
      ['delete'],
      ['eq', 'session_id', sessionId],
      ['eq', 'attempt_key', `${sessionId}:b:old-1`],
    ],
  );
});

test('sessions read, touch and delete by id', async () => {
  const sessionId = 'd'.repeat(32);
  const db = new FakeDb({
    visitor_sessions: [
      { data: [{ id: sessionId, expires_at: '2026-10-30T08:00:00Z' }], error: null },
      { data: null, error: null },
      { data: [], error: null },
    ],
  });
  const repository = createRepository(db);

  const session = await repository.getSession(sessionId);
  assert.equal(session.id, sessionId);
  await repository.updateSession(sessionId, { last_seen_at: '2026-10-30T07:00:00Z' });
  await repository.deleteSession(sessionId);

  assert.deepEqual(callsOf(db.queries[0], 'eq'), [['eq', 'id', sessionId]]);
  assert.deepEqual(
    db.queries[1].calls,
    [['update', { last_seen_at: '2026-10-30T07:00:00Z' }], ['eq', 'id', sessionId]],
  );
  assert.deepEqual(db.queries[2].calls, [['delete'], ['eq', 'id', sessionId]]);
});

test('daily ledger reads are per day and hash, and pruning is bounded', async () => {
  const db = new FakeDb({
    visitor_ip_daily: [
      {
        data: [{ id: 'row-1', ip_day: '2026-10-30', ip_hash: 'h1', created_at: '2026-10-30T00:00:00Z' }],
        error: null,
      },
      {
        data: [
          { id: 'old-1', ip_day: '2026-10-20' },
          { id: 'old-2', ip_day: '2026-10-21' },
          { id: 'fresh', ip_day: '2026-10-30' },
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
    ],
  });
  const repository = createRepository(db);

  const rows = await repository.listDailyRows('2026-10-30', 'h1');
  assert.equal(rows.length, 1);
  assert.deepEqual(
    callsOf(db.queries[0], 'eq'),
    [['eq', 'ip_day', '2026-10-30'], ['eq', 'ip_hash', 'h1']],
  );

  await repository.pruneDailyRows('2026-10-28');
  assert.deepEqual(db.queries[1].calls, [['select', 'id,ip_day', undefined], ['limit', 1000]]);
  assert.deepEqual(
    db.queries.slice(2).map((query) => query.calls),
    [
      [['delete'], ['eq', 'id', 'old-1']],
      [['delete'], ['eq', 'id', 'old-2']],
    ],
  );
});
