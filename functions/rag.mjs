import { LIMITS } from './config.mjs';
import { AppError } from './errors.mjs';
import { decodeVector, vectorNorm } from './text.mjs';

export const NO_RETRIEVAL_ANSWER = '你提供的资料中没有这个问题的答案。';
export const INSUFFICIENT_EVIDENCE_ANSWER = '根据你提供的资料，我无法回答这个问题。';

// A query vector that cannot be compared with stored chunk vectors is an
// upstream failure. The message is fixed so provider bodies and keys can never
// reach the caller through this path.
function embeddingFailure() {
  return new AppError('embedding_failed', '嵌入服务暂时不可用，请稍后重试。', 502);
}

function assertQueryVector(vector) {
  const usable = Array.isArray(vector) || vector instanceof Float32Array;
  if (!usable || vector.length === 0) throw embeddingFailure();
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw embeddingFailure();
    }
  }
}

function refusal(retrieval, answer) {
  return {
    status: 'no_answer',
    answer,
    citations: [],
    retrieval,
  };
}

export function createRag({
  repository,
  embeddings,
  chat,
  defaultTopK = LIMITS.defaultTopK,
  scoreThreshold = LIMITS.scoreThreshold,
}) {
  async function retrieve(sessionId, question, topK = defaultTopK) {
    const cleanQuestion = question.trim();
    const chunks = await repository.listAllChunks(sessionId);
    if (chunks.length === 0) {
      return {
        question: cleanQuestion,
        top_k: topK,
        score_threshold: scoreThreshold,
        hits: [],
        count: 0,
      };
    }

    const [queryVector] = await embeddings.embed([cleanQuestion]);
    assertQueryVector(queryVector);
    const queryNorm = vectorNorm(queryVector);
    const scored = chunks.map((chunk) => {
      const vector = decodeVector(chunk.embedding);
      if (vector.length !== queryVector.length) throw embeddingFailure();
      // The norm is recomputed from the decoded vector. The stored `norm` column
      // is still written at ingestion but never read here: a corrupt or
      // malicious value could otherwise inflate a cosine past the threshold and
      // turn weak evidence into a citation.
      const norm = vectorNorm(vector);
      let dot = 0;
      for (let index = 0; index < vector.length; index += 1) {
        dot += queryVector[index] * vector[index];
      }
      const denominator = queryNorm * norm;
      return {
        id: chunk.chunk_key,
        document_id: chunk.document_id,
        file_name: chunk.file_name,
        page: chunk.page,
        chunk_index: chunk.chunk_index,
        text: chunk.text,
        score: denominator > 0 ? dot / denominator : -1,
      };
    });

    scored.sort((left, right) => right.score - left.score);
    const hits = scored
      .slice(0, topK)
      .filter((hit) => hit.score >= scoreThreshold);
    return {
      question: cleanQuestion,
      top_k: topK,
      score_threshold: scoreThreshold,
      hits,
      count: hits.length,
    };
  }

  async function ask(sessionId, question, topK = defaultTopK) {
    const retrieval = await retrieve(sessionId, question, topK);
    const evidence = retrieval.hits;
    if (evidence.length === 0) {
      return refusal(retrieval, NO_RETRIEVAL_ANSWER);
    }

    const numbered = evidence
      .map((chunk, index) => `[${index + 1}] ${chunk.text}`)
      .join('\n\n');
    const messages = [
      {
        role: 'system',
        content: '你是严格的资料问答助手。只能根据用户提供的编号资料片段回答，'
          + '不得使用常识或资料之外的信息。回答时使用资料编号标注引用，'
          + '格式为 [1]、[2]，引用之外不要使用方括号或【】。'
          + '如果资料不足以回答，只输出 NO_ANSWER，不要输出任何其他内容。',
      },
      {
        role: 'user',
        content: `问题：${retrieval.question}\n\n编号资料片段：\n${numbered}`,
      },
    ];
    const answer = (await chat.complete(messages)).trim();
    if (answer.includes('NO_ANSWER')) {
      return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
    }

    const citedNumbers = [];
    let sawMarker = false;
    // Every bracket group must be a valid, in-range citation number. A valid
    // citation cannot rescue an answer that also carries a malformed marker.
    for (const match of answer.matchAll(/\[([^\]]*)\]|【([^】]*)】/g)) {
      const raw = match[1] ?? match[2] ?? '';
      if (!/^\d+$/.test(raw)) {
        return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
      }
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1 || number > evidence.length) {
        return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
      }
      sawMarker = true;
      if (!citedNumbers.includes(number)) citedNumbers.push(number);
    }
    if (!sawMarker) {
      return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
    }

    return {
      status: 'answered',
      answer,
      citations: citedNumbers.map((number) => {
        const chunk = evidence[number - 1];
        return {
          number,
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          file_name: chunk.file_name,
          page: chunk.page,
          chunk_index: chunk.chunk_index,
          text: chunk.text,
        };
      }),
      retrieval,
    };
  }

  return { retrieve, ask };
}
