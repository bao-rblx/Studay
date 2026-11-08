// Builds tiny Office files in memory (a ZIP of XML parts), so tests never need a binary
// fixture and stay readable: what the extractor sees is described right in the test.
const zlib = require('node:zlib');

// Minimal ZIP writer: deflate for everything, every header field written by hand.
// `fakeUncompressed` overrides the size declared in the headers (the zip-bomb case).
function writeZip(entries, { fakeUncompressed = {} } = {}) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store ? raw : zlib.deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const declared = fakeUncompressed[entry.name] ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // entry names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

function docx(body, extra = []) {
  return writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<w:document><w:body>${body}</w:body></w:document>` },
    ...extra,
  ]);
}

const slide = (text) => `<p:sld><p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`;
const notes = (text) => `<p:notes><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:notes>`;

// A one-sheet workbook: column A from shared strings, column B inline, column C a number.
function xlsx({ shared = ['Name'], rows = [] } = {}) {
  const sharedXml = shared.map((text) => `<si><t>${text}</t></si>`).join('');
  const rowXml = rows.map((cells, r) => {
    const ref = r + 1;
    const cols = cells.map((cell, c) => {
      const at = `${String.fromCharCode(65 + c)}${ref}`;
      if (cell && typeof cell === 'object' && cell.shared !== undefined) {
        return `<c r="${at}" t="s"><v>${cell.shared}</v></c>`;
      }
      if (cell && typeof cell === 'object' && cell.inline !== undefined) {
        return `<c r="${at}" t="inlineStr"><is><t>${cell.inline}</t></is></c>`;
      }
      return `<c r="${at}"><v>${cell}</v></c>`;
    }).join('');
    return `<row r="${ref}">${cols}</row>`;
  }).join('');
  return writeZip([
    { name: 'xl/sharedStrings.xml', data: `<sst>${sharedXml}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${rowXml}</sheetData></worksheet>` },
  ]);
}

module.exports = { writeZip, docx, para, slide, notes, xlsx };
