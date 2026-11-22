import { describe, expect, it } from 'vitest';
import { prepareUpload } from './fileSelection';

function file(name: string, path = '', size = 1): File {
  const value = new File(['x'], name);
  Object.defineProperty(value, 'size', { value: size });
  Object.defineProperty(value, 'webkitRelativePath', { value: path });
  return value;
}

describe('prepareUpload', () => {
  it('filters mixed files, keeps relative paths and sorts eligible files', () => {
    const result = prepareUpload([
      file('b.txt', 'folder/b.txt'),
      file('image.png', 'folder/image.png'),
      file('a.MD', 'folder/nested/a.MD'),
      file('large.pdf', 'folder/large.pdf', 20 * 1024 * 1024 + 1),
    ]);

    expect(result.files.map((item) => item.path)).toEqual([
      'folder/b.txt',
      'folder/nested/a.MD',
    ]);
    expect(result.skipped.map((item) => item.path)).toEqual([
      'folder/image.png',
      'folder/large.pdf',
    ]);
  });

  it('selects only the first 100 eligible files and labels the rest unprocessed', () => {
    const input = Array.from({ length: 101 }, (_, index) =>
      file(`${String(index).padStart(3, '0')}.txt`, `folder/${String(index).padStart(3, '0')}.txt`));
    const result = prepareUpload(input);

    expect(result.files).toHaveLength(100);
    expect(result.unprocessed).toHaveLength(1);
    expect(result.unprocessed[0]).toEqual({
      path: 'folder/100.txt',
      reason: '超过单批 100 个文件上限',
    });
  });
});
