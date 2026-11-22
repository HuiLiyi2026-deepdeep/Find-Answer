import { LIMITS } from './config.mjs';
import { AppError } from './errors.mjs';
import { createIngestion } from './ingestion.mjs';
import { createQuota } from './quota.mjs';
import { createRag } from './rag.mjs';
import { createSessions } from './sessions.mjs';
import { dayKey, hashIp } from './client-ip.mjs';

export function createService({
  repository,
  storage,
  embeddings,
  chat,
  clock = () => new Date(),
  limits = LIMITS,
}) {
  const quota = createQuota({ repository, storage, clock, limits });
  const sessions = createSessions({ repository, storage, clock, limits });
  const rag = createRag({
    repository,
    embeddings,
    chat,
    defaultTopK: limits.defaultTopK,
    scoreThreshold: limits.scoreThreshold,
  });
  const ingestion = createIngestion({
    repository,
    quota,
    storage,
    embeddings,
    clock,
    limits,
  });

  async function health({ sessionId, clientIp }) {
    const documents = await repository.listDocuments(sessionId);
    const chunks = documents.reduce(
      (total, document) => total + Number(document.chunk_count), 0,
    );
    const day = dayKey(clock());
    const ipHash = clientIp ? await hashIp(clientIp.ip) : null;
    const dailyUsed = ipHash
      ? (await repository.listDailyRows(day, ipHash)).length
      : 0;

    let blocked = null;
    if (!clientIp) blocked = '无法确认客户端 IP，暂时不能上传。';
    else if (!embeddings.configured) blocked = '向量服务尚未配置，暂时不能上传。';
    else if (documents.length >= limits.sessionMaxDocuments) {
      blocked = `本次体验已达 ${limits.sessionMaxDocuments} 份资料上限，可结束体验后重新开始。`;
    } else if (chunks >= limits.sessionMaxChunks) {
      blocked = `本次体验已达 ${limits.sessionMaxChunks} 个片段上限，可结束体验后重新开始。`;
    } else if (dailyUsed >= limits.dailyUploads) {
      blocked = '今日体验上传额度已用完，请明天再试。';
    }

    return {
      status: 'ok',
      mode: 'public',
      capabilities: {
        upload: blocked === null,
        delete: false,
        manage_connections: false,
      },
      upload_blocked_reason: blocked,
      trusted_ip: Boolean(clientIp),
      siliconflow_configured: embeddings.configured,
      deepseek_configured: chat.configured,
      models: {
        embeddings: embeddings.model,
        chat: chat.model,
      },
      document_count: documents.length,
      quota: {
        scope: 'session',
        documents_used: documents.length,
        documents_limit: limits.sessionMaxDocuments,
        chunks_used: chunks,
        chunks_limit: limits.sessionMaxChunks,
        daily_uploads_used: dailyUsed,
        daily_upload_limit: limits.dailyUploads,
        daily_uploads_remaining: Math.max(0, limits.dailyUploads - dailyUsed),
        batch_limit: limits.maxBatchFiles,
      },
    };
  }

  async function listDocuments(sessionId) {
    return { documents: await repository.listDocuments(sessionId) };
  }

  async function getChunks(sessionId, documentId) {
    if (!(await repository.getDocument(sessionId, documentId))) {
      throw new AppError('not_found', '资料不存在。', 404);
    }
    return {
      document_id: documentId,
      chunks: (await repository.listChunks(sessionId, documentId)).map((chunk) => ({
        id: chunk.chunk_key,
        document_id: chunk.document_id,
        file_name: chunk.file_name,
        page: chunk.page,
        chunk_index: chunk.chunk_index,
        text: chunk.text,
      })),
    };
  }

  async function ingest({ sessionId, name, bytes, batchId, clientIp }) {
    if (!clientIp) {
      throw new AppError(
        'upload_unavailable',
        '无法确认客户端 IP，暂时不能上传。',
        403,
      );
    }
    const ipHash = await hashIp(clientIp.ip);
    return ingestion.ingest({
      sessionId,
      name,
      bytes,
      batchId,
      ipDay: dayKey(clock()),
      ipHash,
    });
  }

  function connectionsStatus() {
    return {
      mode: 'public',
      manage_connections: false,
      note: 'API 为发布者个人 API，密钥保存在服务端，访客无法查看或修改。',
      providers: [
        {
          provider: 'siliconflow',
          role: 'embedding',
          label: '硅基流动',
          model: embeddings.model,
          configured: embeddings.configured,
        },
        {
          provider: 'deepseek',
          role: 'chat',
          label: 'DeepSeek',
          model: chat.model,
          configured: chat.configured,
        },
      ],
    };
  }

  return {
    createSession: () => sessions.create(),
    resolveSession: (sessionId) => sessions.resolve(sessionId),
    endSession: (sessionId) => sessions.end(sessionId),
    purgeExpiredSessions: (limit) => sessions.purgeExpired(limit),
    health,
    listDocuments,
    getChunks,
    ingest,
    retrieve: (sessionId, question, topK) => rag.retrieve(sessionId, question, topK),
    ask: (sessionId, question, topK) => rag.ask(sessionId, question, topK),
    connectionsStatus,
  };
}
