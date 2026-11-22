import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import { createQuota } from '../../functions/quota.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeStorage {
  constructor() { this.files = new Map(); this.failRemove = false; this.removed = []; }
  async upload(path, bytes) { this.files.set(path, bytes); }
  async remove(paths) {
    if (this.failRemove) throw new Error('storage down');
    for (const path of paths) {
      this.files.delete(path);
      this.removed.push(path);
    }
  }
}

const NOW = new Date('2026-10-30T02:00:00Z');
const SESSION = 'a'.repeat(32);
const STALE_AT = '2026-10-30T01:00:00.000Z';

function setup() {
  const repository = new InMemoryRepository();
  const storage = new FakeStorage();
  const quota = createQuota({ repository, storage, clock: () => NOW, limits: LIMITS });
  return { repository, storage, quota };
}

function sessionId(index) {
  return index.toString(16).padStart(32, '0');
}

function documentId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function reservationInput(index, overrides = {}) {
  const session = overrides.sessionId ?? SESSION;
  return {
    sessionId: session,
    documentId: documentId(index),
    objectPath: `visitors/${session}/documents/${documentId(index)}.txt`,
    sha256: `sha-${index}`,
    batchId: `batch-${index}`,
    ipDay: '2026-10-30',
    ipHash: 'a'.repeat(64),
    ...overrides,
  };
}

function wrapRepository(repository, overrides) {
  return new Proxy(repository, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function insertStaleReservation(repository, storage, index) {
  const session = sessionId(index);
  const row = {
    id: `11111111-0000-4000-8000-${String(index).padStart(12, '0')}`,
    session_id: session,
    document_id: documentId(1000 + index),
    sha256: `stale-sha-${index}`,
    object_path: `visitors/${session}/documents/stale-${index}.txt`,
    state: 'reserved',
    batch_id: null,
    ip_day: '2026-10-30',
    ip_hash: 'stale-ip',
    daily_key: null,
    created_at: STALE_AT,
    updated_at: STALE_AT,
    expires_at: STALE_AT,
    chunk_count: null,
  };
  await repository.insertReservation(row);
  await storage.upload(row.object_path, new Uint8Array([index]));
  return row;
}

test('the 21st pending upload in one session is rejected without changing the first 20', async () => {
  const { repository, quota } = setup();
  for (let index = 1; index <= 20; index += 1) {
    await quota.reserve(reservationInput(index));
  }
  assert.equal((await repository.listReservations(SESSION)).length, 20);
  assert.equal((await repository.listDocuments(SESSION)).length, 0);

  await assert.rejects(
    () => quota.reserve(reservationInput(21)),
    (error) => error.code === 'session_limit' && error.status === 429,
  );
  assert.equal((await repository.listReservations(SESSION)).length, 20);
  assert.equal((await repository.listDailyRows('2026-10-30', 'a'.repeat(64))).length, 20);
});

test('sessions do not share document slots', async () => {
  const { repository, quota } = setup();
  for (let index = 1; index <= 20; index += 1) {
    await quota.reserve(reservationInput(index, { sessionId: sessionId(1) }));
  }
  await quota.reserve(reservationInput(21, { sessionId: sessionId(2) }));
  assert.equal((await repository.listReservations(sessionId(1))).length, 20);
  assert.equal((await repository.listReservations(sessionId(2))).length, 1);
});

test('the 31st same-IP upload is rejected across sessions and no daily row leaks', async () => {
  const { repository, quota } = setup();
  const ipHash = 'b'.repeat(64);
  for (let index = 1; index <= 30; index += 1) {
    await quota.reserve(reservationInput(index, {
      sessionId: sessionId(index),
      ipHash,
    }));
  }
  assert.equal((await repository.listDailyRows('2026-10-30', ipHash)).length, 30);

  await assert.rejects(
    () => quota.reserve(reservationInput(31, { sessionId: sessionId(31), ipHash })),
    (error) => error.code === 'daily_limit' && error.status === 429
      && error.message === '今日体验上传额度已用完，请明天再试。',
  );
  assert.equal((await repository.listDailyRows('2026-10-30', ipHash)).length, 30);
});

test('releasing a reservation does not refund the IP daily allowance', async () => {
  const { repository, quota } = setup();
  const input = reservationInput(1, { ipHash: 'c'.repeat(64), sessionId: sessionId(1) });
  const reservation = await quota.reserve(input);
  await quota.release(sessionId(1), reservation.id);
  assert.equal((await repository.listReservations(sessionId(1))).length, 0);
  assert.equal((await repository.listDailyRows('2026-10-30', 'c'.repeat(64))).length, 1);
});

test('a failed reservation insert removes its daily row', async () => {
  const repository = new InMemoryRepository();
  const storage = new FakeStorage();
  const quota = createQuota({
    repository: wrapRepository(repository, {
      async insertReservation() { throw new Error('write failed'); },
    }),
    storage,
    clock: () => NOW,
    limits: LIMITS,
  });

  await assert.rejects(() => quota.reserve(reservationInput(1)), /write failed/);
  assert.deepEqual(await repository.listDailyRows('2026-10-30', 'a'.repeat(64)), []);
  assert.deepEqual(await repository.listReservations(SESSION), []);
});

test('a batch rejects its 51st eligible attempt and keeps 50', async () => {
  const { repository, quota } = setup();
  for (let index = 1; index <= 50; index += 1) {
    await quota.recordBatchAttempt(SESSION, 'one-batch');
  }
  assert.equal((await repository.listBatchAttempts(SESSION, 'one-batch')).length, 50);

  await assert.rejects(
    () => quota.recordBatchAttempt(SESSION, 'one-batch'),
    (error) => error.code === 'batch_limit' && error.status === 400
      && error.message === '每批最多添加 50 个文件。',
  );
  assert.equal((await repository.listBatchAttempts(SESSION, 'one-batch')).length, 50);

  await quota.recordBatchAttempt(sessionId(2), 'one-batch');
  assert.equal((await repository.listBatchAttempts(sessionId(2), 'one-batch')).length, 1);
});

test('confirm is compare-and-set per session and heartbeat fails after confirmation', async () => {
  const { quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));

  const confirmed = await quota.confirm(SESSION, reservation.id, 4);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.chunk_count, 4);
  assert.equal(await quota.confirm(SESSION, reservation.id, 4), null);
  assert.equal(await quota.heartbeat(SESSION, reservation.id), null);
  assert.equal(await quota.confirm(sessionId(9), reservation.id, 4), null);
  assert.equal(await quota.heartbeat(sessionId(9), reservation.id), null);
});

