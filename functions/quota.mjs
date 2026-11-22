import { LIMITS } from './config.mjs';
import { fail } from './errors.mjs';

const ACTIVE_STATES = ['reserved', 'committing', 'cleaning'];

export function createQuota({
  repository,
  storage,
  clock = () => new Date(),
  limits = LIMITS,
}) {
  const nowIso = () => clock().toISOString();
  const afterMinutes = (minutes) =>
    new Date(clock().getTime() + minutes * 60000).toISOString();

  async function recoverStale() {
    const stale = await repository.listStaleReservations(nowIso(), 20);
    for (const reservation of stale) {
      const document = await repository.getDocument(
        reservation.session_id,
        reservation.document_id,
      );
      if (document) {
        await repository.updateReservation(
          reservation.session_id,
          reservation.id,
          ACTIVE_STATES,
          {
            state: 'confirmed',
            chunk_count: Number(document.chunk_count),
            updated_at: nowIso(),
            expires_at: nowIso(),
          },
        );
        continue;
      }

      try {
        await storage.remove([reservation.object_path]);
        await repository.deleteChunks(reservation.session_id, reservation.document_id);
        if (reservation.daily_key) {
          await repository.deleteDailyRow(reservation.daily_key);
        }
        await repository.deleteReservation(reservation.session_id, reservation.id);
      } catch {
        await repository.updateReservation(
          reservation.session_id,
          reservation.id,
          [reservation.state],
          {
            state: 'cleaning',
            updated_at: nowIso(),
            expires_at: afterMinutes(10),
          },
        );
      }
    }
  }

  async function reserve({
    sessionId, documentId, objectPath, sha256, batchId, ipDay, ipHash,
  }) {
    const [documents, reservations, daily] = await Promise.all([
      repository.listDocuments(sessionId),
      repository.listReservations(sessionId),
      repository.listDailyRows(ipDay, ipHash),
    ]);

    const pending = reservations.filter((item) => item.state !== 'confirmed').length;
    if (documents.length + pending >= limits.sessionMaxDocuments) {
      fail(
        'session_limit',
        `本次体验最多添加 ${limits.sessionMaxDocuments} 份资料，可结束体验后重新开始。`,
        429,
      );
    }
    if (daily.length >= limits.dailyUploads) {
      fail('daily_limit', '今日体验上传额度已用完，请明天再试。', 429);
    }

    const now = nowIso();
    const dailyKey = crypto.randomUUID();
    // Inserted before the reservation so the daily cap cannot be bypassed by
    // abandoning this upload; removed again if the reservation cannot be saved.
    await repository.insertDailyRow({
      id: dailyKey,
      ip_day: ipDay,
      ip_hash: ipHash,
      created_at: now,
    });

    const reservation = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      document_id: documentId,
      sha256,
      object_path: objectPath,
      state: 'reserved',
      batch_id: batchId,
      ip_day: ipDay,
      ip_hash: ipHash,
      daily_key: dailyKey,
      created_at: now,
      updated_at: now,
      expires_at: afterMinutes(limits.leaseMs / 60000),
      chunk_count: null,
    };

    try {
      await repository.insertReservation(reservation);
      return reservation;
    } catch (error) {
      await repository.deleteDailyRow(dailyKey).catch(() => {});
      throw error;
    }
  }

  async function heartbeat(sessionId, id) {
    return repository.updateReservation(sessionId, id, ['reserved'], {
      updated_at: nowIso(),
      expires_at: afterMinutes(limits.leaseMs / 60000),
    });
  }

  async function confirm(sessionId, id, chunkCount) {
    return repository.updateReservation(sessionId, id, ['reserved'], {
      state: 'confirmed',
      chunk_count: chunkCount,
      updated_at: nowIso(),
      expires_at: nowIso(),
    });
  }

  async function release(sessionId, id) {
    await repository.deleteReservation(sessionId, id);
  }

  async function markCleaning(sessionId, id) {
    return repository.updateReservation(sessionId, id, ['reserved', 'committing'], {
      state: 'cleaning',
      updated_at: nowIso(),
      expires_at: afterMinutes(10),
    });
  }

  async function recordBatchAttempt(sessionId, batchId) {
    const attempts = await repository.listBatchAttempts(sessionId, batchId);
    if (attempts.length >= limits.maxBatchFiles) {
      fail('batch_limit', `每批最多添加 ${limits.maxBatchFiles} 个文件。`, 400);
    }
    const attemptKey = `${batchId}:${crypto.randomUUID()}`;
    await repository.insertBatchAttempt({
      attempt_key: attemptKey,
      session_id: sessionId,
      batch_id: batchId,
      created_at: nowIso(),
    });
    const after = await repository.listBatchAttempts(sessionId, batchId);
    if (after.length > limits.maxBatchFiles) {
      await repository.deleteBatchAttempt(sessionId, attemptKey);
      fail('batch_limit', `每批最多添加 ${limits.maxBatchFiles} 个文件。`, 400);
    }
  }

  return {
    reserve,
    heartbeat,
    confirm,
    release,
    markCleaning,
    recoverStale,
    recordBatchAttempt,
  };
}
