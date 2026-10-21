const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_TEXT_CHARS = 1_000_000;
const MAX_PLAIN_BYTES = 5 * 1024 * 1024;
const PLAIN_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.log', '.ini', '.yml', '.yaml']);
const MARKUP_EXTENSIONS = new Set(['.html', '.htm', '.svg']);

// Returns the searchable text of a stored file, or '' when the type is unsupported or parsing fails.
async function extractText(filePath, mimeType, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  try {
    let text = '';
    if (mimeType === 'application/pdf' || ext === '.pdf') text = await extractPdf(filePath);
    else if (ext === '.docx') text = (await require('mammoth').extractRawText({ path: filePath })).value;
    else if (MARKUP_EXTENSIONS.has(ext) || mimeType === 'text/html') text = stripMarkup(await readPlain(filePath));
    else if (PLAIN_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) text = await readPlain(filePath);
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  } catch (err) {
    console.warn(`Extraction de texte impossible pour ${originalName} : ${err.message}`);
    return '';
  }
}

async function extractPdf(filePath) {
  const { getDocumentProxy, extractText: pdfText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(filePath)), { verbosity: 0 });
  const { text } = await pdfText(pdf, { mergePages: true });
  return text;
}

async function readPlain(filePath) {
  const handle = await fs.open(filePath);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MAX_PLAIN_BYTES), 0, MAX_PLAIN_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function stripMarkup(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

module.exports = { extractText };
