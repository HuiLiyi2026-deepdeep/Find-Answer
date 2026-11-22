import {
  definePDFJSModule,
  extractText,
  getDocumentProxy,
} from './vendor/unpdf/dist/index.mjs';
import { AppError } from './errors.mjs';

// The vendored package normally resolves its PDF.js build through the
// `unpdf/pdfjs` bare specifier, which only exists under node_modules. Point it
// at the vendored copy so no install step is required at runtime.
definePDFJSModule(() => import('./vendor/unpdf/dist/pdfjs.mjs'));

export async function extractPdfPages(bytes) {
  try {
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(document, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    return pages
      .map((text, index) => [index + 1, String(text ?? '').trim()])
      .filter(([, text]) => text.length > 0);
  } catch {
    throw new AppError(
      'invalid_pdf',
      'PDF 无法解析，请上传包含可选文字的有效 PDF。',
      400,
    );
  }
}
