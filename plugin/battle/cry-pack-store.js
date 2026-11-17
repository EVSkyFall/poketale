import { openCryPack, combineCryPacks } from '../../view/cry-pack.js';
import { failed } from '../../story/failure.mjs';

// The pack list (JSON text, first pack first) and one zip per pack, kept as "<id>:<base64>" text under its own key.
export const CRY_PACKS_KEY = 'pkb_cry_packs';
// Earlier builds kept a single pack here; it is read as the whole list until a list is written.
export const CRY_PACK_KEY = 'pkb_cry_pack';
export const CRY_PACK_INFO_KEY = 'pkb_cry_pack_info';
const packKey = id => `pkb_cry_pack_${id}`;

// RisuAI keeps plugin storage values as JSON, so a zip is stored as base64 text.
export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text) {
  const raw = atob(text), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function normalizeCryPackInfo(value) {
  let info = value;
  if (typeof info === 'string') { try { info = JSON.parse(info); } catch { info = null; } }
  if (!info || typeof info !== 'object' || !Number.isInteger(info.count) || info.count < 1) return null;
  return { id: typeof info.id === 'string' ? info.id : '', name: typeof info.name === 'string' ? info.name : '',
    count: info.count, bytes: Number.isFinite(info.bytes) ? info.bytes : 0, key: typeof info.key === 'string' ? info.key : '' };
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let current = null; // what battles on this page play: Promise<combined pack | null>
let loaded = null; // [{ info, pack }] behind it, once this page has read or changed the packs
let missing = []; // listed packs that could not be read then: still shown, so they can be removed
let unlisted = false; // the list itself could not be read when this page first changed the packs
const dropped = new Set(); // ids removed on this page, even if storage refused to forget them
let queue = Promise.resolve();

// A zip counts only while the list names it and its text starts with the same id: the zip is written before
// the list and dropped from the list before it is removed.
async function storedList(storage) {
  let list = await storage?.getItem?.(CRY_PACKS_KEY);
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  if (Array.isArray(list)) return list.map(normalizeCryPackInfo).filter(info => info?.id && info.key);
  const single = normalizeCryPackInfo(await storage?.getItem?.(CRY_PACK_INFO_KEY));
  return single?.id ? [{ ...single, key: CRY_PACK_KEY }] : [];
}

async function readPack(storage, info) {
  const text = await storage.getItem(info.key);
  const cut = typeof text === 'string' ? text.indexOf(':') : -1;
  if (cut < 0 || text.slice(0, cut) !== info.id) return null;
  return openCryPack(fromBase64(text.slice(cut + 1)));
}

// One pack that cannot be read is left out; the others still play. `broken` means a read failed and may work later.
async function readStored(storage) {
  const packs = [], lost = [];
  let broken = false;
  for (const info of (await storedList(storage)).filter(info => !dropped.has(info.id))) {
    try {
      const pack = await readPack(storage, info);
      if (pack?.count) packs.push({ info, pack }); else lost.push(info);
    } catch (error) {
      broken = true; lost.push(info);
      console.warn('[poke-battle] 울음소리 팩 하나를 읽지 못함', info.name, error);
    }
  }
  return { packs, lost, broken };
}

const playing = () => combineCryPacks(loaded.map(entry => entry.pack));
const shownInfo = ({ id, name, count, bytes }) => ({ id, name, count, bytes });
const infos = () => [...loaded.map(entry => shownInfo(entry.info)), ...missing.filter(info => !dropped.has(info.id)).map(shownInfo)];

// One read per page. A read that missed a pack is forgotten so the next battle tries again, unless the settings
// changed the packs meanwhile.
export const cryPackSource = storage => () => {
  if (current) return current;
  const reading = readStored(storage).then(({ packs, lost, broken }) => {
    if (current === reading) { if (broken) current = null; else { loaded = packs; missing = lost; } }
    return combineCryPacks(packs.map(entry => entry.pack));
  }, error => {
    console.warn('[poke-battle] 울음소리 팩을 읽지 못함', error);
    if (current === reading) current = null;
    return null;
  });
  return (current = reading);
};

async function shown(storage) {
  if (loaded && unlisted) {
    try {
      const have = new Set(loaded.map(entry => entry.info.id));
      missing = (await storedList(storage)).filter(info => !have.has(info.id));
      unlisted = false;
    } catch (error) { console.warn('[poke-battle] 울음소리 팩 목록을 읽지 못함', error); }
  }
  if (loaded) return infos();
  try {
    return (await storedList(storage)).filter(info => !dropped.has(info.id)).map(({ id, name, count, bytes }) => ({ id, name, count, bytes }));
  } catch (error) {
    console.warn('[poke-battle] 울음소리 팩 목록을 읽지 못함', error);
    return [];
  }
}

// The packs this page plays, first pack first: [{ id, name, count, bytes }].
export async function loadCryPacks(storage) {
  await queue;
  return shown(storage);
}

// Changes run one at a time for the whole page, even when the settings window is closed and opened again meanwhile.
function enqueue(work) {
  const run = queue.then(work);
  queue = run.then(() => {}, () => {});
  return run;
}

async function forget(storage, info) {
  for (const key of info.key === CRY_PACK_KEY ? [CRY_PACK_KEY, CRY_PACK_INFO_KEY] : [info.key]) {
    await Promise.resolve().then(() => storage.removeItem(key)).catch(error => console.warn('[poke-battle] 울음소리 팩 본문을 지우지 못함', error));
  }
}

// Adds each file as a pack on top of the others; loading the same file again moves it to the top.
// Returns { packs, results }: one result per file, { name, info, saved } or { name, error } when it is not a pack.
// `saved: false` means the pack plays only until the page closes.
export function addCryPacks(storage, files) {
  return enqueue(async () => {
    const results = [];
    for (const file of files) results.push(await addOne(storage, file).catch(error => ({ name: String(file?.name ?? ''), error })));
    return { packs: await shown(storage), results };
  });
}

async function addOne(storage, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pack;
  try { pack = openCryPack(bytes); } catch (error) {
    console.warn('[poke-battle] 울음소리 팩으로 읽을 수 없음', error);
    throw failed('notCryPack');
  }
  if (!pack.count) throw failed('notCryPack');
  // The stored packs keep playing under the new one, so they are read once a file has proved to be a pack.
  if (!loaded) ({ packs: loaded, lost: missing, unlisted = false } = await readStored(storage).catch(() => ({ packs: [], lost: [], unlisted: true })));
  const id = newId();
  const info = { id, name: String(file.name ?? ''), count: pack.count, bytes: bytes.length, key: packKey(id) };
  const same = other => other.name === info.name && other.bytes === info.bytes;
  loaded = [{ info, pack }, ...loaded.filter(entry => !same(entry.info))];
  missing = missing.filter(other => !same(other));
  current = Promise.resolve(playing());
  let written = false;
  try {
    await storage.setItem(info.key, `${id}:${toBase64(bytes)}`);
    written = true;
    const list = await storedList(storage);
    await storage.setItem(CRY_PACKS_KEY, JSON.stringify([info, ...list.filter(other => !same(other))]));
    for (const other of list.filter(same)) await forget(storage, other);
    return { name: info.name, info: infos()[0], saved: true };
  } catch (error) {
    console.warn('[poke-battle] 울음소리 팩을 저장하지 못함', error);
    if (written) await forget(storage, info);
    return { name: info.name, info: infos()[0], saved: false, error };
  }
}

// Returns { packs, saved }. The pack stops playing on this page at once; `saved: false` means storage still lists
// it, so it may play again the next time the page opens. Stored copies of the same file go with it (a copy loaded
// again on this page whose save failed stands for the stored one).
export function removeCryPack(storage, id) {
  return enqueue(async () => {
    const target = loaded?.find(entry => entry.info.id === id)?.info;
    dropped.add(id);
    if (loaded) { loaded = loaded.filter(entry => entry.info.id !== id); current = Promise.resolve(playing()); } else current = null;
    let gone = [];
    try {
      const list = await storedList(storage);
      const same = target ?? list.find(info => info.id === id);
      gone = list.filter(info => info.id === id || (same && info.name === same.name && info.bytes === same.bytes));
      for (const info of gone) dropped.add(info.id);
      if (gone.length) await storage.setItem(CRY_PACKS_KEY, JSON.stringify(list.filter(info => !gone.includes(info))));
    } catch (error) {
      console.warn('[poke-battle] 울음소리 팩을 지우지 못함', error);
      return { packs: await shown(storage), saved: false, error };
    }
    for (const info of gone) await forget(storage, info);
    return { packs: await shown(storage), saved: true };
  });
}
