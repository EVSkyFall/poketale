// Moves from later generations in an older generation's battle. Showdown's older battle code never had such moves and
// skips some of their own code: the events it does not run, the move effects its moveHit does not know, the state it
// never keeps. That code is run at the matching point, for later moves only (a generation's own moves stay as its code
// has them), so the move works as in its own generation, whatever the story's settings. Found by counting, in random
// battles with every move, which move and condition handlers each generation's battle code calls, then playing each
// gap; reviews added what the count cannot see (state such as activeMoveActions, the request, the turn order).

const later = (battle, move) => !!move?.exists && move.gen > battle.gen;

// Handlers of one event with equal priority are put in order by the battle's random numbers, which would change every
// later roll of a battle that never uses a later move; the handlers added here take a priority no other handler has
// (EARLY before the generation's own handlers, LATE and LAST after them)
const TIE_FREE = 0.5, EARLY = 1.5, LATE = -100.5, LAST = -1e6 - 0.5;

// Moved code that throws leaves the battle going without that effect
function guarded(battle, label, run) {
	try {
		return run();
	} catch (error) {
		battle.debug(`later move code failed (${label}): ${error?.message ?? error}`);
		return undefined;
	}
}

// Replaces owner[key] once per battle; each port tags its wrapper, so several can stack on the same function
function wrap(owner, key, tag, make) {
	const original = owner[key];
	if (original.laterMoves?.includes(tag)) return;
	const wrapped = make(original);
	wrapped.laterMoves = [...(original.laterMoves ?? []), tag];
	owner[key] = wrapped;
}

export function runLaterMoves(battle) {
	const gen = battle.gen;
	if (!(gen < 9)) return;
	revivingRequests(battle);
	if (gen <= 5) {
		effectiveness(battle);
		olderModifyMove(battle);
		powderImmunity(battle);
		if (gen >= 2) accuracyOlder(battle);
	}
	if (gen <= 4) hitOdds(battle);
	if (gen <= 3) {
		categoryOlder(battle);
		modifyMove(battle);
		modifyTarget(battle);
		hitTargets(battle);
		hitCount(battle);
		stealBoosts(battle);
	}
	if (gen === 3) spreadGen3(battle);
	if (gen <= 2) {
		tailwindSpeed(battle);
		moveHitGaps(battle);
		selfDestructIfHit(battle);
		multiAccuracy(battle);
		bypassSubstitute(battle);
		screensByCategory(battle);
	}
	if (gen === 2) runMoveGen2(battle);
	if (gen === 1) {
		basePower(battle);
		accuracyGen1(battle);
		ohkoGen1(battle);
		critGen1(battle);
		multiHitGen1(battle);
		statusCuts(battle);
		prepareHit(battle);
		afterMove(battle);
		runMoveGen1(battle);
		boostFlags(battle);
		areaMoves(battle);
	}
}

// Types a generation does not have yet (Dark and Steel before generation 2, Fairy before 6) are missing from its type
// chart: a later move of such a type hits with the chart of the type's own generation. Generation 1 also runs the
// Effectiveness event of its damage on the battle instead of the Pokémon hit, so a later move's own handler (Freeze-Dry,
// Flying Press) and the hit Pokémon's later volatile (Tar Shot) are run there, for the Pokémon the damage is worked out
// for. Its damage doubles or halves once for each type, so a type that a later effect makes count more than that (Tar
// Shot on a Pokémon already weak to Fire) adds the rest to the damage
const TYPE_FROM = Object.freeze({ Dark: 2, Steel: 2, Fairy: 6 });
const damageCalc = new WeakMap();
function effectiveness(battle) {
	const gen = battle.gen;
	if (gen === 1) wrap(battle.actions, 'getDamage', 'defender', getDamage => function (source, target, move, ...rest) {
		const outer = damageCalc.get(battle), calc = { target, factor: 1 };
		damageCalc.set(battle, calc);
		try {
			const damage = getDamage.call(this, source, target, move, ...rest);
			return typeof damage === 'number' && damage > 0 && calc.factor !== 1 ? Math.max(1, Math.floor(damage * calc.factor)) : damage;
		} finally {
			if (outer) damageCalc.set(battle, outer);
			else damageCalc.delete(battle);
		}
	});
	battle.onEvent('Effectiveness', battle.format, TIE_FREE, function (typeMod, target, type, move) {
		if (typeof typeMod !== 'number' || !move?.type || typeof type !== 'string') return;
		let mod = typeMod;
		const from = TYPE_FROM[move.type];
		if (from && gen < from) mod += this.dex.forGen(from).getEffectiveness(move.type, type) - this.dex.getEffectiveness(move.type, type);
		const calc = gen === 1 && target === this ? damageCalc.get(this) : null;
		const defender = gen === 1 && target === this ? calc?.target ?? this.activeTarget : null;
		if (defender) {
			if (later(this, move) && move.onEffectiveness) {
				const out = guarded(this, `${move.id} effectiveness`, () => move.onEffectiveness.call(this, mod, defender, type, move));
				if (typeof out === 'number') mod = out;
			}
			for (const id of Object.keys(defender.volatiles)) {
				const effect = this.dex.conditions.get(id);
				if (!effect.onEffectiveness || !later(this, this.dex.moves.get(id))) continue;
				const out = guarded(this, `${id} effectiveness`, () => effect.onEffectiveness.call(this, mod, defender, type, move));
				if (typeof out === 'number') mod = out;
			}
			if (calc && Math.abs(mod) > 1) calc.factor *= 2 ** (mod - Math.sign(mod));
		}
		return mod === typeMod ? undefined : mod;
	});
}

// Laser Focus gives a crit stage that the tables before generation 6 do not make sure (generation 1 has no stage step
// at all); a self-targeting status move rolls no accuracy from generation 5 (Obstruct, Clangorous Soul)
function olderModifyMove(battle) {
	const gen = battle.gen;
	battle.onEvent('ModifyMove', battle.format, TIE_FREE, function (move, pokemon) {
		if (pokemon.volatiles['laserfocus'] && move.category !== 'Status') move.willCrit = true;
		if (gen <= 4 && later(this, move) && move.target === 'self' && move.category === 'Status' && move.accuracy !== true) move.accuracy = true;
	});
}

