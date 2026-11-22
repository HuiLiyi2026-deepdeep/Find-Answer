import { UniqueConflict } from './errors.mjs';

export class RepositoryError extends Error {
  constructor(code) {
    super('repository operation failed');
    this.name = 'RepositoryError';
    this.code = code;
  }
}

// Unique violations surface through several shapes: a PostgREST error object
// (`error.code`), a wrapped `cause`, or only free text. None of these paths log
// or expose row values.
function hasUniqueMarker(error, depth) {
  if (!error || depth > 4) return false;
  if (typeof error === 'string') {
    return error.includes('23505')
      || error.toLowerCase().includes('duplicate key value violates unique constraint');
  }
  if (error.code === '23505' || error.code === 23505) return true;
  if (hasUniqueMarker(error.cause, depth + 1)) return true;
  if (typeof error.message === 'string') {
    return error.message.includes('23505')
      || error.message.toLowerCase().includes('duplicate key value violates unique constraint');
  }
  return false;
}

export function isUniqueViolation(error) {
  return hasUniqueMarker(error, 0);
}

export function unwrap(result) {
  if (result?.error) throw new RepositoryError(result.error.code ?? 'unknown');
  return result?.data ?? [];
}

function unwrapWrite(result) {
  if (result?.error) {
    if (isUniqueViolation(result.error)) throw new UniqueConflict();
    throw new RepositoryError(result.error.code ?? 'unknown');
  }
}

const DOCUMENT_COLUMNS = 'id,session_id,name,sha256,size,chunk_count,object_path,created_at';
const CHUNK_COLUMNS = 'chunk_key,session_id,document_id,file_name,page,chunk_index,text,embedding,norm';
const RESERVATION_COLUMNS = 'id,session_id,document_id,sha256,object_path,state,batch_id,'
  + 'ip_day,ip_hash,daily_key,created_at,updated_at,expires_at,chunk_count';

function documentRow(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    name: row.name,
    sha256: row.sha256,
    size: Number(row.size),
    chunk_count: Number(row.chunk_count),
    object_path: row.object_path,
    created_at: row.created_at,
  };
}

function reservationRow(row) {
  return {
    ...row,
    chunk_count: row.chunk_count === null ? null : Number(row.chunk_count),
  };
}

