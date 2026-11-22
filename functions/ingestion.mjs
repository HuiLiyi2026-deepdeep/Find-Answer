import { LIMITS } from './config.mjs';
import { AppError, UniqueConflict, fail } from './errors.mjs';
import { extractPages } from './extract.mjs';
import {
  chunkPages, encodeVector, extensionOf, sanitizeFileName,
  sha256Hex, validateUploadName, vectorNorm,
} from './text.mjs';

const DUPLICATE_MESSAGE = '该文件已上传，请勿重复上传。';
const EMPTY_TEXT_MESSAGE = '文件没有可提取的文本内容。';
const EMBEDDING_MESSAGE = '嵌入服务暂时不可用，请稍后重试。';
const TIMEOUT_MESSAGE = '资料处理超时，请尝试更小的文件。';
const INTERRUPTED_MESSAGE = '上传预留已失效，请重新上传。';

function contentTypeFor(extension) {
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.md' || extension === '.markdown') {
    return 'text/markdown; charset=utf-8';
  }
  return 'text/plain; charset=utf-8';
}

// A provider may resolve, reject, or return garbage. Every path collapses to
// the same sanitized 502 so no upstream body, key, or chunk text escapes.
async function embedSafely(embeddings, texts) {
  try {
    return await embeddings.embed(texts);
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('embedding_failed', EMBEDDING_MESSAGE, 502);
  }
}

// Validates a whole batch and enforces one dimension across the document.
function validateVectors(vectors, expectedCount, dimension) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    fail('embedding_failed', EMBEDDING_MESSAGE, 502);
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) {
      fail('embedding_failed', EMBEDDING_MESSAGE, 502);
    }
    if (dimension.value === null) dimension.value = vector.length;
    if (vector.length !== dimension.value) {
      fail('embedding_failed', EMBEDDING_MESSAGE, 502);
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('embedding_failed', EMBEDDING_MESSAGE, 502);
      }
    }
  }
}