// Generations 1-3 never let a move pick its target again: Metal Burst and Comeuppance hit the Pokémon that last hurt
// the user (double battles)
function modifyTarget(battle) {
	wrap(battle.actions, 'useMoveInner', 'modifyTarget', useMoveInner => function (moveOrMoveName, pokemon, options, ...rest) {
		const move = battle.dex.moves.get(moveOrMoveName);
		// Also for a move called without a target (Sleep Talk, Metronome, Copycat, Assist)
		if (later(battle, move) && move.onModifyTarget) {
			const relay = { target: options?.target };
			guarded(battle, `${move.id} target`, () => battle.singleEvent('ModifyTarget', move, null, pokemon, options?.target, move, relay));
			if (relay.target && relay.target !== options?.target) options = { ...options, target: relay.target };
		}
		return useMoveInner.call(this, moveOrMoveName, pokemon, options, ...rest);
	});
}

// Generations 1-3 have no later hit loop, which counts the hits each Pokémon takes from any move (Rage Fist): each hit
// that damages the Pokémon itself, not its Substitute
function hitCount(battle) {
	battle.onEvent('Damage', battle.format, TIE_FREE, function (damage, target, source, effect) {
		if (effect?.effectType === 'Move' && effect.category !== 'Status' && target && source && target !== source && damage > 0) target.timesAttacked++;
	});
}

// Generation 1 works out a multi-hit move's damage once and lands its added effect on the last hit; later generations,
// a later move's own, work out every hit (Triple Axel's growing power, a critical hit each time) and roll the effect
// on each
function multiHitGen1(battle) {
	wrap(battle.actions, 'moveHit', 'multihit', moveHit => function (target, pokemon, move, moveData, isSecondary, isSelf, ...rest) {
		if (isSecondary || isSelf || !move?.multihit || !(move.hit > 0) || !later(battle, move)) return moveHit.call(this, target, pokemon, move, moveData, isSecondary, isSelf, ...rest);
		const { damage, lastHit } = move;
		move.damage = undefined;
		move.lastHit = true;
		try {
			return moveHit.call(this, target, pokemon, move, moveData, isSecondary, isSelf, ...rest);
		} finally {
			move.damage = damage;
			move.lastHit = lastHit;
		}
	});
}

// ... and steals the target's raised stats before a move that takes them hits (Spectral Thief). The stages come off
// through the generation's own boostBy (generation 1 works its stats out again from it)
// Generation 1 runs the Protect family's TryHit inside moveHit, so there the stages come off at the end of TryHit,
// once nothing stopped the move
function stealBoosts(battle) {
	const steal = (foe, pokemon, move) => {
		if (!move?.stealsBoosts || move.laterStole || !foe || foe === pokemon || !later(battle, move)) return;
		move.laterStole = true;
		guarded(battle, `${move.id} steal`, () => {
			const boosts = Object.fromEntries(Object.entries(foe.boosts).filter(([, stage]) => stage > 0));
			if (!Object.keys(boosts).length) return;
			battle.attrLastMove('[still]');
			battle.add('-clearpositiveboost', foe, pokemon, `move: ${move.name}`);
			battle.boost(boosts, pokemon, pokemon);
			foe.boostBy(Object.fromEntries(Object.entries(boosts).map(([stat, stage]) => [stat, -stage])));
			if (move.id === 'spectralthief') battle.addMove('-anim', pokemon, 'Spectral Thief', foe);
		});
	};
	if (battle.gen === 1) {
		battle.onEvent('TryHit', battle.format, LAST, function (target, source, move) {
			steal(target, source, move);
		});
		return;
	}
	wrap(battle.actions, 'moveHit', 'steal', moveHit => function (target, pokemon, move, moveData, isSecondary, isSelf, ...rest) {
		if (!isSecondary && !isSelf) steal(Array.isArray(target) ? target[0] : target, pokemon, move);
		return moveHit.call(this, target, pokemon, move, moveData, isSecondary, isSelf, ...rest);
	});
}

// Generation 1 checks a semi-invulnerable target even for a move that hits a side or the field (a hazard missed a
// flying foe); later generations do not
const AREA_TARGETS = new Set(['foeSide', 'allySide', 'allyTeam', 'all']);
function areaMoves(battle) {
	wrap(battle.actions, 'tryMoveHit', 'area', tryMoveHit => function (target, pokemon, move, ...rest) {
		if (!AREA_TARGETS.has(move.target) || !later(battle, move)) return tryMoveHit.call(this, target, pokemon, move, ...rest);
		const own = Object.getOwnPropertyDescriptor(battle, 'runEvent');
		const runEvent = battle.runEvent;
		battle.runEvent = function (id, ...args) {
			return id === 'Invulnerability' ? true : runEvent.call(this, id, ...args);
		};
		try {
			return tryMoveHit.call(this, target, pokemon, move, ...rest);
		} finally {
			if (own) Object.defineProperty(battle, 'runEvent', own);
			else delete battle.runEvent;
		}
	});
}

// Revival Blessing works in every generation's battle code, but only generation 9's request marks the slot that must
// choose a fainted Pokémon (Pokemon.getSwitchRequestData), and the switch screen and the AI go by that mark
function revivingRequests(battle) {
	wrap(battle, 'getRequests', 'reviving', getRequests => function (type, ...rest) {
		const requests = getRequests.call(this, type, ...rest);
		for (const [i, side] of this.sides.entries()) {
			const entries = requests[i]?.side?.pokemon;
			if (!entries) continue;
			side.pokemon.forEach((pokemon, j) => {
				if (entries[j] && pokemon.isActive && side.slotConditions[pokemon.position]?.['revivalblessing']) entries[j].reviving = true;
			});
		}
		return requests;
	});
}

// Before generation 4 a damaging move's type decides whether it is Physical or Special
const SPECIAL_TYPES = new Set(['Fire', 'Water', 'Grass', 'Ice', 'Electric', 'Dark', 'Psychic', 'Dragon']);

// Generations 1-3 run ModifyMove but not ModifyType: a later move's own type (Weather Ball, Judgment, Tera Blast...),
// then Electrify's and Ion Deluge's Electric. A move whose type changes there takes that type's category, as those
// generations' own Hidden Power and Weather Ball do, unless it keeps its own category (categoryOlder)
function modifyMove(battle) {
	battle.onEvent('ModifyMove', battle.format, EARLY, function (move, pokemon, target) {
		const type = move.type;
		if (later(this, move) && move.onModifyType) guarded(this, `${move.id} type`, () => move.onModifyType.call(this, move, pokemon, target));
		if (move.id !== 'struggle' && (pokemon.volatiles['electrify'] || (move.type === 'Normal' && this.field.pseudoWeather['iondeluge']))) move.type = 'Electric';
		if (move.type !== type && move.category !== 'Status' && !ownCategory(this, move)) move.category = SPECIAL_TYPES.has(move.type) ? 'Special' : 'Physical';
	});
}

