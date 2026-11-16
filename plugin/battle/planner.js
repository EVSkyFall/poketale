import * as sim from '../../engine/browser-engine.mjs';
import { planTurns } from '../../director/plan.js';
import { createEnemyAI } from '../../ai/index.js';
import { enemyOptions } from './flow.js';
import { battleNamesIn } from './names.js';
import { offToolReasons } from '../../story/tools.mjs';

const enemyFor = spec => createEnemyAI(sim, enemyOptions(spec));

export async function workOut(snapshot, turns, { options, lang }) {
  const plan = await planTurns(sim, snapshot, turns, { options, enemyAI: enemyFor(snapshot.spec), names: battleNamesIn(lang, sim.Dex), lang });
  return { ...plan, turns: offToolReasons(snapshot.spec, turns, plan.turns) };
}

export const readAt = (snapshot, options) => workOut(snapshot, [], options);

export { commandQueue } from '../../director/plan.js';
