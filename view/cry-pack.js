import CRIES from '../data/pokerogue-cries.json' with { type: 'json' };

// A Cobblemon cry resource pack: the Minecraft resource-pack zip exactly as the player downloaded it.
// Packs agree only on the folder layout, assets/<namespace>/sounds/pokemon/<species>/<file>.ogg; their
// sounds.json often lists a different set of files, so the folder names decide the species.

const NAME_DEX = new Map();
for (const [id, key] of Object.entries(CRIES)) if (!id.includes('-') && /^\d+$/.test(key)) NAME_DEX.set(id, Number(key));
const KNOWN_DEX = new Set(NAME_DEX.values());

// PokeRogue numbers some regional forms past the National Dex (slowpoke-galar is 4079), so the species
// comes from the sprite name and the cry key's own number only when the name is unknown.
const CRY_DEX = new Map();
for (const [id, key] of Object.entries(CRIES)) {
  if (CRY_DEX.has(key)) continue;
  const dex = NAME_DEX.get(id.split('-')[0]) ?? Number.parseInt(key, 10);
  if (KNOWN_DEX.has(dex)) CRY_DEX.set(key, dex);
}

export const cryDex = key => CRY_DEX.get(key) ?? null;

const toId = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// The folder rank prefers an exact species name, then a name with a form tail ("deoxys-normal",
// "basculin-red-striped"), then a bare number ("pokemon_32").
export function folderDex(folder) {
  const exact = NAME_DEX.get(toId(folder));
  if (exact) return { dex: exact, rank: 0 };
  const parts = folder.split(/[-_ .]+/);
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const dex = NAME_DEX.get(toId(parts.slice(0, keep).join('')));
    if (dex) return { dex, rank: parts.length - keep };
  }
  const number = /^(?:pokemon[-_ ]?)?0*(\d+)$/i.exec(folder);
  const dex = number ? Number(number[1]) : null;
  return KNOWN_DEX.has(dex) ? { dex, rank: 100 } : null;
}

const fileRank = (folder, file) => {
  const name = file.toLowerCase();
  if (name === 'cry') return 0;
  if (name === `${folder.toLowerCase()}_cry`) return 1;
  return name.includes('cry') ? 2 : 3;
};

const PACK_FILE = /(?:^|\/)assets\/[^/]+\/sounds\/pokemon\/([^/]+)\/((?:[^/]+\/)*)([^/]+)\.ogg$/i;

const better = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

// Files in subfolders of a species folder are forms or other events, so they only fill a gap.
// macOS zips carry "._" resource-fork stubs (and a __MACOSX copy) beside every file.
export function indexCries(names) {
  const best = new Map();
  for (const name of names) {
    if (/(?:^|\/)__MACOSX\//i.test(name)) continue;
    const match = PACK_FILE.exec(name);
    if (!match) continue;
    const [, folder, sub, file] = match;
    if (file.startsWith('._')) continue;
    const found = folderDex(folder);
    if (!found) continue;
    const depth = sub ? sub.split('/').length - 1 : 0;
    const score = [found.rank, depth, fileRank(folder, file), folder.length, file.length, name];
    const held = best.get(found.dex);
    if (!held || better(score, held.score)) best.set(found.dex, { score, name });
  }
  return new Map([...best].map(([dex, { name }]) => [dex, name]));
}

const u16 = (b, o) => (b[o] | b[o + 1] << 8) >>> 0;
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const MAX32 = 0xffffffff;

// A zip comment may itself contain the end-record signature. The real record's comment reaches the end of the
// file and its central directory ends right before it (or a zip64 locator does); weaker matches are kept as fallbacks.
function endRecord(bytes) {
  const fits = i => i + 22 + u16(bytes, i + 20) === bytes.length;
  const joins = i => {
    const size = u32(bytes, i + 12), at = u32(bytes, i + 16);
    return (i >= 20 && u32(bytes, i - 20) === 0x07064b50) || (at !== MAX32 && size !== MAX32 && at + size === i);
  };
  let found = -1, fitting = -1;
  for (let i = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 0xffff); i >= stop; i--) {
    if (u32(bytes, i) !== 0x06054b50) continue;
    if (found < 0) found = i;
    if (!fits(i)) continue;
    if (joins(i)) return i;
    if (fitting < 0) fitting = i;
  }
  return fitting >= 0 ? fitting : found;
}

export function readZip(bytes) {
  const end = endRecord(bytes);
  if (end < 0) throw new Error('Not a zip file');
  let count = u16(bytes, end + 10), at = u32(bytes, end + 16);
  const locator = end - 20;
  if (locator >= 0 && u32(bytes, locator) === 0x07064b50) {
    const record = u64(bytes, locator + 8);
    if (u32(bytes, record) === 0x06064b50) { count = u64(bytes, record + 32); at = u64(bytes, record + 48); }
  }
  const entries = new Map(), text = new TextDecoder();
  for (let i = 0, p = at; i < count && u32(bytes, p) === 0x02014b50; i++) {
    const flags = u16(bytes, p + 8), method = u16(bytes, p + 10);
    let size = u32(bytes, p + 20), local = u32(bytes, p + 42);
    const nameLength = u16(bytes, p + 28), extraLength = u16(bytes, p + 30), commentLength = u16(bytes, p + 32);
    // Windows PowerShell 5.1 Compress-Archive writes backslash separators.
    const name = text.decode(bytes.subarray(p + 46, p + 46 + nameLength)).replaceAll('\\', '/');
    for (let e = p + 46 + nameLength, stop = e + extraLength; e + 4 <= stop; e += 4 + u16(bytes, e + 2)) {
      if (u16(bytes, e) !== 1) continue;
      const blockEnd = Math.min(stop, e + 4 + u16(bytes, e + 2));
      let q = e + 4;
      const take = held => { const value = q + 8 <= blockEnd ? u64(bytes, q) : held; q += 8; return value; };
      if (u32(bytes, p + 24) === MAX32) take(0);
      if (size === MAX32) size = take(size);
      if (local === MAX32) local = take(local);
    }
    if (!(flags & 1) && !name.endsWith('/')) entries.set(name, { method, size, local });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function entryBytes(bytes, entry) {
  if (entry.local + 30 > bytes.length || u32(bytes, entry.local) !== 0x04034b50) throw new Error('Broken zip entry');
  const start = entry.local + 30 + u16(bytes, entry.local + 26) + u16(bytes, entry.local + 28);
  if (start + entry.size > bytes.length) throw new Error('Broken zip entry');
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`Zip compression method ${entry.method}`);
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}

export function openCryPack(bytes) {
  const entries = readZip(bytes), urls = new Map();
  const voices = indexCries([...entries].filter(([, entry]) => entry.method === 0 || entry.method === 8).map(([name]) => name));
  return {
    count: voices.size,
    has: key => voices.has(cryDex(key)),
    // Blob URLs are never revoked: every play clones the cached audio element and reloads its source.
    url(key) {
      const name = voices.get(cryDex(key));
      if (!name) return Promise.resolve(null);
      if (!urls.has(name)) {
        urls.set(name, entryBytes(bytes, entries.get(name)).then(data => URL.createObjectURL(new Blob([data], { type: 'audio/ogg' })),
          error => { urls.delete(name); throw error; }));
      }
      return urls.get(name);
    },
  };
}
