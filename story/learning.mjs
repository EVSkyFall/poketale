import { MACHINE_STANDARDS, regionStandard } from './machine-standards.mjs';

// Which generation's level-up table a Pokémon learns from (the "Learned Moves" setting): that of the region it is in
// now, or that of the place it joined (`mon.metGen`)
export const LEARN_MODES = Object.freeze(['origin', 'location']);
export const DEFAULT_LEARN = 'location';

// A place's generation: that of its region's game at the story's world generation, by the disc standards' rule
// (story/machine-standards.mjs regionStandard: Kanto is Red/Blue in a generation-1 world, FireRed/LeafGreen in a
// generation-3 one), else the world generation where no region with games is known (before the first Status Window,
// Hisui)
export const placeGen = (region, world) => MACHINE_STANDARDS[regionStandard(region, world)]?.gen ?? (Number.isInteger(world?.gen) ? world.gen : null);

// setting: the chat's generation setting at that message (story/generation.mjs). Chats kept on generation 9 learn as
// before (the newest tables) but still note where Pokémon join, for the day they switch to auto.
export const learningAt = ({ setting, world, region, by }) => ({ place: placeGen(region, world), legacy: setting === 'legacy', by: LEARN_MODES.includes(by) ? by : DEFAULT_LEARN });

// The generation whose table a Pokémon learns from here, or null for the newest table (engine/levelup.mjs levelUpAt).
// mon null asks for a Pokémon joining here, whose origin is this place.
export function learnGen(learning, mon = null) {
  if (!learning || learning.legacy) return null;
  const own = learning.by === 'origin' && Number.isInteger(mon?.metGen) ? mon.metGen : null;
  return own ?? (Number.isInteger(learning.place) ? learning.place : null);
}

// The place a joining Pokémon comes from, as saved on it
export const metGenOf = learning => (Number.isInteger(learning?.place) ? learning.place : null);
