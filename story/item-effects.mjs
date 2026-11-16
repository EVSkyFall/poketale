const READY = false;

export const ITEM_EFFECTS_READY = READY || globalThis[Symbol.for('pkb.test.itemEffectsOn')] === true;
