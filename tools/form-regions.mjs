import { toID } from './sources.mjs';

export const REGIONS = ['alola', 'galar', 'hisui', 'paldea'];

export function formRegions({ species, aliases }) {
  const found = [];
  for (const [alias, name] of Object.entries(aliases)) {
    const id = toID(name), record = species[id];
    if (!record?.base || Object.hasOwn(species, alias)) continue;
    if (REGIONS.some(region => alias === `${record.base}${region}`)) found.push([alias, id]);
  }
  return Object.fromEntries(found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