// The older code keeps no list of the targets a move hit (Sparkling Aria's AfterMove reads it)
function hitTargets(battle) {
	wrap(battle.actions, 'tryMoveHit', 'hitTargets', tryMoveHit => function (target, pokemon, move, ...rest) {
		const result = tryMoveHit.call(this, target, pokemon, move, ...rest);
		if (target && (result || result === 0) && later(battle, move)) {
			move.hitTargets ??= [];
			if (!move.hitTargets.includes(target)) move.hitTargets.push(target);
		}
		return result;
	});
}

// Generation 1 runs BasePower without the move's own handler (Facade, Brine, Venoshock, Knock Off...). It has no final
// damage step either: Aurora Veil halves the power of hits that are not critical unless Reflect or Light Screen covers
// it, and the hit Pokémon's damage handlers run here (Glaive Rush's user takes double, a diving one takes double from
// Surf, a minimized one from a later stomping move)
function basePower(battle) {
	battle.onEvent('BasePower', battle.format, EARLY, function (power, attacker, defender, move) {
		let out;
		if (later(this, move) && move.onBasePower) out = guarded(this, `${move.id} power`, () => move.onBasePower.call(this, power, attacker, defender, move));
		if (defender?.side.sideConditions['auroraveil'] && !defender.getMoveHitData(move).crit
			&& !defender.volatiles[move.category === 'Physical' ? 'reflect' : 'lightscreen']) this.chainModify(0.5);
		for (const id of Object.keys(defender?.volatiles ?? {})) {
			if (!(later(this, move) || later(this, this.dex.moves.get(id)))) continue;
			const effect = conditionFor(this, id, move, 'onSourceModifyDamage');
			if (effect) guarded(this, `${id} damage`, () => effect.onSourceModifyDamage.call(this, power, attacker, defender, move));
		}
		return out;
	});
}

// The condition whose handler a later move meets: the battle generation's own, or where that one has no such handler,
// the move's own generation's (generation 1's Minimize has no damage handler for a later stomping move)
function conditionFor(battle, id, move, handler) {
	const effect = battle.dex.conditions.get(id);
	if (effect[handler]) return effect;
	if (!later(battle, move)) return null;
	const own = battle.dex.forGen(move.gen).conditions.get(id);
	return own[handler] ? own : null;
}

// A later move meets the hit Pokémon's conditions with its own generation's accuracy handler where the battle's has
// none (Minimize makes Malicious Moonsault and Flying Press sure to hit before generation 6)
function sureHit(battle, accuracy, target, move) {
	if (!later(battle, move)) return false;
	for (const id of Object.keys(target?.volatiles ?? {})) {
		if (battle.dex.conditions.get(id).onAccuracy) continue;
		const effect = conditionFor(battle, id, move, 'onAccuracy');
		if (effect && guarded(battle, `${id} accuracy`, () => effect.onAccuracy.call(battle, accuracy, target, null, move)) === true) return true;
	}
	return false;
}

// A later one-hit KO move (Sheer Cold) rolls its own generation's 30% plus the level difference, past accuracy and
// evasion stages; the battle's roll is out of 256
const OHKO_ACCURACY = 30;
const ohkoAccuracy = (source, target) => (OHKO_ACCURACY + source.level - target.level) * 256 / 100;

// Generation 1 has no ModifyAccuracy step: a later field effect's change (Gravity) is made in its Accuracy event
function accuracyGen1(battle) {
	battle.onEvent('Accuracy', battle.format, TIE_FREE, function (accuracy, target, source, move) {
		if (typeof accuracy !== 'number') return;
		if (move?.laterOhko) return ohkoAccuracy(source, target);
		if (sureHit(this, accuracy, target, move)) return true;
		for (const id of Object.keys(this.field.pseudoWeather)) {
			const effect = this.dex.conditions.get(id);
			if (effect.onModifyAccuracy && later(this, this.dex.moves.get(id))) guarded(this, `${id} accuracy`, () => effect.onModifyAccuracy.call(this, accuracy, target, source, move));
		}
	});
}

function accuracyOlder(battle) {
	battle.onEvent('Accuracy', battle.format, TIE_FREE, function (accuracy, target, source, move) {
		if (typeof accuracy === 'number' && sureHit(this, accuracy, target, move)) return true;
	});
	if (battle.gen === 2) battle.onEvent('ModifyAccuracy', battle.format, TIE_FREE, function (accuracy, target, source, move) {
		if (typeof accuracy === 'number' && move?.ohko && later(this, move)) return ohkoAccuracy(source, target);
	});
}

// Generation 1's one-hit KO move fails on a faster target; a later one (Sheer Cold) fails on a higher-level one, as in
// its own generation, and its accuracy is worked out in accuracyGen1. Its damage is generation 1's own one-hit KO
// damage, cut to what the target has
const OHKO_DAMAGE = 65535;
function ohkoGen1(battle) {
	wrap(battle.actions, 'tryMoveHit', 'ohko', tryMoveHit => function (target, pokemon, move, ...rest) {
		if (!move?.ohko || !target || target === pokemon || !later(battle, move)) return tryMoveHit.call(this, target, pokemon, move, ...rest);
		if (pokemon.level < target.level) {
			battle.add('-immune', target, '[ohko]');
			return false;
		}
		const { ohko, damage } = move;
		Object.assign(move, { ohko: false, damage: OHKO_DAMAGE, laterOhko: true });
		let result;
		try {
			result = tryMoveHit.call(this, target, pokemon, move, ...rest);
		} finally {
			Object.assign(move, { ohko, damage, laterOhko: false });
		}
		if (result !== false && !target.hp) battle.add('-ohko');
		return result;
	});
}

// Generation 1 rolls a critical hit from the attacker's base Speed. A later move rolls its own generation's chance for
// its stage instead (Focus Energy adds 1 in generation 2 and 2 after it); the critical hit's damage stays generation 1's.
// The roll replaces generation 1's own, the first out of 256 in its damage calculation
const CRIT_GEN2 = [0, 17, 32, 64, 85, 128];
function critGen1(battle) {
	wrap(battle.actions, 'getDamage', 'crit', getDamage => function (source, target, move, ...rest) {
		if (!source || typeof move !== 'object' || move.willCrit !== undefined || !later(battle, move)) return getDamage.call(this, source, target, move, ...rest);
		const own = Object.getOwnPropertyDescriptor(battle, 'randomChance');
		const randomChance = battle.randomChance;
		const restore = () => {
			if (own) Object.defineProperty(battle, 'randomChance', own);
			else delete battle.randomChance;
		};
		battle.randomChance = function (numerator, denominator, ...more) {
			restore();
			if (denominator !== 256) return randomChance.call(this, numerator, denominator, ...more);
			return guarded(battle, `${move.id} crit`, () => ownCrit(battle, source, target, move)) ?? randomChance.call(this, numerator, denominator, ...more);
		};
		try {
			return getDamage.call(this, source, target, move, ...rest);
		} finally {
			restore();
		}
	});
}

