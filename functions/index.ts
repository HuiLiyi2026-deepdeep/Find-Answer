import {
  createDatabaseClient,
  createSiteContext,
  errorResponse,
} from './_qoder/backend.mjs';
import { createStorageClient } from './_qoder/storage.mjs';
import { LIMITS, MODELS } from './config.mjs';
import { createDeepSeekChat, createSiliconFlowEmbeddings } from './providers.mjs';
import { createRepository } from './repository.mjs';
import { application } from './routes.mjs';
import { createService } from './service.mjs';

const repository = createRepository(createDatabaseClient());
const storage = createStorageClient();
const embeddings = createSiliconFlowEmbeddings({
  apiKey: (Deno.env.get('SILICONFLOW_API_KEY') ?? '').trim(),
  model: MODELS.embeddings,
});
const chat = createDeepSeekChat({
  apiKey: (Deno.env.get('DEEPSEEK_API_KEY') ?? '').trim(),
  model: MODELS.chat,
});
const service = createService({
  repository,
  storage,
  embeddings,
  chat,
  limits: LIMITS,
});
const handle = application({ service, limits: LIMITS });

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
