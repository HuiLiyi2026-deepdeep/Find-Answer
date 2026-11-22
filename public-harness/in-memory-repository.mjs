import { UniqueConflict } from '../functions/errors.mjs';

// Local stand-in for the Postgres repository. It mirrors the paging and
// compare-and-set semantics so harness tests exercise the same call shapes.
export class InMemoryRepository {
  constructor() {
    this.sessions = new Map();
    this.documents = new Map();
    this.chunks = new Map();
    this.reservations = new Map();
    this.daily = new Map();
    this.attempts = new Map();
  }

  async listSessions() {
    return [...this.sessions.values()].slice(0, 1000);
  }

  async getSession(id) { return this.sessions.get(id) ?? null; }

  async insertSession(row) {
    if (this.sessions.has(row.id)) throw new UniqueConflict();
    this.sessions.set(row.id, { ...row });
  }

  async updateSession(id, patch) {
    const row = this.sessions.get(id);
    if (row) Object.assign(row, patch);
  }

  async deleteSession(id) { this.sessions.delete(id); }

  async listDocuments(sessionId) {
    return [...this.documents.values()]
      .filter((item) => item.session_id === sessionId)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, 100);
  }

  async getDocument(sessionId, id) {
    const row = this.documents.get(id);
    return row && row.session_id === sessionId ? row : null;
  }

  async findDocumentByHash(sessionId, sha256) {
    return [...this.documents.values()]
      .find((item) => item.session_id === sessionId && item.sha256 === sha256) ?? null;
  }

  async insertDocument(document) {
    const duplicate = [...this.documents.values()]
      .some((item) => item.session_id === document.session_id
        && item.sha256 === document.sha256);
    if (duplicate) throw new UniqueConflict();
    this.documents.set(document.id, { ...document });
  }

  async deleteDocument(sessionId, id) {
    const row = this.documents.get(id);
    if (row && row.session_id === sessionId) this.documents.delete(id);
  }

  async sumAllChunkCounts() {
    return [...this.documents.values()]
      .reduce((total, document) => total + Number(document.chunk_count), 0);
  }

  async listChunks(sessionId, documentId) {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.session_id === sessionId
        && chunk.document_id === documentId)
      .sort((left, right) => left.chunk_index - right.chunk_index);
  }

  async listAllChunks(sessionId) {
    const ordered = [...this.chunks.values()]
      .filter((chunk) => chunk.session_id === sessionId)
      .sort((left, right) => String(left.chunk_key).localeCompare(String(right.chunk_key)));
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = ordered.slice(from, from + 1000);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  async insertChunks(chunks) {
    for (const chunk of chunks) {
      if (this.chunks.has(chunk.chunk_key)) throw new UniqueConflict();
    }
    for (const chunk of chunks) this.chunks.set(chunk.chunk_key, { ...chunk });
  }

  async deleteChunks(sessionId, documentId) {
    for (const [key, chunk] of this.chunks) {
      if (chunk.session_id === sessionId && chunk.document_id === documentId) {
        this.chunks.delete(key);
      }
    }
  }

  async listReservations(sessionId) {
    return [...this.reservations.values()]
      .filter((item) => item.session_id === sessionId);
  }

  async listAllReservations() { return [...this.reservations.values()]; }

  async getReservation(sessionId, id) {
    const row = this.reservations.get(id);
    return row && row.session_id === sessionId ? row : null;
  }

  async insertReservation(row) {
    if (this.reservations.has(row.id)) throw new UniqueConflict();
    this.reservations.set(row.id, { ...row });
  }

  async updateReservation(sessionId, id, fromStates, patch) {
    const row = this.reservations.get(id);
    if (!row || row.session_id !== sessionId) return null;
    if (!fromStates.includes(row.state)) return null;
    Object.assign(row, patch);
    return { ...row };
  }

  async deleteReservation(sessionId, id) {
    const row = this.reservations.get(id);
    if (row && row.session_id === sessionId) this.reservations.delete(id);
  }

  async listStaleReservations(nowIso, limit = 20) {
    const now = new Date(nowIso).getTime();
    return [...this.reservations.values()]
      .filter((row) => ['reserved', 'committing', 'cleaning'].includes(row.state))
      .filter((row) => new Date(row.expires_at).getTime() <= now)
      .sort((left, right) => new Date(left.expires_at) - new Date(right.expires_at))
      .slice(0, limit);
  }

  async listDailyRows(ipDay, ipHash) {
    return [...this.daily.values()]
      .filter((row) => row.ip_day === ipDay && row.ip_hash === ipHash)
      .slice(0, 100);
  }

  async insertDailyRow(row) {
    if (this.daily.has(row.id)) throw new UniqueConflict();
    this.daily.set(row.id, { ...row });
  }

  async deleteDailyRow(id) { this.daily.delete(id); }

  async pruneDailyRows(beforeDay) {
    for (const [id, row] of this.daily) {
      if (row.ip_day < beforeDay) this.daily.delete(id);
    }
  }

  async listBatchAttempts(sessionId, batchId) {
    return [...this.attempts.values()]
      .filter((item) => item.session_id === sessionId && item.batch_id === batchId)
      .slice(0, 100);
  }

  async insertBatchAttempt(row) { this.attempts.set(row.attempt_key, { ...row }); }

  async deleteBatchAttempt(sessionId, key) {
    const row = this.attempts.get(key);
    if (row && row.session_id === sessionId) this.attempts.delete(key);
  }

  async deleteOldAttempts(sessionId, beforeIso) {
    for (const [key, attempt] of this.attempts) {
      if (attempt.session_id === sessionId && attempt.created_at < beforeIso) {
        this.attempts.delete(key);
      }
    }
  }

  async deleteSessionAttempts(sessionId) {
    for (const [key, attempt] of this.attempts) {
      if (attempt.session_id === sessionId) this.attempts.delete(key);
    }
  }
}
