// Moves from later generations in an older generation's battle. Showdown's older battle code never had such moves and
// skips some of their own code: the events it does not run, the move effects its moveHit does not know, the state it
// never keeps. That code is run at the matching point, for later moves only (a generation's own moves stay as its code
// has them), so the move works as in its own generation, whatever the story's settings. Found by counting, in random
// battles with every move, which move and condition handlers each generation's battle code calls, then playing each
// gap; reviews added what the count cannot see (state such as activeMoveActions, the request, the turn order).

const later = (battle, move) => !!move?.exists && move.gen > battle.gen;

// Handlers of one event with equal priority are put in order by the battle's random numbers, which would change every
// later roll of a battle that never uses a later move; the handlers added here take a priority no other handler has
const TIE_FREE = 0.5;

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
	}
	if (gen <= 3) {
		modifyMove(battle);
		modifyTarget(battle);
		hitTargets(battle);
		hitCount(battle);
		stealBoosts(battle);
	}
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
// Flying Press) and the hit Pokémon's later volatile (Tar Shot) are run there
const TYPE_FROM = Object.freeze({ Dark: 2, Steel: 2, Fairy: 6 });
function effectiveness(battle) {
	const gen = battle.gen;
	battle.onEvent('Effectiveness', battle.format, TIE_FREE, function (typeMod, target, type, move) {
		if (typeof typeMod !== 'number' || !move?.type || typeof type !== 'string') return;
		let mod = typeMod;
		const from = TYPE_FROM[move.type];
		if (from && gen < from) mod += this.dex.forGen(from).getEffectiveness(move.type, type) - this.dex.getEffectiveness(move.type, type);
		const defender = gen === 1 && target === this ? this.activeTarget : null;
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
		if (options?.target && later(battle, move) && move.onModifyTarget) {
			const relay = { target: options.target };
			guarded(battle, `${move.id} target`, () => battle.singleEvent('ModifyTarget', move, null, pokemon, options.target, move, relay));
			if (relay.target && relay.target !== options.target) options = { ...options, target: relay.target };
		}
		return useMoveInner.call(this, moveOrMoveName, pokemon, options, ...rest);
	});
}

// Generations 1-3 have no later hit loop, which counts the hits each Pokémon takes from any move (Rage Fist)
function hitCount(battle) {
	wrap(battle.actions, 'tryMoveHit', 'hitCount', tryMoveHit => function (target, pokemon, move, ...rest) {
		const result = tryMoveHit.call(this, target, pokemon, move, ...rest);
		if (typeof result === 'number' && target && target !== pokemon && move.category !== 'Status') target.timesAttacked += move.hit > 0 ? move.hit : 1;
		return result;
	});
}