export function createRepository(db) {
  const repository = {
    // --- visitor sessions -------------------------------------------------

    async listSessions() {
      return unwrap(await db.from('visitor_sessions')
        .select('id,created_at,last_seen_at,expires_at')
        .limit(1000));
    },

    async getSession(id) {
      const rows = unwrap(await db.from('visitor_sessions')
        .select('id,created_at,last_seen_at,expires_at')
        .eq('id', id)
        .limit(1));
      return rows.length ? rows[0] : null;
    },

    async insertSession(row) {
      unwrapWrite(await db.from('visitor_sessions').insert(row));
    },

    async updateSession(id, patch) {
      const result = await db.from('visitor_sessions').update(patch).eq('id', id);
      if (result?.error) throw new RepositoryError(result.error.code ?? 'unknown');
    },

    async deleteSession(id) {
      unwrap(await db.from('visitor_sessions').delete().eq('id', id));
    },

    // --- visitor documents ------------------------------------------------

    async listDocuments(sessionId) {
      const rows = unwrap(await db.from('visitor_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(100));
      return rows.map(documentRow);
    },

    async getDocument(sessionId, id) {
      const rows = unwrap(await db.from('visitor_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('session_id', sessionId)
        .eq('id', id)
        .limit(1));
      return rows.length ? documentRow(rows[0]) : null;
    },

    async findDocumentByHash(sessionId, sha256) {
      const rows = unwrap(await db.from('visitor_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('session_id', sessionId)
        .eq('sha256', sha256)
        .limit(1));
      return rows.length ? documentRow(rows[0]) : null;
    },

    async insertDocument(document) {
      unwrapWrite(await db.from('visitor_documents').insert(document));
    },

    async deleteDocument(sessionId, id) {
      unwrap(await db.from('visitor_documents').delete()
        .eq('session_id', sessionId)
        .eq('id', id));
    },

    // Across all sessions; used only for the platform-wide chunk safety cap.
    async sumAllChunkCounts() {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(await db.from('visitor_documents')
          .select('chunk_count')
          .order('id', { ascending: true })
          .range(from, from + 999));
        rows.push(...page);
        if (page.length < 1000) break;
      }
      return rows.reduce((total, row) => total + Number(row.chunk_count), 0);
    },

    // --- visitor chunks ---------------------------------------------------

    async listChunks(sessionId, documentId) {
      return unwrap(await db.from('visitor_chunks')
        .select(CHUNK_COLUMNS)
        .eq('session_id', sessionId)
        .eq('document_id', documentId)
        .order('chunk_index', { ascending: true })
        .limit(500));
    },

    async listAllChunks(sessionId) {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(await db.from('visitor_chunks')
          .select(CHUNK_COLUMNS)
          .eq('session_id', sessionId)
          .order('chunk_key', { ascending: true })
          .range(from, from + 999));
        rows.push(...page);
        if (page.length < 1000) return rows;
      }
    },

    async insertChunks(chunks) {
      for (let start = 0; start < chunks.length; start += 100) {
        const batch = chunks.slice(start, start + 100);
        unwrapWrite(await db.from('visitor_chunks').insert(batch));
      }
    },

    async deleteChunks(sessionId, documentId) {
      unwrap(await db.from('visitor_chunks').delete()
        .eq('session_id', sessionId)
        .eq('document_id', documentId));
    },

    // --- upload reservations ---------------------------------------------

    async listReservations(sessionId) {
      const rows = unwrap(await db.from('visitor_reservations')
        .select(RESERVATION_COLUMNS)
        .eq('session_id', sessionId)
        .limit(1000));
      return rows.map(reservationRow);
    },

    async listAllReservations() {
      const rows = unwrap(await db.from('visitor_reservations')
        .select(RESERVATION_COLUMNS)
        .limit(1000));
      return rows.map(reservationRow);
    },

    async getReservation(sessionId, id) {
      const rows = unwrap(await db.from('visitor_reservations')
        .select(RESERVATION_COLUMNS)
        .eq('session_id', sessionId)
        .eq('id', id)
        .limit(1));
      return rows.length ? reservationRow(rows[0]) : null;
    },

    async insertReservation(row) {
      unwrapWrite(await db.from('visitor_reservations').insert(row));
    },

    // Compare-and-set: only a row still in one of `fromStates` is patched, so
    // concurrent reservation transitions cannot clobber each other. The
    // platform client rejects `.in`, `.lt` and mutation-side `.select()` /
    // `.maybeSingle()`, so each allowed state gets a plain conditional update
    // and the resulting row is confirmed with a separate supported read.
    async updateReservation(sessionId, id, fromStates, patch) {
      for (const fromState of fromStates) {
        const result = await db.from('visitor_reservations')
          .update(patch)
          .eq('session_id', sessionId)
          .eq('id', id)
          .eq('state', fromState);
        if (result?.error) throw new RepositoryError(result.error.code ?? 'unknown');
        const rows = unwrap(await db.from('visitor_reservations')
          .select(RESERVATION_COLUMNS)
          .eq('session_id', sessionId)
          .eq('id', id)
          .limit(1));
        const row = rows[0];
        if (row && row.state === (patch.state ?? fromState)) return reservationRow(row);
      }
      return null;
    },

    async deleteReservation(sessionId, id) {
      unwrap(await db.from('visitor_reservations').delete()
        .eq('session_id', sessionId)
        .eq('id', id));
    },

    // The platform client surface has no `lt`, so expired leases are picked out
    // in JS from the bounded reservation list; oldest first keeps recovery fair.
    async listStaleReservations(nowIso, limit = 20) {
      const active = new Set(['reserved', 'committing', 'cleaning']);
      const now = new Date(nowIso).getTime();
      const rows = await this.listAllReservations();
      return rows
        .filter((row) => active.has(row.state)
          && new Date(row.expires_at).getTime() <= now)
        .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))
        .slice(0, limit);
    },

    // --- per-IP daily ledger ---------------------------------------------

    // This ledger outlives visitor sessions on purpose: ending a session must
    // not refund the IP's daily upload allowance.
    async listDailyRows(ipDay, ipHash) {
      return unwrap(await db.from('visitor_ip_daily')
        .select('id,ip_day,ip_hash,created_at')
        .eq('ip_day', ipDay)
        .eq('ip_hash', ipHash)
        .limit(100));
    },

    async insertDailyRow(row) {
      unwrapWrite(await db.from('visitor_ip_daily').insert(row));
    },

    async deleteDailyRow(id) {
      unwrap(await db.from('visitor_ip_daily').delete().eq('id', id));
    },

    // Bounded prune: at most 50 day-keys older than the cutoff per upload.
    async pruneDailyRows(beforeDay) {
      const rows = unwrap(await db.from('visitor_ip_daily')
        .select('id,ip_day')
        .limit(1000));
      const expired = rows
        .filter((row) => String(row.ip_day) < beforeDay)
        .slice(0, 50);
      for (const row of expired) {
        unwrap(await db.from('visitor_ip_daily').delete().eq('id', row.id));
      }
    },

    // --- batch attempts ---------------------------------------------------

    async listBatchAttempts(sessionId, batchId) {
      return unwrap(await db.from('visitor_batch_attempts')
        .select('attempt_key')
        .eq('session_id', sessionId)
        .eq('batch_id', batchId)
        .limit(100));
    },

    async insertBatchAttempt(row) {
      unwrapWrite(await db.from('visitor_batch_attempts').insert(row));
    },

    async deleteBatchAttempt(sessionId, key) {
      unwrap(await db.from('visitor_batch_attempts').delete()
        .eq('session_id', sessionId)
        .eq('attempt_key', key));
    },

    // Same constraint: the cutoff is applied in JS over one bounded page, so at
    // most 100 rows are pruned per upload and the backlog drains over time.
    async deleteOldAttempts(sessionId, beforeIso) {
      const rows = unwrap(await db.from('visitor_batch_attempts')
        .select('attempt_key,created_at')
        .eq('session_id', sessionId)
        .limit(1000));
      const expired = rows
        .filter((row) => String(row.created_at) < beforeIso)
        .slice(0, 100);
      for (const row of expired) {
        unwrap(await db.from('visitor_batch_attempts').delete()
          .eq('session_id', sessionId)
          .eq('attempt_key', row.attempt_key));
      }
    },

    async deleteSessionAttempts(sessionId) {
      unwrap(await db.from('visitor_batch_attempts').delete()
        .eq('session_id', sessionId));
    },
  };

  return repository;
}
