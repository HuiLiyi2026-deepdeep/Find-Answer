import { AppError } from './errors.mjs';

function providerFailure(code, message) {
  return new AppError(code, message, 502);
}

export function createSiliconFlowEmbeddings({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 60000,
}) {
  return {
    configured: Boolean(apiKey),
    model,

    async embed(texts) {
      if (!apiKey) {
        throw new AppError(
          'embedding_not_configured',
          '共享资料库的向量服务尚未配置。',
          503,
        );
      }
      try {
        const response = await fetchImpl('https://api.siliconflow.cn/v1/embeddings', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error('upstream status');
        const payload = await response.json();
        const rows = [...payload.data].sort((left, right) => left.index - right.index);
        const indices = rows.map((row) => row.index);
        const vectors = rows.map((row) => row.embedding);
        const invalid = indices.length !== texts.length
          || indices.some((index, offset) => index !== offset)
          || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)
          || new Set(vectors.map((vector) => vector.length)).size > 1
          || vectors.some((vector) => vector.some(
            (value) => typeof value !== 'number' || !Number.isFinite(value),
          ));
        if (invalid) throw new Error('invalid response');
        return vectors;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw providerFailure('embedding_failed', '嵌入服务暂时不可用，请稍后重试。');
      }
    },
  };
}

export function createDeepSeekChat({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 90000,
}) {
  return {
    configured: Boolean(apiKey),
    model,

    async complete(messages) {
      if (!apiKey) {
        throw new AppError(
          'chat_not_configured',
          '共享资料库的回答服务尚未配置。',
          503,
        );
      }
      try {
        const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error('upstream status');
        const payload = await response.json();
        const content = payload.choices[0].message.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('empty response');
        }
        return content.trim();
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw providerFailure('chat_failed', '回答服务暂时不可用，请稍后重试。');
      }
    },
  };
}