// ... and steals the target's raised stats before a move that takes them hits (Spectral Thief). The stages come off
// through the generation's own boostBy (generation 1 works its stats out again from it)
function stealBoosts(battle) {
	wrap(battle.actions, 'moveHit', 'steal', moveHit => function (target, pokemon, move, moveData, isSecondary, isSelf, ...rest) {
		const foe = Array.isArray(target) ? target[0] : target;
		if (!isSecondary && !isSelf && move?.stealsBoosts && !move.laterStole && foe && foe !== pokemon && later(battle, move)) {
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
		}
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
// generations' own Hidden Power and Weather Ball do
function modifyMove(battle) {
	battle.onEvent('ModifyMove', battle.format, 1, function (move, pokemon, target) {
		const type = move.type;
		if (later(this, move) && move.onModifyType) guarded(this, `${move.id} type`, () => move.onModifyType.call(this, move, pokemon, target));
		if (move.id !== 'struggle' && (pokemon.volatiles['electrify'] || (move.type === 'Normal' && this.field.pseudoWeather['iondeluge']))) move.type = 'Electric';
		if (move.type !== type && move.category !== 'Status') move.category = SPECIAL_TYPES.has(move.type) ? 'Special' : 'Physical';
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
	battle.onEvent('BasePower', battle.format, 1, function (power, attacker, defender, move) {
		let out;
		if (later(this, move) && move.onBasePower) out = guarded(this, `${move.id} power`, () => move.onBasePower.call(this, power, attacker, defender, move));
		if (defender?.side.sideConditions['auroraveil'] && !defender.getMoveHitData(move).crit
			&& !defender.volatiles[move.category === 'Physical' ? 'reflect' : 'lightscreen']) this.chainModify(0.5);
		for (const id of Object.keys(defender?.volatiles ?? {})) {
			const effect = this.dex.conditions.get(id);
			if (!effect.onSourceModifyDamage || !(later(this, move) || later(this, this.dex.moves.get(id)))) continue;
			guarded(this, `${id} damage`, () => effect.onSourceModifyDamage.call(this, power, attacker, defender, move));
		}
		return out;
	});
}

// Generation 1 has no ModifyAccuracy step: a later field effect's change (Gravity) is made in its Accuracy event
function accuracyGen1(battle) {
	battle.onEvent('Accuracy', battle.format, TIE_FREE, function (accuracy, target, source, move) {
		if (typeof accuracy !== 'number') return;
		for (const id of Object.keys(this.field.pseudoWeather)) {
			const effect = this.dex.conditions.get(id);
			if (effect.onModifyAccuracy && later(this, this.dex.moves.get(id))) guarded(this, `${id} accuracy`, () => effect.onModifyAccuracy.call(this, accuracy, target, source, move));
		}
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
	battle.onEvent('TryMove', battle.format, 1, function (pokemon, target, move) {
		if (!later(this, move) || !move.onPrepareHit) return;
		const result = guarded(this, `${move.id} prepare`, () => this.singleEvent('PrepareHit', move, {}, target, pokemon, move));
		if (result || result === undefined) return;
		if (result === false) this.add('-fail', pokemon);
		return null;
	});
}

// Generation 1 runs AfterMove without the move's own handler (Sparkling Aria, Spit Up, Beak Blast...)
function afterMove(battle) {
	battle.onEvent('AfterMove', battle.format, 1, function (pokemon, target, move) {
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
//   a later move that writes stats or stages directly (Speed Swap, Power Trick, Heart Swap, Topsy-Turvy, Psych Up,
//   Baton Pass) or burns or paralyses through its own code (Beak Blast, Dire Claw) gets them worked out again
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
	const started = new Map(), struck = new Map();
	let laterRan = false;
	battle.onEvent('BeforeMove', battle.format, -100, function (pokemon, target, move) {
		started.set(pokemon, move);
	});
	// A Pokémon that comes in with passed stages (Baton Pass) gets them in its stats. Wrapped rather than a SwitchIn
	// handler: Pokémon coming in together sort the field's handlers, and a tie there takes a random number
	wrap(battle.actions, 'switchIn', 'passedStages', switchIn => function (pokemon, ...rest) {
		const result = switchIn.call(this, pokemon, ...rest);
		if (pokemon?.isActive && pokemon.modifiedStats) {
			for (const stat of RESTAT) if (pokemon.boosts[stat] && pokemon.modifiedStats[stat] === pokemon.storedStats[stat]) guarded(battle, 'passed stages', () => restat(pokemon, stat, 0));
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
		return result;
	});
	wrap(battle.actions, 'runMove', 'gen1', runMove => function (moveOrMoveName, pokemon, ...rest) {
		pokemon.activeMoveActions++;
		started.delete(pokemon);
		struck.delete(pokemon);
		laterRan = false;
		const active = battle.getAllActive();
		// Only where later code was at work (a later move used, or a later volatile out such as Beak Blast's): the
		// generation's own moves keep their own stats rules (Transform copies the stats in use)
		const watched = active.some(p => Object.keys(p.volatiles).some(id => later(battle, battle.dex.moves.get(id))));
		const before = new Map(active.map(p => [p, { stored: { ...p.storedStats }, boosts: { ...p.boosts }, status: p.status, modified: { ...p.modifiedStats } }]));
		const locked = pokemon.volatiles['twoturnmove'], attacking = locked && charging(locked.move) ? locked.move : null;
		const result = attacking ? withoutPP(pokemon, () => runMove.call(this, moveOrMoveName, pokemon, ...rest)) : runMove.call(this, moveOrMoveName, pokemon, ...rest);
		if (laterRan || watched) guarded(battle, 'stats', () => restatAll(before));
		const move = started.get(pokemon);
		started.delete(pokemon);
		// A move it could not use, or one that missed or failed, counts as failed (Stomping Tantrum); one that worked is
		// the turn's last (Fusion Flare)
		if (!move) pokemon.moveThisTurnResult = false;
		else if (struck.has(pokemon)) {
			const worked = struck.get(pokemon) !== false;
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

// Generation 1's own boostBy rule: the stat from the stored one and the stage, 999 at most when the stage went up
function restat(pokemon, stat, stageBefore) {
	const stage = pokemon.boosts[stat];
	pokemon.modifiedStats[stat] = pokemon.storedStats[stat];
	pokemon.modifyStat(stat, stage >= 0 ? STAGE_UP[stage] : STAGE_DOWN[-stage] / 100);
	if (stage > stageBefore && pokemon.modifiedStats[stat] > 999) pokemon.modifiedStats[stat] = 999;
}

function restatAll(before) {
	for (const [pokemon, was] of before) {
		if (!pokemon.isActive || pokemon.fainted || !pokemon.modifiedStats) continue;
		for (const stat of RESTAT) {
			if (pokemon.storedStats[stat] !== was.stored[stat] || pokemon.boosts[stat] !== was.boosts[stat]) restat(pokemon, stat, was.boosts[stat]);
		}
		if (pokemon.status === was.status) continue;
		if (pokemon.status === 'brn' && pokemon.modifiedStats.atk >= was.modified.atk) pokemon.modifyStat('atk', 0.5);
		if (pokemon.status === 'par' && pokemon.modifiedStats.spe >= was.modified.spe) pokemon.modifyStat('spe', 0.25);
	}
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
		const [result, refused] = watchRefusal(battle, data, run);
		if (refused) {
			move.laterRefused = true;
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

const ACCURACY_STAGES = [1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];
function rollsHit(battle, pokemon, target, move) {
	let accuracy = move.accuracy;
	if (accuracy === true) return true;
	const ratio = stage => (stage >= 0 ? ACCURACY_STAGES[stage] : 1 / ACCURACY_STAGES[-stage]);
	if (!move.ignoreAccuracy) accuracy *= ratio(battle.clampIntRange(pokemon.boosts.accuracy, -6, 6));
	if (!move.ignoreEvasion) accuracy /= ratio(battle.clampIntRange(target.boosts.evasion, -6, 6));
	return battle.randomChance(Math.max(0, Math.min(100, Math.floor(accuracy))), 100);
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
		}
		if (gen === 2 && SCREEN_OF[atkType] && source.side !== target.side) put(holder(source), SCREEN_OF[atkType], undefined);
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