test('stale reserved rows without a document are removed with object, chunks and daily row', async () => {
  const { repository, storage, quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  await storage.upload(reservation.object_path, new Uint8Array([1]));
  await repository.insertChunks([{
    chunk_key: `${SESSION}:chunk-1`,
    session_id: SESSION,
    document_id: reservation.document_id,
    file_name: 'a.txt',
    page: null,
    chunk_index: 0,
    text: 'x',
    embedding: 'e',
    norm: 1,
  }]);
  await repository.updateReservation(SESSION, reservation.id, ['reserved'], {
    expires_at: STALE_AT,
  });

  await quota.recoverStale();

  assert.equal(await repository.getReservation(SESSION, reservation.id), null);
  assert.equal(storage.files.has(reservation.object_path), false);
  assert.equal((await repository.listChunks(SESSION, reservation.document_id)).length, 0);
  assert.equal(repository.daily.has(reservation.daily_key), false);
});

test('stale rows with a committed document become confirmed', async () => {
  const { repository, quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  await repository.insertDocument({
    id: reservation.document_id,
    session_id: SESSION,
    name: 'a.txt',
    sha256: reservation.sha256,
    size: 1,
    chunk_count: 7,
    object_path: reservation.object_path,
    created_at: NOW.toISOString(),
  });
  await repository.updateReservation(SESSION, reservation.id, ['reserved'], {
    expires_at: STALE_AT,
  });

  await quota.recoverStale();

  const recovered = await repository.getReservation(SESSION, reservation.id);
  assert.equal(recovered.state, 'confirmed');
  assert.equal(recovered.chunk_count, 7);
  assert.equal(recovered.expires_at, NOW.toISOString());
  assert.equal(recovered.updated_at, NOW.toISOString());
  assert.notEqual(recovered.expires_at, STALE_AT);
});

test('markCleaning moves reserved and committing rows to cleaning with a ten minute lease', async () => {
  const { repository, quota } = setup();
  const expectedExpiry = new Date(NOW.getTime() + 10 * 60000).toISOString();
  assert.equal(expectedExpiry, '2026-10-30T02:10:00.000Z');

  const reserved = await quota.reserve(reservationInput(1));
  const committing = await quota.reserve(reservationInput(2));
  await repository.updateReservation(SESSION, committing.id, ['reserved'], {
    state: 'committing',
  });

  const fromReserved = await quota.markCleaning(SESSION, reserved.id);
  const fromCommitting = await quota.markCleaning(SESSION, committing.id);

  for (const [source, updated] of [
    [reserved, fromReserved],
    [committing, fromCommitting],
  ]) {
    assert.ok(updated, `markCleaning must return the updated row for ${source.state}`);
    assert.equal(updated.state, 'cleaning');
    assert.equal(updated.expires_at, expectedExpiry);
    assert.equal(updated.updated_at, NOW.toISOString());

    const persisted = await repository.getReservation(SESSION, source.id);
    assert.equal(persisted.state, 'cleaning');
    assert.equal(persisted.expires_at, expectedExpiry);
  }

  assert.equal(
    (await repository.listStaleReservations(
      new Date(NOW.getTime() + 9 * 60000).toISOString(), 20,
    )).length,
    0,
  );
  assert.equal(
    (await repository.listStaleReservations(
      new Date(NOW.getTime() + 11 * 60000).toISOString(), 20,
    )).length,
    2,
  );

  assert.equal(await quota.markCleaning(SESSION, reserved.id), null);
  assert.equal((await repository.getReservation(SESSION, reserved.id)).state, 'cleaning');
  assert.equal(await quota.markCleaning(sessionId(9), committing.id), null);
  assert.equal((await repository.getReservation(SESSION, committing.id)).state, 'cleaning');

  const confirmed = await quota.reserve(reservationInput(3));
  await quota.confirm(SESSION, confirmed.id, 5);
  assert.equal(await quota.markCleaning(SESSION, confirmed.id), null);

  const unchanged = await repository.getReservation(SESSION, confirmed.id);
  assert.equal(unchanged.state, 'confirmed');
  assert.equal(unchanged.chunk_count, 5);
  assert.equal(unchanged.expires_at, NOW.toISOString());
});

test('recoverStale sweeps at most 20 rows per call and the next call drains the rest', async () => {
  const { repository, storage, quota } = setup();
  const rows = [];
  for (let index = 1; index <= 25; index += 1) {
    rows.push(await insertStaleReservation(repository, storage, index));
  }
  assert.equal((await repository.listAllReservations()).length, 25);
  assert.equal(storage.files.size, 25);

  await quota.recoverStale();

  const firstBatch = rows.slice(0, 20);
  assert.equal(storage.removed.length, 20);
  assert.deepEqual(storage.removed, firstBatch.map((row) => row.object_path));
  assert.equal(storage.files.size, 5);
  for (const row of firstBatch) {
    assert.equal(storage.files.has(row.object_path), false);
    assert.equal(await repository.getReservation(row.session_id, row.id), null);
  }

  const survivors = await repository.listAllReservations();
  assert.equal(survivors.length, 5);
  assert.deepEqual(
    survivors.map((row) => row.id).sort(),
    rows.slice(20).map((row) => row.id).sort(),
  );

  await quota.recoverStale();

  assert.equal(storage.removed.length, 25);
  assert.equal(storage.files.size, 0);
  assert.deepEqual(await repository.listAllReservations(), []);

  await quota.recoverStale();
  assert.equal(storage.removed.length, 25);
  assert.deepEqual(await repository.listAllReservations(), []);
});

test('failed storage cleanup keeps the reservation for a later recovery', async () => {
  const { repository, storage, quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  storage.failRemove = true;
  await repository.updateReservation(SESSION, reservation.id, ['reserved'], {
    expires_at: STALE_AT,
  });

  await quota.recoverStale();

  const stillThere = await repository.getReservation(SESSION, reservation.id);
  assert.equal(stillThere.state, 'cleaning');
  assert.ok(stillThere.expires_at > '2026-10-30T02:00:00.000Z');
});
