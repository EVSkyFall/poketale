import CRIES from '../data/pokerogue-cries.json' with { type: 'json' };

// A voice pack: a zip of voice lines exactly as the player downloaded it, such as the PokéPark 2 rips on The Sounds
// Resource. Each Pokémon's lines sit in a folder named after it, at any depth; the rips of the playable characters
// are not filed that way and carry the game's file-name prefixes instead.

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

const toId = text => text.normalize('NFKD').replace(/♀/g, 'f').replace(/♂/g, 'm').toLowerCase().replace(/[^a-z0-9]/g, '');
const NAMES = [...NAME_DEX].map(([id, dex]) => [toId(id), dex]);
const ID_DEX = new Map(NAMES);

// One substitution, insertion, deletion or swap of neighbours ("Crophish", "Keckleon" in the PokéPark 2 rip).
const oneEditApart = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
};

// A folder named after a species, perhaps after its dex number ("025_Pikachu") (rank 0), or a misspelt name one edit
// away from exactly one species (rank 200).
export function folderDex(folder) {
  const id = toId(folder);
  if (!id) return null;
  const exact = ID_DEX.get(id) ?? ID_DEX.get(id.replace(/^\d+/, ''));
  if (exact) return { dex: exact, rank: 0 };
  const near = new Set(NAMES.filter(([name]) => oneEditApart(id, name)).map(([, dex]) => dex));
  return near.size === 1 ? { dex: [...near][0], rank: 200 } : null;
}

const AUDIO_FILE = /^(.*?)([^/]+)\.(wav|ogg|oga|opus|mp3|m4a|aac|flac)$/i;
const TYPES = { wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };

// PokéPark 2 files its playable characters' voices under their Japanese names.
const CHARACTERS = { PIKA: 25, MIJU: 501, TUTA: 495, POKA: 498 };

// Where a file sits: the species, how surely the path names it, and the folder its lines share.
// A correctly named folder nearest the file wins; then the game's file-name prefix; then a misspelt folder, but only
// beside correctly named ones, so a wrapper such as "Audio" (one edit from Audino) never passes for a species.
function locate(name, folderOf, besideSpecies) {
  const audio = AUDIO_FILE.exec(name);
  if (!audio) return null;
  const [, dir, file] = audio;
  const folders = dir.split('/').slice(0, -1);
  const at = rank => {
    for (let i = folders.length - 1; i >= 0; i--) {
      const found = folderOf(folders[i]);
      if (found?.rank === rank && (rank === 0 || besideSpecies.has(folders.slice(0, i).join('/')))) return { found, i };
    }
    return null;
  };
  const named = at(0);
  if (named) return { dex: named.found.dex, score: [0, folders.length - named.i - 1], home: folders.slice(0, named.i + 1).join('/') };
  const character = CHARACTERS[/^S_([A-Z]+)_VOICE/i.exec(file)?.[1]?.toUpperCase()];
  if (character) return { dex: character, score: [1, 0], home: dir };
  const misspelt = at(200);
  return misspelt ? { dex: misspelt.found.dex, score: [2, folders.length - misspelt.i - 1], home: folders.slice(0, misspelt.i + 1).join('/') } : null;
}

const before = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

// A species gets every file that ties for the best place: all of its lines.
// Files in subfolders of a species folder are forms or other events, so they only fill a gap.
// macOS zips carry "._" resource-fork stubs (and a __MACOSX copy) beside every file.
export function indexCries(names) {
  const files = [...names].filter(name => !/(?:^|\/)__MACOSX\//i.test(name) && !name.split('/').at(-1).startsWith('._') && AUDIO_FILE.test(name));
  const seen = new Map();
  const folderOf = folder => { if (!seen.has(folder)) seen.set(folder, folderDex(folder)); return seen.get(folder); };
  const besideSpecies = new Set();
  for (const name of files) {
    const folders = name.split('/').slice(0, -1);
    folders.forEach((folder, i) => { if (folderOf(folder)?.rank === 0) besideSpecies.add(folders.slice(0, i).join('/')); });
  }
  const best = new Map();
  for (const name of files) {
    const place = locate(name, folderOf, besideSpecies);
    if (!place) continue;
    const key = [...place.score, place.home.length, place.home];
    const held = best.get(place.dex);
    if (held && held.home === place.home && place.score.every((value, i) => value === held.score[i])) held.names.push(name);
    else if (!held || before(key, held.key)) best.set(place.dex, { key, home: place.home, score: place.score, names: [name] });
  }
  return new Map([...best].map(([dex, { names: found }]) => [dex, found.sort()]));
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

// variants(key) is how many voices the pack holds for that Pokémon; url(key, n) gives one of them.
export function openCryPack(bytes) {
  const entries = readZip(bytes), urls = new Map();
  const voices = indexCries([...entries].filter(([, entry]) => entry.method === 0 || entry.method === 8).map(([name]) => name));
  return {
    count: voices.size,
    species: () => voices.keys(),
    has: key => voices.has(cryDex(key)),
    variants: key => voices.get(cryDex(key))?.length ?? 0,
    // Blob URLs are never revoked: every play clones the cached audio element and reloads its source.
    url(key, variant = 0) {
      const names = voices.get(cryDex(key));
      if (!names) return Promise.resolve(null);
      const line = Number.isFinite(variant) ? Math.trunc(variant) : 0;
      const name = names[((line % names.length) + names.length) % names.length];
      if (!urls.has(name)) {
        const type = TYPES[name.split('.').at(-1).toLowerCase()] ?? '';
        urls.set(name, entryBytes(bytes, entries.get(name)).then(data => URL.createObjectURL(new Blob([data], { type })),
          error => { urls.delete(name); throw error; }));
      }
      return urls.get(name);
    },
  };
}

// Several packs play as one: the first pack that has a Pokémon gives its voices, and a pack that fails to
// give one hands over to the next pack that has it.
export function combineCryPacks(packs) {
  const list = packs.filter(pack => pack?.count);
  if (!list.length) return null;
  const owners = key => list.filter(pack => pack.has(key));
  return {
    count: new Set(list.flatMap(pack => [...pack.species()])).size,
    species: () => new Set(list.flatMap(pack => [...pack.species()])).values(),
    has: key => owners(key).length > 0,
    variants: key => owners(key)[0]?.variants(key) ?? 0,
    async url(key, variant = 0) {
      let failure = null;
      for (const pack of owners(key)) {
        try {
          const url = await pack.url(key, variant);
          if (url) return url;
        } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
      return null;
    },
  };
}
