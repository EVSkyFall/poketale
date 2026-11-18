// The level-up table (data/levelup.json) holds each species' newest list. The older generations' lists
// (data/levelup-past.json: per species [[gen, list], ..., [newest, 0]], 0 standing for the newest list) ride on it as a
// hidden property, so code reading `table[speciesId]` keeps the newest lists and only callers that know a generation
// ask for another. A table without them (a copy made by JSON, an older bundle) gives the newest lists everywhere.
const PAST = Symbol.for('pokebattle.levelUpPast');
const ROOT = Symbol.for('pokebattle.levelUpRoot');
const MADE = Symbol.for('pokebattle.levelUpByGen');

const hidden = (target, key, value) => Object.defineProperty(target, key, { value, configurable: true });

export function withPastLevelUp(table, past) {
  if (table && typeof table === 'object' && past && typeof past === 'object') hidden(table, PAST, past);
  return table;
}

// One species' list for a generation: its latest list of that generation or earlier, else the first one it has (a
// species newer than the generation learns as in its own first generation).
function listAt(entries, gen, newest) {
  if (!Array.isArray(entries) || !entries.length) return newest;
  let pick = null;
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    if (pick === null || entry[0] <= gen) pick = entry;
    if (entry[0] >= gen) break;
  }
  return !pick || pick[1] === 0 || !Array.isArray(pick[1]) ? newest : pick[1];
}

// `gen` null, missing or 9 and later gives the newest table itself.
export function levelUpAt(table, gen) {
  const root = table?.[ROOT] ?? table;
  const past = root?.[PAST];
  if (!past || !Number.isInteger(gen) || gen >= 9) return root;
  let made = root[MADE];
  if (!made) { made = new Map(); hidden(root, MADE, made); }
  let at = made.get(gen);
  if (!at) {
    at = { ...root };
    for (const [id, entries] of Object.entries(past)) at[id] = listAt(entries, gen, root[id]);
    hidden(at, ROOT, root);
    made.set(gen, at);
  }
  return at;
}
