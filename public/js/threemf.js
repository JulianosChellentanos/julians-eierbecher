// OVJU — 3MF-Export (Mehrfarbdruck): ein Objekt mit mehreren Teilen, je Teil ein Filament/Extruder.
// Bambu Studio / OrcaSlicer lesen die Teilezuordnung aus Metadata/model_settings.config.
// Reines JS: ZIP-Writer (Deflate über CompressionStream im Browser, zlib in Node), XML-Mesh-Export.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// CRC32 (ZIP)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/**
 * Deflate-Raw für eine Folge von Byte-Chunks (streamend, speicherschonend):
 * Browser: CompressionStream; Node: zlib-Stream; Fallback: unkomprimiert.
 */
async function deflateChunks(chunks) {
  try {
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      const done = new Response(cs.readable).arrayBuffer();
      for (const c of chunks) await writer.write(c);
      await writer.close();
      return { data: new Uint8Array(await done), method: 8 };
    }
  } catch { /* weiter */ }
  try {
    const zlib = await import('node:zlib');
    const d = zlib.createDeflateRaw({ level: 6 });
    const out = [];
    d.on('data', (b) => out.push(new Uint8Array(b)));
    const finished = new Promise((res, rej) => { d.on('end', res); d.on('error', rej); });
    for (const c of chunks) { if (!d.write(c)) await new Promise((r) => d.once('drain', r)); }
    d.end();
    await finished;
    let n = 0; for (const b of out) n += b.length;
    const data = new Uint8Array(n); let p = 0; for (const b of out) { data.set(b, p); p += b.length; }
    return { data, method: 8 };
  } catch { /* kein zlib */ }
  let n = 0; for (const c of chunks) n += c.length;
  const data = new Uint8Array(n); let p = 0; for (const c of chunks) { data.set(c, p); p += c.length; }
  return { data, method: 0 };
}

/** Minimaler ZIP-Writer: entries = [{ name, chunks: Uint8Array[] }] → ArrayBuffer */
export async function zip(entries) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = (2 << 5) | 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixe Zeit, reproduzierbar
  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const chunks = e.chunks || [e.data];
    let rawLen = 0, crc = 0xFFFFFFFF;
    for (const c of chunks) { rawLen += c.length; for (let i = 0; i < c.length; i++) crc = CRC_TABLE[(crc ^ c[i]) & 0xFF] ^ (crc >>> 8); }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const { data, method } = await deflateChunks(chunks);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, rawLen, true); lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, rawLen, true); ch.setUint16(28, nameB.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0; for (const c of centrals) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true); eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdStart, true); eocd.setUint16(20, 0, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of locals) { out.set(b, p); p += b.length; }
  for (const b of centrals) { out.set(b, p); p += b.length; }
  out.set(new Uint8Array(eocd.buffer), p);
  return out.buffer;
}

// ---------------------------------------------------------------------------
/** Mesh → 3MF-XML in Byte-Chunks (≈1 MB): kein Riesen-String im Speicher. Welt-Matrix angewendet, mm, z hoch. */
function meshChunks(mesh, push) {
  mesh.updateWorldMatrix(true, false);
  const enc = new TextEncoder();
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const idx = geo.index ? geo.index.array : null;
  const m = mesh.matrixWorld.elements;
  let buf = '';
  const flush = () => { if (buf) { push(enc.encode(buf)); buf = ''; } };
  const f = (x) => Math.round(x * 100) / 100; // 0,01 mm reicht für den Druck, spart ~30 % Größe
  push(enc.encode('<mesh><vertices>'));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    buf += `<vertex x="${f(wx)}" y="${f(-wz)}" z="${f(wy)}"/>`; // Three (y hoch) → 3MF (z hoch)
    if (buf.length > 1e6) flush();
  }
  flush();
  push(enc.encode('</vertices><triangles>'));
  const n = idx ? idx.length : pos.count;
  for (let i = 0; i < n; i += 3) {
    const a = idx ? idx[i] : i, b = idx ? idx[i + 1] : i + 1, c = idx ? idx[i + 2] : i + 2;
    buf += `<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
    if (buf.length > 1e6) flush();
  }
  flush();
  push(enc.encode('</triangles></mesh>'));
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * Baut eine 3MF-Datei (ArrayBuffer) aus Objekten mit Teilen.
 * objects = [{ name, parts: [{ name, mesh: THREE.Mesh, extruder: 1|2|… }] }]
 */
export async function make3MF(objects, { application = 'OVJU Konfigurator' } = {}) {
  const enc = new TextEncoder();
  let nextId = 1;
  const modelChunks = [], buildItems = [], settings = [];
  const push = (u8) => modelChunks.push(u8);
  const pushText = (t) => push(enc.encode(t));
  pushText(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
<metadata name="Application">${esc(application)}</metadata>
<metadata name="BambuStudio:3mfVersion">1</metadata>
<metadata name="Copyright">Kundendesign — OVJU</metadata>
<resources>`);
  for (const obj of objects) {
    const partIds = [];
    for (const part of obj.parts) {
      const id = nextId++;
      partIds.push({ id, part });
      pushText(`<object id="${id}" type="model"><metadata name="name">${esc(part.name)}</metadata>`);
      meshChunks(part.mesh, push);
      pushText('</object>');
    }
    const objId = nextId++;
    pushText(`<object id="${objId}" type="model"><metadata name="name">${esc(obj.name)}</metadata><components>${partIds.map((p) => `<component objectid="${p.id}"/>`).join('')}</components></object>`);
    buildItems.push(`<item objectid="${objId}" printable="1"/>`);
    settings.push(`  <object id="${objId}">
    <metadata key="name" value="${esc(obj.name)}"/>
    <metadata key="extruder" value="${obj.parts[0]?.extruder ?? 1}"/>
${partIds.map((p) => `    <part id="${p.id}" subtype="normal_part">
      <metadata key="name" value="${esc(p.part.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="${p.part.extruder ?? 1}"/>
    </part>`).join('\n')}
  </object>`);
  }
  pushText(`</resources>
<build>${buildItems.join('')}</build>
</model>`);
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="config" ContentType="text/xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
${settings.join('\n')}
</config>`;
  return zip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', chunks: modelChunks },
    { name: 'Metadata/model_settings.config', data: enc.encode(modelSettings) },
  ]);
}
