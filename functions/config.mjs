export const MODELS = Object.freeze({
  embeddings: 'BAAI/bge-m3',
  chat: 'deepseek-chat',
});

export const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxUploadBodyBytes: 21 * 1024 * 1024,
  maxBatchFiles: 50,
  dailyUploads: 30,
  sessionMaxDocuments: 20,
  sessionMaxChunks: 200,
  globalMaxChunks: 5000,
  maxChunksPerDocument: 500,
  chunkSize: 600,
  chunkOverlap: 80,
  defaultTopK: 5,
  scoreThreshold: 0.25,
  embeddingBatchSize: 32,
  leaseMs: 120000,
  processingBudgetMs: 50000,
  maxQuestionLength: 2000,
  maxJsonBytes: 8192,
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionTouchMs: 10 * 60 * 1000,
  sessionPurgeLimit: 3,
});
