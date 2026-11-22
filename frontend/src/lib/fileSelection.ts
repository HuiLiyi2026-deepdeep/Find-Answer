export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_BATCH_FILES = 100;

export interface UploadCandidate {
  file: File;
  path: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PreparedUpload {
  files: UploadCandidate[];
  skipped: SkippedFile[];
  unprocessed: SkippedFile[];
}

export function prepareUpload(files: File[]): PreparedUpload {
  const skipped: SkippedFile[] = [];
  const eligible: UploadCandidate[] = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!/\.(txt|md|markdown|pdf)$/i.test(file.name)) {
      skipped.push({ path, reason: '不支持的文件格式' });
    } else if (file.size > MAX_FILE_SIZE) {
      skipped.push({ path, reason: '文件超过 20 MiB' });
    } else {
      eligible.push({ file, path });
    }
  }
  eligible.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    files: eligible.slice(0, MAX_BATCH_FILES),
    skipped,
    unprocessed: eligible.slice(MAX_BATCH_FILES).map(({ path }) => ({
      path,
      reason: '超过单批 100 个文件上限',
    })),
  };
}
