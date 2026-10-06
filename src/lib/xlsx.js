import { strFromU8, unzipSync } from 'fflate';

// Minimal .xlsx reader: returns the first worksheet as a grid of strings. Enough for a rota
// (text cells, numbers), without pulling a full spreadsheet library into the Forge bundle.

function decodeXml(text = '') {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Joins every <t> run inside a fragment (plain and rich-text strings), skipping phonetic hints.
function textRuns(fragment = '') {
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function firstSheetPath(files) {
  const workbook = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  const relId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = relId ? new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
    || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${relId}"`).exec(rels)?.[1] : null;
  if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  return Object.keys(files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
}

export function readFirstSheet(bytes) {
  let files;
  try { files = unzipSync(bytes); } catch { throw new Error('That file is not a valid .xlsx spreadsheet.'); }
  const sheetPath = firstSheetPath(files);
  if (!sheetPath || !files[sheetPath]) throw new Error('No worksheet found in the spreadsheet.');

  const shared = files['xl/sharedStrings.xml']
    ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textRuns(m[1]))
    : [];

  const grid = [];
  const sheet = strFromU8(files[sheetPath]);
  for (const cell of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cell[1];
    const body = cell[2] || '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
    const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    let value = '';
    if (type === 's') value = shared[Number(raw)] ?? '';
    else if (type === 'inlineStr') value = textRuns(body);
    else if (raw != null) value = decodeXml(raw);
    const row = Number(/\d+$/.exec(ref)[0]) - 1;
    (grid[row] ||= [])[columnIndex(ref)] = value;
  }
  return Array.from(grid, row => Array.from(row || [], v => v ?? ''));
}

// Cells pasted from Excel arrive tab-separated; also accept simple CSV.
export function readDelimitedText(text = '') {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const delimiter = lines.some(line => line.includes('\t')) ? '\t' : ',';
  return lines.map(line => {
    if (delimiter === '\t') return line.split('\t');
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(current); current = ''; }
      else current += ch;
    }
    cells.push(current);
    return cells;
  });
}

// FilePicker hands over base64, sometimes as a data: URL.
export function decodeBase64File(data = '') {
  const base64 = String(data).replace(/^data:[^,]*,/, '');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