function ownCrit(battle, source, target, move) {
	const gen = move.gen;
	let stage = battle.runEvent('ModifyCritRatio', source, target, move, move.critRatio || 0);
	if (source.volatiles['focusenergy']) stage += gen === 2 ? 1 : 2;
	if (gen === 2) return battle.random(256) < CRIT_GEN2[battle.clampIntRange(stage, 0, 5)];
	const table = gen <= 5 ? [0, 16, 8, 4, 3, 2] : gen === 6 ? [0, 16, 8, 2, 1] : [0, 24, 8, 2, 1];
	stage = battle.clampIntRange(stage, 0, table.length - 1);
	return stage > 0 && battle.randomChance(1, table[stage]);
}

// A 2-5 hit move rolls 2-3-4-5 hits as 3:3:1:1 before generation 5 and 7:7:3:3 from it: a later move from generation 5
// on (Tail Slap, Scale Shot, Water Shuriken) keeps its own odds, with the same one roll
const OLD_HITS = '2,2,2,3,3,3,4,5';
const HITS_FROM_5 = Object.freeze([2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
function hitOdds(battle) {
	wrap(battle, 'sample', 'hits', sample => function (items, ...rest) {
		const move = this.activeMove;
		if (move?.gen >= 5 && later(this, move) && items?.length === 8 && items.join() === OLD_HITS) return sample.call(this, HITS_FROM_5, ...rest);
		return sample.call(this, items, ...rest);
	});
}

// Generation 3 halves a spread move's damage, and only for a move hitting both foes; from generation 4 any move hitting
// more than one Pokémon does 0.75 of its damage (Discharge, Lava Plume, Bulldoze). Generation 3 still halves after this
// step for a move at both foes, so that one is given twice
function spreadGen3(battle) {
	battle.onEvent('ModifyDamagePhase1', battle.format, TIE_FREE, function (damage, source, target, move) {
		if (!move?.spreadHit || !(move.gen >= 4) || typeof damage !== 'number' || !later(this, move)) return;
		const cut = this.modify(damage, 0.75);
		return move.target === 'allAdjacentFoes' ? cut * 2 : cut;
	});
}

// From generation 6 Grass Pokémon are immune to powder moves: a later one (Powder, Magic Powder) keeps that
function powderImmunity(battle) {
	battle.onEvent('TryHit', battle.format, TIE_FREE, function (target, source, move) {
		if (!move?.flags?.['powder'] || !(move.gen >= 6) || target === source || !later(this, move) || !target?.hasType('Grass')) return;
		this.add('-immune', target);
		return null;
	});
}

// Before generation 4 a damaging move's type decides its category; a later move from generation 4 on keeps its own
// (Shadow Ball special, Foul Play physical). Set as the move is about to run its own ModifyMove, so a move that picks
// its category there (Photon Geyser, Shell Side Arm) still does
const SPLIT_FROM = 4;
const ownCategory = (battle, move) => later(battle, move) && move.gen >= SPLIT_FROM && move.category !== 'Status';
function categoryOlder(battle) {
	wrap(battle, 'singleEvent', 'category', singleEvent => function (id, effect, ...rest) {
		if (id === 'ModifyMove' && effect?.effectType === 'Move' && typeof effect.hit === 'number' && ownCategory(this, effect)) {
			const category = this.dex.forGen(effect.gen).moves.get(effect.id).category;
			if (category === 'Physical' || category === 'Special') effect.category = category;
		}
		return singleEvent.call(this, id, effect, ...rest);
	});
}

// Generation 2's runMove runs only the move's own AfterMove: a later move's volatile that ends there (Charge, after the
// next move other than Charge, as in generations 3-8) gets it with the move that ran last, as later runMove does (a
// move Sleep Talk calls counts). Neither generation 1 nor 2 counts a Pokémon's moves since it came in (Fake Out, First
// Impression and Mat Block work only on the first), nor records a move it could not use (Stomping Tantrum) or the
// turn's last move that worked (Fusion Flare, Fusion Bolt)
function runMoveGen2(battle) {
	wrap(battle.actions, 'runMove', 'gen2', runMove => function (moveOrMoveName, pokemon, ...rest) {
		pokemon.activeMoveActions++;
		const moved = pokemon.moveThisTurn;
		const result = runMove.call(this, moveOrMoveName, pokemon, ...rest);
		if (moved) return result;
		// A move it could not use counts as failed (Stomping Tantrum); a move that worked is the turn's last (Fusion Flare)
		if (!pokemon.moveThisTurn && pokemon.moveThisTurnResult === undefined) pokemon.moveThisTurnResult = false;
		battle.lastSuccessfulMoveThisTurn = pokemon.moveThisTurn && pokemon.moveThisTurnResult !== false ? battle.activeMove?.id ?? pokemon.moveThisTurn : null;
		if (!pokemon.moveThisTurn || pokemon.fainted) return result;
		const move = battle.activeMove?.id ? battle.activeMove : battle.dex.getActiveMove(pokemon.moveThisTurn);
		for (const [id, state] of Object.entries(pokemon.volatiles)) {
			const effect = battle.dex.conditions.get(id);
			if (!effect.onAfterMove || !later(battle, battle.dex.moves.get(id))) continue;
			guarded(battle, `${id} after move`, () => battle.singleEvent('AfterMove', effect, state, pokemon, null, move));
		}
		return result;
	});
}

// Generation 1 has no PrepareHit: the Protect family's check for using it again (with its stall counter) runs where
// the move is tried
function prepareHit(battle) {
	battle.onEvent('TryMove', battle.format, EARLY, function (pokemon, target, move) {
		if (!later(this, move) || !move.onPrepareHit) return;
		const result = guarded(this, `${move.id} prepare`, () => this.singleEvent('PrepareHit', move, {}, target, pokemon, move));
		if (result || result === undefined) return;
		if (result === false) this.add('-fail', pokemon);
		return null;
	});
}

// Generation 1 runs AfterMove without the move's own handler (Sparkling Aria, Spit Up, Beak Blast...)
function afterMove(battle) {
	battle.onEvent('AfterMove', battle.format, EARLY, function (pokemon, target, move) {
		if (!later(this, move) || !move.onAfterMove) return;
		move.hitTargets ??= target ? [target] : [];
		guarded(this, `${move.id} after move`, () => move.onAfterMove.call(this, pokemon, target, move));
	});
}

// Moves Encore does not lock in (generation 2's Pokemon.moveUsed)
const ENCORE_SKIPS = new Set(['metronome', 'mimic', 'mirrormove', 'sketch', 'sleeptalk', 'transform']);

// Generation 1's runMove, for what later moves need from it:
// - the count of moves since the Pokémon came in (Fake Out, First Impression, Mat Block), whether the move failed
//   (Stomping Tantrum) and the turn's last move that worked (Fusion Flare)
// - target 'allies' on the user (Life Dew) and the user's own stat change after the hit (Scale Shot, Clanging Scales)
// - stats in use: generation 1 reads them from modifiedStats, which only its own stage changes and status moves keep up;
//   after a later move, a stat it changed the stored value, stage or cutting status of (Speed Swap, Power Trick, Heart
//   Swap, Topsy-Turvy, Dire Claw's paralysis, a cure from Jungle Healing) is worked out as later generations keep it
// - its own generation's recharge after a knockout (Giga Impact)
// - the move Encore locks in, which only generation 2's Pokemon.moveUsed records; generation 1 plays generation 2's
//   Encore, so it is the move chosen for the turn (Metronome and Mirror Move lock in nothing), once it was used
// - later two-turn moves (Bounce, Dive, Phantom Force, Meteor Beam, Sky Drop...) count on twoturnmove as later
//   generations have it: it adds the move's own volatile (their invulnerability, and the mark that the charge is done)
//   and ends after the attack turn, or when that turn is cut short (sleep, flinch, full paralysis). Generation 1's
//   twoturnmove does neither, and its runMove takes PP on the attack turn of any move not in its own list of two-turn
//   moves, so later ones paid twice
function runMoveGen1(battle) {
	const charging = id => {
		const move = battle.dex.moves.get(id);
		return later(battle, move) && move.flags['charge'];
	};
	const started = new Map(), struck = new Map(), recharge = new Set();
	let laterRan = false;
	battle.onEvent('BeforeMove', battle.format, LATE, function (pokemon, target, move) {
		started.set(pokemon, move);
	});
	// A Pokémon that comes in with passed stages or a swapped stat (Baton Pass, Power Trick passed on) or is cured as it
	// comes in (Healing Wish, Lunar Dance) gets its stats worked out again. Wrapped rather than a SwitchIn handler:
	// Pokémon coming in together sort the field's handlers, and a tie there takes a random number
	wrap(battle.actions, 'switchIn', 'passedStages', switchIn => function (pokemon, ...rest) {
		const was = pokemon?.modifiedStats ? statInputs(pokemon) : null;
		const result = switchIn.call(this, pokemon, ...rest);
		if (was && pokemon.isActive) {
			const now = statInputs(pokemon);
			for (const stat of RESTAT) if (pokemon.boosts[stat] || now[stat] !== was[stat]) guarded(battle, 'switch-in stats', () => freshStat(pokemon, stat));
		}
		return result;
	});
	wrap(battle.actions, 'tryMoveHit', 'struck', tryMoveHit => function (target, pokemon, ...rest) {
		const result = tryMoveHit.call(this, target, pokemon, ...rest);
		struck.set(pokemon, result);
		return result;
	});
	wrap(battle.actions, 'useMoveInner', 'gen1', useMoveInner => function (moveOrMoveName, pokemon, options, ...rest) {
		const move = battle.dex.moves.get(moveOrMoveName);
		if (!later(battle, move)) return useMoveInner.call(this, moveOrMoveName, pokemon, options, ...rest);
		laterRan = true;
		// Target 'allies' is the user and its allies; generation 1 sent it to the foe
		if (move.target === 'allies') options = { ...options, target: pokemon };
		struck.delete(pokemon);
		const result = useMoveInner.call(this, moveOrMoveName, pokemon, options, ...rest);
		const hit = struck.get(pokemon);
		if (move.selfBoost && hit !== undefined && hit !== false && pokemon.hp) {
			const active = typeof moveOrMoveName === 'string' ? battle.dex.getActiveMove(moveOrMoveName) : moveOrMoveName;
			guarded(battle, `${move.id} self boost`, () => this.moveHit(pokemon, pokemon, active, move.selfBoost, false, true));
		}
		// Its own generation's recharge holds after a knockout too (Giga Impact, Blast Burn); generation 1 drops it
		if (move.self?.volatileStatus === 'mustrecharge' && hit !== undefined && hit !== false) recharge.add(pokemon);
		return result;
	});
	wrap(battle.actions, 'runMove', 'gen1', runMove => function (moveOrMoveName, pokemon, ...rest) {
		pokemon.activeMoveActions++;
		started.delete(pokemon);
		struck.delete(pokemon);
		recharge.delete(pokemon);
		laterRan = false;
		// Only where a later move ran: the generation's own moves keep their own stats rules (Transform copies the stats
		// in use, a stage change re-cuts the foe's burn or paralysis)
		const before = new Map(battle.getAllActive().map(p => [p, { transformed: p.transformed, inputs: statInputs(p), modified: { ...p.modifiedStats } }]));
		const from = battle.log.length;
		const locked = pokemon.volatiles['twoturnmove'], attacking = locked && charging(locked.move) ? locked.move : null;
		const result = attacking ? withoutPP(pokemon, () => runMove.call(this, moveOrMoveName, pokemon, ...rest)) : runMove.call(this, moveOrMoveName, pokemon, ...rest);
		if (laterRan) guarded(battle, 'stats', () => restatAll(before));
		if (recharge.delete(pokemon) && pokemon.hp && !pokemon.volatiles['mustrecharge']) {
			guarded(battle, 'recharge', () => {
				pokemon.addVolatile('mustrecharge');
				battle.add('-mustrecharge', pokemon);
			});
		}
		const move = started.get(pokemon);
		started.delete(pokemon);
		// A move it could not use, one stopped before its hit (Sucker Punch, the Protect family's second use, a charge
		// turn), and one that missed or failed count as failed (Stomping Tantrum); one that worked is the turn's last
		// (Fusion Flare). Generation 1 reports a failed status move with a failure line and nothing else
		if (!move) pokemon.moveThisTurnResult = false;
		else {
			const worked = struck.has(pokemon) && struck.get(pokemon) !== false && !battle.log.slice(from).some(line => line.startsWith('|-fail|'));
			pokemon.moveThisTurnResult = worked;
			battle.lastSuccessfulMoveThisTurn = worked ? battle.activeMove?.id ?? move.id : null;
		}
		// Used, not stopped after BeforeMove (generation 1 records nothing for the charge turn of its own two-turn moves)
		if (move && (pokemon.moveThisTurn || pokemon.volatiles['twoturnmove'])) pokemon.lastMoveEncore = ENCORE_SKIPS.has(move.id) ? null : move;
		if (attacking) {
			pokemon.removeVolatile('twoturnmove');
			pokemon.removeVolatile(attacking);
		} else {
			const lock = pokemon.volatiles['twoturnmove'];
			if (lock && charging(lock.move) && !pokemon.volatiles[lock.move]) guarded(battle, `${lock.move} charge`, () => {
				const defender = lock.source && !lock.source.fainted ? lock.source : null;
				const added = pokemon.addVolatile(lock.move, defender, battle.dex.moves.get(lock.move));
				if (added && defender && defender !== pokemon) pokemon.volatiles[lock.move].targetLoc = pokemon.getLocOf(defender);
			});
		}
		return result;
	});
}

const RESTAT = ['atk', 'def', 'spa', 'spd', 'spe'];
const STAGE_UP = [1, 1.5, 2, 2.5, 3, 3.5, 4], STAGE_DOWN = [100, 66, 50, 40, 33, 28, 25];

// The status that cuts a stat, and by how much
const STATUS_CUT = Object.freeze({ atk: ['brn', 0.5], spe: ['par', 0.25] });

// What a stat in use is worked out from: the stored stat, the stage, and the status that cuts it
function statInputs(pokemon) {
	return Object.fromEntries(RESTAT.map(stat => [stat, `${pokemon.storedStats[stat]}:${pokemon.boosts[stat]}:${STATUS_CUT[stat]?.[0] === pokemon.status}`]));
}

// A stat in use as later generations keep it: the stored stat at the stage (999 at most once raised, as generation 1's
// boostBy caps it), then the cut of burn or paralysis, which later generations apply all the time
function freshStat(pokemon, stat) {
	const stage = pokemon.boosts[stat];
	pokemon.modifiedStats[stat] = pokemon.storedStats[stat];
	pokemon.modifyStat(stat, stage >= 0 ? STAGE_UP[stage] : STAGE_DOWN[-stage] / 100);
	if (stage > 0 && pokemon.modifiedStats[stat] > 999) pokemon.modifiedStats[stat] = 999;
	const cut = STATUS_CUT[stat];
	if (cut && pokemon.status === cut[0]) pokemon.modifyStat(stat, cut[1]);
}

// After a later move: a stat whose stored value, stage or cutting status changed is worked out afresh, and one that
// changed only by generation 1's re-cut of the foe's status after a stage change goes back. A Pokémon that transformed
// keeps the stats Transform copied
function restatAll(before) {
	for (const [pokemon, was] of before) {
		if (!pokemon.isActive || pokemon.fainted || !pokemon.modifiedStats || pokemon.transformed !== was.transformed) continue;
		const now = statInputs(pokemon);
		for (const stat of RESTAT) {
			if (now[stat] !== was.inputs[stat]) freshStat(pokemon, stat);
			else pokemon.modifiedStats[stat] = was.modified[stat];
		}
	}
}

// A burn or paralysis from something other than a move (a later move's condition: Beak Blast's charge, Burning
// Bulwark; a held item or an ability where the story allows them) does not get the stat cut generation 1's moveHit
// gives; and a stage change from such an effect keeps the cut, as later generations apply it all the time (King's
// Shield on a burned attacker), where generation 1's boostBy drops it
const laterEffect = (battle, effect) => !!effect && (effect.effectType === 'Ability' || effect.effectType === 'Item' || later(battle, battle.dex.moves.get(effect.id)));
function statusCuts(battle) {
	battle.onEvent('AfterSetStatus', battle.format, TIE_FREE, function (status, target, source, effect) {
		if (!target?.modifiedStats || effect?.effectType === 'Move') return;
		for (const [stat, [id, by]] of Object.entries(STATUS_CUT)) if (status?.id === id) target.modifyStat(stat, by);
	});
	wrap(battle, 'boost', 'cuts', boost => function (changes, target = null, source = null, effect = null, ...rest) {
		const pokemon = target ?? this.event?.target;
		const cause = effect ?? this.effect;
		const stages = pokemon?.modifiedStats ? { ...pokemon.boosts } : null;
		const result = boost.call(this, changes, target, source, effect, ...rest);
		if (stages && laterEffect(this, cause)) {
			for (const [stat, [id, by]] of Object.entries(STATUS_CUT)) if (pokemon.status === id && pokemon.boosts[stat] !== stages[stat]) pokemon.modifyStat(stat, by);
		}
		return result;
	});
}

function withoutPP(pokemon, run) {
	const own = Object.getOwnPropertyDescriptor(pokemon, 'deductPP');
	pokemon.deductPP = () => 0;
	try {
		return run();
	} finally {
		if (own) Object.defineProperty(pokemon, 'deductPP', own);
		else delete pokemon.deductPP;
	}
}

// Generation 1's boost does not mark the Pokémon's stats as raised or lowered this turn (Lash Out, Burning Jealousy)
function boostFlags(battle) {
	wrap(battle, 'boost', 'flags', boost => function (changes, target = null, ...rest) {
		const pokemon = target ?? this.event?.target;
		const result = boost.call(this, changes, target, ...rest);
		if (result && pokemon && changes) {
			if (Object.values(changes).some(x => x > 0)) pokemon.statsRaisedThisTurn = true;
			if (Object.values(changes).some(x => x < 0)) pokemon.statsLoweredThisTurn = true;
		}
		return result;
	});
}

// Generations 1-2 work out speed without Tailwind's doubling. The speed they give already carries Trick Room (negative)
// and Quick Claw (65535, a move first whatever the speed), so Tailwind doubles it unless Quick Claw went off
const QUICK_CLAW_SPEED = 65535;
function tailwindSpeed(battle) {
	wrap(battle, 'getActionSpeed', 'tailwind', getActionSpeed => function (action, ...rest) {
		const result = getActionSpeed.call(this, action, ...rest);
		if (action.pokemon?.side.sideConditions['tailwind'] && typeof action.speed === 'number' && action.speed !== QUICK_CLAW_SPEED) action.speed *= 2;
		return result;
	});
}

// The move's own TryHit refused it (Revival Blessing with nobody fainted, Healing Wish with nobody to switch in)
const REFUSALS = new Set(['TryHit', 'TryHitField', 'TryHitSide']);
function watchRefusal(battle, data, run) {
	const own = Object.getOwnPropertyDescriptor(battle, 'singleEvent');
	const singleEvent = battle.singleEvent;
	let refused = false;
	battle.singleEvent = function (id, effect, ...rest) {
		const out = singleEvent.call(this, id, effect, ...rest);
		if (effect === data && REFUSALS.has(id) && !out) refused = true;
		return out;
	};
	try {
		return [run(), refused];
	} finally {
		if (own) Object.defineProperty(battle, 'singleEvent', own);
		else delete battle.singleEvent;
	}
}

// What generations 1-2's moveHit does not do for a later move that its own TryHit let through: start a slot condition
// (Wish, Healing Wish, Lunar Dance, Revival Blessing, whose switch to a fainted Pokémon the moveHit asks only when a
// healthy one could come in), thaw the target (Hydro Steam), and in generation 1 run HitField (Perish Song, Court
// Change), HitSide (Quick Guard, Wide Guard) and AfterHit (Ceaseless Edge, Stone Axe, Mortal Spin, Ice Spinner) and drag
// the target out (Dragon Tail, Circle Throw)
function moveHitGaps(battle) {
	const gen = battle.gen;
	wrap(battle.actions, 'moveHit', 'gaps', moveHit => function (target, pokemon, move, moveData, isSecondary, isSelf) {
		const run = () => moveHit.call(this, target, pokemon, move, moveData, isSecondary, isSelf);
		if (isSecondary || isSelf || !later(battle, move)) return run();
		const data = moveData || move;
		const from = battle.log.length;
		// A hit the Substitute takes (it loses HP or breaks) reaches nothing behind it: no drag, no thaw, no AfterHit, but
		// the move's own AfterSubDamage (Rapid Spin, Ceaseless Edge), which generation 1's Substitute does not run
		const sub = target && target !== pokemon ? target.volatiles['substitute'] : null;
		const subHp = sub?.hp;
		const [result, refused] = watchRefusal(battle, data, run);
		if (refused) {
			move.laterRefused = true;
			return result;
		}
		const intoSub = !!sub && (target.volatiles['substitute'] !== sub || sub.hp !== subHp);
		if (intoSub) {
			if (gen === 1 && data.onAfterSubDamage) guarded(battle, `${move.id} after sub damage`, () => battle.singleEvent('AfterSubDamage', data, {}, target, pokemon, move, battle.lastDamage));
			if (gen === 1) {
				const broke = target.volatiles['substitute'] !== sub;
				if (broke && data.self && data.self.volatileStatus !== 'lockedmove') guarded(battle, `${move.id} self`, () => this.moveHit(pokemon, pokemon, move, data.self, false, true));
			}
			return result;
		}
		let worked = false;
		if (data.slotCondition) {
			const user = target ?? pokemon;
			worked = !!guarded(battle, `${move.id} slot`, () => user.side.addSlotCondition(user, data.slotCondition, pokemon, move));
		}
		if (gen === 1 && data.onHitField) {
			const hit = guarded(battle, `${move.id} field`, () => battle.singleEvent('HitField', data, {}, target, pokemon, move));
			if (hit === false) battle.add('-fail', pokemon);
			else worked = true;
		}
		if (gen === 1 && data.onHitSide) {
			const side = move.target === 'foeSide' ? pokemon.side.foe : pokemon.side;
			if (guarded(battle, `${move.id} side`, () => battle.singleEvent('HitSide', data, {}, side, pokemon, move)) !== false) worked = true;
		}
		if (gen === 1 && data.onAfterHit && target && (typeof result === 'number' || result === true)) {
			guarded(battle, `${move.id} after hit`, () => battle.singleEvent('AfterHit', data, {}, target, pokemon, move));
		}
		if (gen === 1 && data.forceSwitch && target && target !== pokemon && target.hp && pokemon.hp && (typeof result === 'number' || result === true)
			&& battle.canSwitch(target.side) && guarded(battle, `${move.id} drag`, () => battle.runEvent('DragOut', target, pokemon, move))) target.forceSwitchFlag = true;
		if (data.thawsTarget && target?.status === 'frz' && typeof result === 'number') target.cureStatus();
		if (worked && data.selfSwitch && pokemon.hp && !pokemon.switchFlag && (battle.canSwitch(pokemon.side) || move.id === 'revivalblessing')) {
			pokemon.switchFlag = move.id;
		}
		if (!worked || result) return result;
		// The older code reported the move as doing nothing (generation 2: Wish) before its effect started here
		const fail = `|-fail|${target ?? pokemon}`;
		const at = battle.log.lastIndexOf(fail);
		if (at >= from) battle.log.splice(at, 1);
		return true;
	});
}

// Generations 1-2 faint a self-destructing move's user whatever happens (generation 2 before the move is even tried). A
// later move that faints its user only when it works (Healing Wish, Lunar Dance, Memento, Final Gambit) does so after it
function selfDestructIfHit(battle) {
	wrap(battle.actions, 'tryMoveHit', 'ifHit', tryMoveHit => function (target, pokemon, move, ...rest) {
		if (move.selfdestruct !== 'ifHit' || !later(battle, move)) return tryMoveHit.call(this, target, pokemon, move, ...rest);
		let result;
		move.selfdestruct = undefined;
		try {
			result = tryMoveHit.call(this, target, pokemon, move, ...rest);
		} finally {
			move.selfdestruct = 'ifHit';
		}
		if ((result || result === 0) && !move.laterRefused && pokemon.hp) battle.faint(pokemon, pokemon, move);
		return result;
	});
}

// Generations 1-2 roll accuracy once for a move whose every hit rolls (Triple Axel, Population Bomb): the hits after the
// first are rolled before the hit loop, and it gets as many hits as landed in a row
function multiAccuracy(battle) {
	wrap(battle.actions, 'tryMoveHit', 'multiaccuracy', tryMoveHit => function (target, pokemon, move, ...rest) {
		if (!move.multiaccuracy || typeof move.multihit !== 'number' || !target || !later(battle, move)) return tryMoveHit.call(this, target, pokemon, move, ...rest);
		const all = move.multihit;
		let hits = 1;
		while (hits < all && rollsHit(battle, pokemon, target, move)) hits++;
		move.multihit = hits;
		try {
			return tryMoveHit.call(this, target, pokemon, move, ...rest);
		} finally {
			move.multihit = all;
		}
	});
}

// Each roll goes the way the generation's own tryMoveHit rolls a move's accuracy, events included (Lock-On and Mind
// Reader make sure, Gravity raises it, BrightPowder lowers it)
const GEN1_ACCURACY_STAGES = [25, 28, 33, 40, 50, 66, 100, 150, 200, 250, 300, 350, 400];
const GEN2_UP = [1, 1.33, 1.66, 2, 2.33, 2.66, 3], GEN2_DOWN = [1, 0.75, 0.6, 0.5, 0.43, 0.36, 0.33];
function rollsHit(battle, pokemon, target, move) {
	if (battle.gen === 1) {
		let accuracy = move.accuracy;
		if (accuracy !== true) {
			accuracy = Math.floor(accuracy * 255 / 100);
			if (!move.ignoreAccuracy) accuracy = Math.floor(accuracy * (GEN1_ACCURACY_STAGES[pokemon.boosts.accuracy + 6] / 100));
			if (!move.ignoreEvasion) accuracy = Math.floor(accuracy * (GEN1_ACCURACY_STAGES[-target.boosts.evasion + 6] / 100));
			accuracy = battle.clampIntRange(accuracy, 1, 255);
		}
		accuracy = battle.runEvent('Accuracy', target, pokemon, move, accuracy);
		return accuracy === true || battle.randomChance(accuracy, 256);
	}
	let accuracy = move.alwaysHit ? true : battle.runEvent('Accuracy', target, pokemon, move, move.accuracy);
	if (accuracy !== true) {
		accuracy = Math.floor(accuracy * 255 / 100);
		if (!move.ignoreAccuracy) accuracy *= pokemon.boosts.accuracy > 0 ? GEN2_UP[pokemon.boosts.accuracy] : GEN2_DOWN[-pokemon.boosts.accuracy];
		if (!move.ignoreEvasion) {
			if (target.boosts.evasion > 0 && !move.ignorePositiveEvasion) accuracy *= GEN2_DOWN[target.boosts.evasion];
			else if (target.boosts.evasion < 0) accuracy *= GEN2_UP[-target.boosts.evasion];
		}
		accuracy = Math.max(Math.min(Math.floor(accuracy), 255), 1);
	} else {
		accuracy = battle.runEvent('Accuracy', target, pokemon, move, accuracy);
	}
	accuracy = battle.runEvent('ModifyAccuracy', target, pokemon, move, accuracy);
	if (accuracy !== true) accuracy = Math.max(accuracy, 0);
	if (!move.alwaysHit) accuracy = battle.runEvent('Accuracy', target, pokemon, move, accuracy);
	return accuracy === true || accuracy === 255 || battle.randomChance(accuracy, 256);
}

// Generations 1-2's Substitute takes every move; a later move that goes around it (Hyperspace Hole, sound moves from
// generation 6, Parting Shot) hits the Pokémon behind it
function bypassSubstitute(battle) {
	wrap(battle.actions, 'moveHit', 'bypasssub', moveHit => function (target, pokemon, move, moveData, isSecondary, isSelf, ...rest) {
		const run = () => moveHit.call(this, target, pokemon, move, moveData, isSecondary, isSelf, ...rest);
		const substitute = target?.volatiles?.['substitute'];
		if (!substitute || isSelf || target === pokemon || !later(battle, move) || !(move.flags?.['bypasssub'] || move.infiltrates)) return run();
		delete target.volatiles['substitute'];
		try {
			return run();
		} finally {
			if (!target.volatiles['substitute']) target.volatiles['substitute'] = substitute;
		}
	});
}

// Generations 1-2 put Reflect and Light Screen on the stat a hit is worked out with, later generations on the move's
// category: a later move that uses another stat (Psyshock and Secret Sword hit Defense with a special move, Body Press
// attacks with Defense) gets the screen of its category, and the attacker's own screen does not raise its attack
const SCREEN_OF = Object.freeze({ def: 'reflect', spd: 'lightscreen' });
function screensByCategory(battle) {
	const gen = battle.gen;
	const holder = pokemon => (gen === 1 ? pokemon.volatiles : pokemon.side.sideConditions);
	wrap(battle.actions, 'getDamage', 'screens', getDamage => function (source, target, move, ...rest) {
		const data = typeof move === 'string' ? battle.dex.moves.get(move) : move;
		if (!source || !target || !later(battle, data) || data.category === 'Status' || !(data.overrideDefensiveStat || data.overrideOffensiveStat)) {
			return getDamage.call(this, source, target, move, ...rest);
		}
		const physical = data.category === 'Physical';
		const defType = data.overrideDefensiveStat || (physical ? 'def' : 'spd');
		const atkType = data.overrideOffensiveStat || (physical ? 'atk' : 'spa');
		const undo = [];
		const put = (where, key, value) => {
			undo.push([where, key, Object.hasOwn(where, key), where[key]]);
			if (value === undefined) delete where[key];
			else where[key] = value;
		};
		if (SCREEN_OF[defType]) {
			const defending = holder(target), screen = defending[physical ? 'reflect' : 'lightscreen'];
			put(defending, 'reflect', undefined);
			put(defending, 'lightscreen', undefined);
			put(defending, SCREEN_OF[defType], screen);
			// Aurora Veil does not add to the screen of the move's category
			if (screen && target.side.sideConditions['auroraveil']) put(target.side.sideConditions, 'auroraveil', undefined);
		}
		if (gen === 2 && SCREEN_OF[atkType] && holder(source)[SCREEN_OF[atkType]]) {
			if (source.side !== target.side) put(holder(source), SCREEN_OF[atkType], undefined);
			else {
				// Hitting an ally: the side's screen stays for the target, so the attacker's own stat is taken without it
				const getStat = source.getStat;
				put(source, 'getStat', function (statName, unboosted, ...more) {
					const value = getStat.call(this, statName, unboosted, ...more);
					return statName === atkType && !unboosted ? Math.floor(value / 2) : value;
				});
			}
		}
		try {
			return getDamage.call(this, source, target, move, ...rest);
		} finally {
			for (const [where, key, had, value] of undo.reverse()) {
				if (had) where[key] = value;
				else delete where[key];
			}
		}
	});
}