export function createIngestion({
  repository,
  quota,
  storage,
  embeddings,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  limits = LIMITS,
}) {
  async function markCleaning(sessionId, reservationId) {
    await quota.markCleaning(sessionId, reservationId).catch(() => {});
  }

  // Sequential by design: the document row is the commit marker, so it must
  // disappear before its chunks and object. Any failure stops the chain and
  // leaves a `cleaning` reservation for recoverStale() to finish, rather than
  // risking a surviving marker with missing chunks.
  async function cleanup(sessionId, documentId, objectPath, reservationId, dailyKey) {
    try {
      await repository.deleteDocument(sessionId, documentId);
    } catch {
      await markCleaning(sessionId, reservationId);
      return;
    }

    try {
      await repository.deleteChunks(sessionId, documentId);
    } catch {
      await markCleaning(sessionId, reservationId);
      return;
    }

    try {
      await storage.remove([objectPath]);
    } catch {
      await markCleaning(sessionId, reservationId);
      return;
    }

    if (dailyKey) {
      try {
        await repository.deleteDailyRow(dailyKey);
      } catch {
        await markCleaning(sessionId, reservationId);
        return;
      }
    }

    try {
      await quota.release(sessionId, reservationId);
    } catch {
      await markCleaning(sessionId, reservationId);
    }
  }

  async function ingest({ sessionId, name, bytes, batchId, ipDay, ipHash }) {
    const cleanName = sanitizeFileName(name);
    if (!cleanName) fail('invalid_file_name', '文件名无效。', 400);
    validateUploadName(cleanName);
    if (!bytes.length) fail('empty_file', '文件不能为空。', 400);
    if (bytes.length > limits.maxFileBytes) {
      fail('too_large', '文件大小不能超过 20 MB。', 413);
    }
    if (!batchId || batchId.length > 128) {
      fail('invalid_batch', '批次标识无效。', 400);
    }

    await quota.recoverStale();
    await quota.recordBatchAttempt(sessionId, batchId);
    await repository
      .deleteOldAttempts(
        sessionId,
        new Date(clock().getTime() - 2 * 86400000).toISOString(),
      )
      .catch(() => {});

    const sha256 = await sha256Hex(bytes);
    if (await repository.findDocumentByHash(sessionId, sha256)) {
      fail('duplicate', DUPLICATE_MESSAGE, 409);
    }

    const documentId = randomUUID();
    const objectPath = `visitors/${sessionId}/documents/${documentId}${extensionOf(cleanName)}`;
    const reservation = await quota.reserve({
      sessionId, documentId, objectPath, sha256, batchId, ipDay, ipHash,
    });

    const deadline = clock().getTime() + limits.processingBudgetMs;
    const checkDeadline = () => {
      if (clock().getTime() > deadline) {
        fail('processing_timeout', TIMEOUT_MESSAGE, 503);
      }
    };

    try {
      await storage.upload(objectPath, bytes, {
        contentType: contentTypeFor(extensionOf(cleanName)),
        upsert: false,
      });

      const pages = await extractPages(cleanName, bytes);
      if (pages.length === 0) {
        fail('empty_text', EMPTY_TEXT_MESSAGE, 400);
      }
      const chunks = chunkPages(documentId, cleanName, pages, {
        chunkSize: limits.chunkSize,
        overlap: limits.chunkOverlap,
      });
      if (chunks.length === 0) {
        fail('empty_text', EMPTY_TEXT_MESSAGE, 400);
      }
      if (chunks.length > limits.maxChunksPerDocument) {
        fail(
          'document_too_large',
          `单个文件最多索引 ${limits.maxChunksPerDocument} 个片段，请拆分后再上传。`,
          400,
        );
      }

      const sessionDocuments = await repository.listDocuments(sessionId);
      const usedChunks = sessionDocuments.reduce(
        (total, document) => total + Number(document.chunk_count),
        0,
      );
      if (usedChunks + chunks.length > limits.sessionMaxChunks) {
        fail(
          'session_chunk_limit',
          `本次体验最多索引 ${limits.sessionMaxChunks} 个资料片段，请减少资料后再试。`,
          429,
        );
      }
      const globalChunks = await repository.sumAllChunkCounts();
      if (globalChunks + chunks.length > limits.globalMaxChunks) {
        fail('capacity_full', '体验名额已满，请稍后再试。', 429);
      }

      const dimension = { value: null };
      const rows = [];
      for (let start = 0; start < chunks.length; start += limits.embeddingBatchSize) {
        checkDeadline();
        const batch = chunks.slice(start, start + limits.embeddingBatchSize);
        const vectors = await embedSafely(embeddings, batch.map((chunk) => chunk.text));
        validateVectors(vectors, batch.length, dimension);
        batch.forEach((chunk, offset) => {
          const vector = vectors[offset];
          rows.push({
            chunk_key: chunk.id,
            session_id: sessionId,
            document_id: documentId,
            file_name: cleanName,
            page: chunk.page,
            chunk_index: chunk.chunk_index,
            text: chunk.text,
            embedding: encodeVector(vector),
            norm: String(vectorNorm(vector)),
          });
        });
        if (start + limits.embeddingBatchSize < chunks.length) {
          const alive = await quota.heartbeat(sessionId, reservation.id);
          if (!alive) {
            fail('upload_interrupted', INTERRUPTED_MESSAGE, 409);
          }
        }
      }
      checkDeadline();

      await repository.insertChunks(rows);
      const document = {
        id: documentId,
        session_id: sessionId,
        name: cleanName,
        sha256,
        size: bytes.length,
        chunk_count: chunks.length,
        object_path: objectPath,
        created_at: clock().toISOString(),
      };

      try {
        await repository.insertDocument(document);
      } catch (error) {
        if (error instanceof UniqueConflict) {
          fail('duplicate', DUPLICATE_MESSAGE, 409);
        }
        throw error;
      }

      // Re-check after commit so two parallel uploads in one session cannot
      // settle above the session caps; the loser removes only its own rows in
      // the shared catch below.
      const committedDocuments = await repository.listDocuments(sessionId);
      const committedChunks = committedDocuments.reduce(
        (total, item) => total + Number(item.chunk_count),
        0,
      );
      if (committedDocuments.length > limits.sessionMaxDocuments
        || committedChunks > limits.sessionMaxChunks) {
        fail(
          'session_limit',
          `本次体验最多添加 ${limits.sessionMaxDocuments} 份资料、索引 ${limits.sessionMaxChunks} 个片段，请减少资料后再试。`,
          429,
        );
      }

      const confirmed = await quota.confirm(sessionId, reservation.id, chunks.length);
      if (!confirmed) {
        const current = await repository.getReservation(sessionId, reservation.id);
        if (current?.state === 'confirmed') return document;
        fail('upload_interrupted', INTERRUPTED_MESSAGE, 409);
      }
      return document;
    } catch (error) {
      await cleanup(
        sessionId,
        documentId,
        objectPath,
        reservation.id,
        reservation.daily_key,
      );
      throw error;
    }
  }

  return { ingest };
}
