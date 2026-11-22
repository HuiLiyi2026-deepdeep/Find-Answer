import { AppError } from '../functions/errors.mjs';

export class FakeStorage {
  constructor() { this.files = new Map(); }
  async upload(path, bytes) { this.files.set(path, bytes); }
  async download(path) {
    if (!this.files.has(path)) throw new AppError('not_found', '文件不存在。', 404);
    return new Response(this.files.get(path));
  }
  async remove(paths) { for (const path of paths) this.files.delete(path); }
}

function vectorFor(text) {
  const vector = new Float64Array(64);
  const value = String(text).toLowerCase();
  for (let index = 0; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index) + value.charCodeAt(index + 1) * 7;
    vector[code % vector.length] += 1;
  }
  const norm = Math.hypot(...vector);
  return norm ? [...vector].map((item) => item / norm) : [...vector];
}

export class FakeEmbeddings {
  constructor() { this.configured = true; this.model = 'fake-embedding'; }
  async embed(texts) { return texts.map(vectorFor); }
}

export class FakeChat {
  constructor() { this.configured = true; this.model = 'fake-chat'; }
  async complete() { return '根据共享资料，可以这样回答。[1]'; }
}
