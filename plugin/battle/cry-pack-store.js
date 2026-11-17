import { openCryPack } from '../../view/cry-pack.js';
import { failed } from '../../story/failure.mjs';

export const CRY_PACK_KEY = 'pkb_cry_pack';
export const CRY_PACK_INFO_KEY = 'pkb_cry_pack_info';

// RisuAI keeps plugin storage values as JSON, so the zip is stored as base64 text.
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
    count: info.count, bytes: Number.isFinite(info.bytes) ? info.bytes : 0 };
}

// Storage layout: the zip text starts with "<id>:" and the info carries the same id. The info is written after
// the zip and removed before it, so a zip counts only while info with its id exists; another page rewriting the
// zip mid-read shows up as an id mismatch.
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let current = null; // what battles on this page play: Promise<pack | null>
let shown; // the info of that pack once this page has read, loaded or removed one
let queue = Promise.resolve();

async function readStored(storage) {
  const info = normalizeCryPackInfo(await storage?.getItem?.(CRY_PACK_INFO_KEY));
  if (!info?.id) return { info: null, pack: null };
  const text = await storage.getItem(CRY_PACK_KEY);
  const cut = typeof text === 'string' ? text.indexOf(':') : -1;
  if (cut < 0 || text.slice(0, cut) !== info.id) return { info: null, pack: null };
  return { info, pack: openCryPack(fromBase64(text.slice(cut + 1))) };
}

// One read per page. A failed read is forgotten so the next battle tries again, unless the settings replaced it meanwhile.
export const cryPackSource = storage => () => {
  if (current) return current;
  const reading = readStored(storage).then(({ info, pack }) => {
    if (current === reading) shown = info;
    return pack;
  }, error => {
    console.warn('[poke-battle] 울음소리 팩을 읽지 못함', error);
    if (current === reading) current = null;
    return null;
  });
  return (current = reading);
};

export async function loadCryPackInfo(storage) {
  await queue;
  if (shown !== undefined) return shown;
  try { return normalizeCryPackInfo(await storage?.getItem?.(CRY_PACK_INFO_KEY)); } catch (error) {
    console.warn('[poke-battle] 울음소리 팩 정보를 읽지 못함', error);
    return null;
  }
}

// Changes run one at a time for the whole page, even when the settings window is closed and opened again meanwhile.
// Returns { info, saved }. This page switches at once; `saved: false` means storage keeps its previous state
// (a loaded pack plays only until the page closes, a removed one may load again next time).
export function setCryPack(storage, file) {
  const run = queue.then(() => changeCryPack(storage, file));
  queue = run.then(() => {}, () => {});
  return run;
}

async function changeCryPack(storage, file) {
  if (!file) {
    current = Promise.resolve(null); shown = null;
    try { await storage.removeItem(CRY_PACK_INFO_KEY); } catch (error) {
      console.warn('[poke-battle] 울음소리 팩을 지우지 못함', error);
      return { info: null, saved: false, error };
    }
    await Promise.resolve().then(() => storage.removeItem(CRY_PACK_KEY)).catch(error => console.warn('[poke-battle] 울음소리 팩 본문을 지우지 못함', error));
    return { info: null, saved: true };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pack;
  try { pack = openCryPack(bytes); } catch (error) {
    console.warn('[poke-battle] 울음소리 팩으로 읽을 수 없음', error);
    throw failed('notCryPack');
  }
  if (!pack.count) throw failed('notCryPack');
  const info = { id: newId(), name: String(file.name ?? ''), count: pack.count, bytes: bytes.length };
  current = Promise.resolve(pack); shown = info;
  try {
    const text = `${info.id}:${toBase64(bytes)}`;
    await storage.removeItem(CRY_PACK_INFO_KEY);
    await storage.setItem(CRY_PACK_KEY, text);
    await storage.setItem(CRY_PACK_INFO_KEY, JSON.stringify(info));
    return { info, saved: true };
  } catch (error) {
    console.warn('[poke-battle] 울음소리 팩을 저장하지 못함', error);
    return { info, saved: false, error };
  }
}
