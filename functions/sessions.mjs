import { LIMITS } from './config.mjs';
import { AppError } from './errors.mjs';

const SESSION_ID = /^[0-9a-f]{32}$/;
const SESSION_EXPIRED_MESSAGE = '体验会话已过期，请刷新页面重新开始。';

function sessionExpired() {
  return new AppError('session_expired', SESSION_EXPIRED_MESSAGE, 401);
}

export function newSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function createSessions({
  repository,
  storage,
  clock = () => new Date(),
  limits = LIMITS,
}) {
  const nowIso = () => clock().toISOString();
  const expiresIso = () => new Date(clock().getTime() + limits.sessionTtlMs).toISOString();

  async function createRecord() {
    const now = nowIso();
    const row = {
      id: newSessionId(),
      created_at: now,
      last_seen_at: now,
      expires_at: expiresIso(),
    };
    await repository.insertSession(row);
    return { session_id: row.id, expires_at: row.expires_at };
  }

  // Removes every trace of one visitor session. The session row is deleted
  // last, so a partial failure leaves the session discoverable and the sweep
  // can retry instead of orphaning rows. The per-IP daily ledger is kept on
  // purpose: ending a session must not refund the day's upload allowance.
  async function purge(sessionId) {
    const [documents, reservations] = await Promise.all([
      repository.listDocuments(sessionId),
      repository.listReservations(sessionId),
    ]);

    const objectPaths = [...new Set(
      [...documents, ...reservations]
        .map((item) => item.object_path)
        .filter((path) => typeof path === 'string' && path.startsWith(`visitors/${sessionId}/`)),
    )];
    if (objectPaths.length > 0) await storage.remove(objectPaths);

    for (const document of documents) {
      await repository.deleteChunks(sessionId, document.id);
      await repository.deleteDocument(sessionId, document.id);
    }
    for (const reservation of reservations) {
      await repository.deleteReservation(sessionId, reservation.id);
    }
    await repository.deleteSessionAttempts(sessionId);
    await repository.deleteSession(sessionId);
  }

  async function purgeExpired(limit = limits.sessionPurgeLimit) {
    let sessions;
    try {
      sessions = await repository.listSessions();
    } catch {
      return;
    }
    const now = clock().getTime();
    const expired = sessions
      .filter((row) => Number.isFinite(new Date(row.expires_at).getTime())
        && new Date(row.expires_at).getTime() <= now)
      .sort((left, right) => new Date(left.expires_at) - new Date(right.expires_at))
      .slice(0, limit);
    for (const row of expired) {
      try {
        await purge(row.id);
      } catch {
        // Leave the row for a later sweep; cleanup is best effort per request.
      }
    }
  }

  async function create() {
    await purgeExpired();
    return createRecord();
  }

  async function resolve(sessionId) {
    if (!isSessionId(sessionId)) throw sessionExpired();
    const row = await repository.getSession(sessionId);
    if (!row) throw sessionExpired();
    const now = clock().getTime();
    const expiry = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiry) || expiry <= now) {
      await purge(sessionId).catch(() => {});
      throw sessionExpired();
    }
    // Sliding idle window, written at most once per `sessionTouchMs`. A failed
    // touch never invalidates a still-fresh session.
    if (expiry - now < limits.sessionTtlMs - limits.sessionTouchMs) {
      await repository.updateSession(sessionId, {
        last_seen_at: nowIso(),
        expires_at: expiresIso(),
      }).catch(() => {});
    }
    return row;
  }

  async function end(sessionId) {
    await purge(sessionId);
    await purgeExpired();
    return createRecord();
  }

  return { create, resolve, end, purge, purgeExpired };
}
