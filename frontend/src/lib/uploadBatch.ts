import { ApiError, uploadDocument } from './api';
import type { UploadCandidate } from './fileSelection';
import type { DocumentRecord } from './types';

export interface BatchProgress {
  index: number;
  total: number;
  path: string;
  progress: number;
}

export type BatchItemResult =
  | { path: string; status: 'success'; document: DocumentRecord }
  | { path: string; status: 'duplicate'; reason: string }
  | { path: string; status: 'failed'; reason: string; terminal?: true };

export type UploadOne = (
  file: File,
  onProgress: (percentage: number) => void,
  batchId?: string,
) => Promise<DocumentRecord>;

export function isTerminalUploadError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 429 || error.code === 'batch_limit' || error.code === 'session_expired');
}

export async function uploadBatch(
  files: UploadCandidate[],
  onProgress: (progress: BatchProgress) => void,
  uploadOne: UploadOne = uploadDocument,
  batchId: string = crypto.randomUUID(),
  shouldStop: (error: unknown) => boolean = isTerminalUploadError,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  for (const [offset, item] of files.entries()) {
    const index = offset + 1;
    const report = (progress: number) => onProgress({
      index, total: files.length, path: item.path, progress,
    });
    report(0);
    try {
      const document = await uploadOne(item.file, report, batchId);
      results.push({ path: item.path, status: 'success', document });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '上传未完成，请稍后重试。';
      const terminal = shouldStop(error);
      results.push({
        path: item.path,
        status: error instanceof ApiError && error.status === 409 ? 'duplicate' : 'failed',
        reason,
        ...(terminal ? { terminal: true as const } : {}),
      });
      if (terminal) break;
    }
  }
  return results;
}
