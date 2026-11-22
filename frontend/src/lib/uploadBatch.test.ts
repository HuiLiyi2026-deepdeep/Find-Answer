import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { DocumentRecord } from './types';
import type { UploadCandidate } from './fileSelection';
import { uploadBatch } from './uploadBatch';

const candidates: UploadCandidate[] = ['a.txt', 'b.txt', 'c.txt'].map((name) => ({
  file: new File([name], name),
  path: `folder/${name}`,
}));

function document(name: string): DocumentRecord {
  return {
    id: name, name, sha256: name, size: 1, chunk_count: 1,
    created_at: '2026-10-30T00:00:00Z',
  };
}

describe('uploadBatch', () => {
  it('runs sequentially, reports one-based progress and shares one batch ID', async () => {
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const progress: string[] = [];
    const results = await uploadBatch(candidates, (item) => {
      if (item.progress === 0) progress.push(`${item.index}/${item.total}:${item.path}`);
    }, async (file, onProgress, batchId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(`${file.name}:${batchId}`);
      onProgress(50);
      await Promise.resolve();
      active -= 1;
      return document(file.name);
    }, 'batch-test');

    expect(maximumActive).toBe(1);
    expect(calls).toEqual(['a.txt:batch-test', 'b.txt:batch-test', 'c.txt:batch-test']);
    expect(progress).toEqual(['1/3:folder/a.txt', '2/3:folder/b.txt', '3/3:folder/c.txt']);
    expect(results.every((item) => item.status === 'success')).toBe(true);
  });

  it('classifies duplicates and continues after failure', async () => {
    const results = await uploadBatch(candidates, () => {}, async (file) => {
      if (file.name === 'a.txt') throw new ApiError('重复', 409);
      if (file.name === 'b.txt') throw new ApiError('索引失败', 502);
      return document(file.name);
    }, 'batch-test');

    expect(results.map((item) => item.status)).toEqual(['duplicate', 'failed', 'success']);
    expect(results[1]).toEqual({ path: 'folder/b.txt', status: 'failed', reason: '索引失败' });
  });

  it('stops at a terminal quota error and leaves later files unsent', async () => {
    const calls: string[] = [];
    const results = await uploadBatch(candidates, () => {}, async (file) => {
      calls.push(file.name);
      if (file.name === 'a.txt') {
        throw new ApiError('今日共享上传额度已用完。', 429, 'daily_limit');
      }
      return document(file.name);
    }, 'batch-test');

    expect(calls).toEqual(['a.txt']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: 'folder/a.txt', status: 'failed', terminal: true,
    });
  });

  it('stops the batch when the session cannot be renewed', async () => {
    const calls: string[] = [];
    const results = await uploadBatch(candidates, () => {}, async (file) => {
      calls.push(file.name);
      throw new ApiError('体验会话已过期，请刷新页面重新开始。', 401, 'session_expired');
    }, 'batch-test');

    expect(calls).toEqual(['a.txt']);
    expect(results[0]).toMatchObject({ status: 'failed', terminal: true });
  });
});
