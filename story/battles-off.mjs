import { readStored, isRecord, isUnreadable } from './stored.mjs';
import { failed } from './failure.mjs';
import { importPlace, anchorAtEnd } from './import.mjs';

export const BATTLES_OFF_VAR = '$pkb_battles_off';

const changeShape = change => isRecord(change) && typeof change.time === 'number' && isRecord(change.at) && typeof change.off === 'boolean';

export function readBattlesOff(chat) {
  const { status, value } = readStored(chat?.scriptstate?.[BATTLES_OFF_VAR], { shape: v => Array.isArray(v.changes) && v.changes.every(changeShape) });
  return { status, changes: status === 'ok' ? value.changes : [] };
}

export const battlesOff = chat => readBattlesOff(chat).changes.at(-1)?.off === true;

export function setBattlesOff(chat, off, { now = Date.now() } = {}) {
  const { status, changes } = readBattlesOff(chat);
  if (isUnreadable(status)) throw failed('unreadable');
  if ((changes.at(-1)?.off === true) === off) return false;
  chat.scriptstate ??= {};
  chat.scriptstate[BATTLES_OFF_VAR] = JSON.stringify({ v: 1, changes: [...changes, { time: now, at: anchorAtEnd(chat?.message ?? []), off }] });
  return true;
}

export function quietAt(chat) {
  const { changes } = readBattlesOff(chat);
  if (!changes.length) return () => false;
  if (changes.at(-1).off) return () => true;
  const messages = chat?.message ?? [];
  const places = changes.map(change => importPlace(messages, change));
  for (let k = places.length - 2; k >= 0; k--) places[k] = Math.min(places[k], places[k + 1]);
  return i => {
    let off = false;
    changes.forEach((change, k) => { if (places[k] < i) off = change.off; });
    return off;
  };
}
