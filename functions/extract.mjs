import { extractPdfPages } from './pdf.mjs';
import { decodeUtf8, extensionOf } from './text.mjs';

export async function extractPages(name, bytes) {
  if (extensionOf(name) === '.pdf') return extractPdfPages(bytes);
  const text = decodeUtf8(bytes);
  return text ? [[null, text]] : [];
}
