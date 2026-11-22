import { LIMITS } from './config.mjs';
import { AppError, fail } from './errors.mjs';
import { trustedClientIp } from './client-ip.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_HEADER = 'x-findanswer-session';

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function methodNotAllowed(allowed) {
  const response = json({ detail: '请求方法不被允许。', code: 'method_not_allowed' }, 405);
  response.headers.set('allow', allowed.join(', '));
  return response;
}

async function readLimited(request, maxBytes) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    fail('payload_too_large', '请求内容过大。', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) fail('invalid_input', '缺少请求内容。', 400);
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        fail('payload_too_large', '请求内容过大。', 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function jsonInput(request, limits) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    fail('invalid_input', '请求必须使用 JSON。', 400);
  }
  const bytes = await readLimited(request, limits.maxJsonBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('invalid_input', '请求内容无法解析。', 400);
  }
}

function questionInput(body, limits) {
  if (!body || typeof body !== 'object') {
    fail('invalid_input', '请输入问题。', 400);
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) fail('invalid_input', '请输入问题。', 400);
  if (question.length > limits.maxQuestionLength) {
    fail('invalid_input', '问题不能超过 2000 个字符。', 400);
  }
  const topK = body.top_k === undefined || body.top_k === null
    ? limits.defaultTopK
    : body.top_k;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    fail('invalid_input', '检索数量必须在 1 到 50 之间。', 400);
  }
  return { question, topK };
}

async function uploadInput(request, limits) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    fail('invalid_input', '请使用文件上传表单。', 415);
  }
  const body = await readLimited(request, limits.maxUploadBodyBytes);
  let form;
  try {
    form = await new Response(body, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    fail('invalid_input', '上传表单无法解析。', 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    fail('invalid_input', '请选择要上传的文件。', 400);
  }
  if (file.size > limits.maxFileBytes) {
    fail('too_large', '文件大小不能超过 20 MB。', 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) fail('empty_file', '文件不能为空。', 400);

  const rawBatch = form.get('batch_id');
  if (rawBatch === null) {
    return { name: file.name, bytes, batchId: crypto.randomUUID() };
  }
  if (typeof rawBatch !== 'string' || rawBatch.length < 1 || rawBatch.length > 128) {
    fail('invalid_batch', '批次标识无效。', 400);
  }
  return { name: file.name, bytes, batchId: rawBatch };
}

export function application({ service, clock = () => new Date(), limits = LIMITS }) {
  async function requireSession(request) {
    const sessionId = request.headers.get(SESSION_HEADER);
    await service.resolveSession(sessionId);
    return sessionId;
  }

  return async function handle(ctx) {
    try {
      const request = ctx.request;
      const pathname = new URL(request.url).pathname;
      const match = pathname.match(
        /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/,
      );
      if (!match) fail('not_found', '接口不存在。', 404);
      const path = match[1] || '/';
      const method = request.method;

      if (path === '/api/sessions') {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        return json(await service.createSession(), 201);
      }

      if (path === '/api/session') {
        if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
        const sessionId = await requireSession(request);
        return json(await service.endSession(sessionId));
      }

      if (path === '/api/health') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        const sessionId = await requireSession(request);
        return json(await service.health({
          sessionId,
          clientIp: trustedClientIp(request),
        }));
      }

      if (path === '/api/documents') {
        if (method === 'GET') {
          return json(await service.listDocuments(await requireSession(request)));
        }
        if (method !== 'POST') return methodNotAllowed(['GET', 'POST']);
        const sessionId = await requireSession(request);
        const clientIp = trustedClientIp(request);
        if (!clientIp) {
          fail('upload_unavailable', '无法确认客户端 IP，暂时不能上传。', 403);
        }
        const upload = await uploadInput(request, limits);
        const document = await service.ingest({ ...upload, sessionId, clientIp });
        return json(document, 201);
      }

      const chunksPath = path.match(/^\/api\/documents\/([^/]+)\/chunks$/);
      if (chunksPath) {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        if (!UUID.test(chunksPath[1])) fail('not_found', '资料不存在。', 404);
        const sessionId = await requireSession(request);
        return json(await service.getChunks(sessionId, chunksPath[1]));
      }

      if (/^\/api\/documents\/[^/]+$/.test(path)) {
        if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
        fail(
          'forbidden',
          '公开体验版不允许单独删除资料，可使用“结束体验并清空”。',
          403,
        );
      }

      if (path === '/api/search' || path === '/api/ask') {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        const sessionId = await requireSession(request);
        const { question, topK } = questionInput(
          await jsonInput(request, limits),
          limits,
        );
        const result = path === '/api/search'
          ? await service.retrieve(sessionId, question, topK)
          : await service.ask(sessionId, question, topK);
        return json(result);
      }

      if (path === '/api/connections/status') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        return json(service.connectionsStatus());
      }

      if (path === '/api/connections/siliconflow' || path === '/api/connections/deepseek') {
        if (method !== 'PUT') return methodNotAllowed(['PUT']);
        fail('forbidden', '公开版不允许修改模型连接。', 403);
      }

      if (path.startsWith('/api/connections/')) {
        if (method === 'PUT') fail('forbidden', '公开版不允许修改模型连接。', 403);
        return methodNotAllowed(['PUT']);
      }

      fail('not_found', '接口不存在。', 404);
    } catch (error) {
      if (error instanceof AppError) return error.toResponse();
      console.error('findanswer_request_failed', {
        requestId: ctx.requestId ?? null,
        name: error instanceof Error ? error.name : 'unknown',
      });
      return json({ detail: '服务暂时不可用，请稍后重试。', code: 'internal_error' }, 500);
    }
  };
}
