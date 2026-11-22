import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPages } from '../../functions/extract.mjs';
import { makeTextPdf } from '../fixtures/make-pdf.mjs';

test('extracts page text from a textual PDF', async () => {
  const pages = await extractPages('fixture.pdf', makeTextPdf('FindAnswer public PDF fixture'));
  assert.equal(pages.length, 1);
  assert.equal(pages[0][0], 1);
  assert.match(pages[0][1], /FindAnswer public PDF fixture/);
});

test('extracts UTF-8 text and rejects invalid bytes', async () => {
  const pages = await extractPages('notes.md', new TextEncoder().encode('第一段\n\n第二段'));
  assert.deepEqual(pages, [[null, '第一段\n\n第二段']]);
  await assert.rejects(
    () => extractPages('notes.txt', new Uint8Array([0xff, 0xfe, 0x00])),
    (error) => error.code === 'invalid_encoding',
  );
});

test('rejects a corrupt PDF with a safe message', async () => {
  await assert.rejects(
    () => extractPages('broken.pdf', new TextEncoder().encode('not a pdf')),
    (error) => error.code === 'invalid_pdf'
      && error.message === 'PDF 无法解析，请上传包含可选文字的有效 PDF。',
  );
});
