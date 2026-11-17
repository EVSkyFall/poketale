// Moves from later generations in an older generation's battle. Showdown's older battle code never had such moves and
// skips some of their own code: the events it does not run, the move effects its moveHit does not know. That code is run
// at the matching point, for later moves only (a generation's own moves stay as its code has them), so the move works
// as in its own generation, whatever the story's settings. Found by counting, in random battles with every move, which
// move and condition handlers each generation's battle code calls, then playing each gap.

const later = (battle, move) => !!move?.exists && move.gen > battle.gen;

// Moved code that throws leaves the battle going without that effect
function guarded(battle, label, run) {
	try {
		return run();
	} catch (error) {
		battle.debug(`later move code failed (${label}): ${error?.message ?? error}`);
		return undefined;
	}
}

export function runLaterMoves(battle) {
	const gen = battle.gen;
	if (!(gen < 9)) return;
	if (gen <= 3) modifyMove(battle);
	if (gen <= 2) {
		tailwindSpeed(battle);
		moveHitGaps(battle);
	}
	if (gen === 2) volatileAfterMove(battle);
	if (gen === 1) {
		basePower(battle);
		prepareHit(battle);
		afterMove(battle);
		twoTurnMoves(battle);
	}
}

// Generations 1-3 run ModifyMove but not ModifyType: a later move's own type (Weather Ball, Judgment, Tera Blast...),
// then Electrify's and Ion Deluge's Electric; generation 1 also has no ModifyCritRatio, so Laser Focus's sure hit
function modifyMove(battle) {
	const gen = battle.gen;
	battle.onEvent('ModifyMove', battle.format, 1, function (move, pokemon, target) {
		if (later(this, move) && move.onModifyType) guarded(this, `${move.id} type`, () => move.onModifyType.call(this, move, pokemon, target));
		if (move.id !== 'struggle' && (pokemon.volatiles['electrify'] || (move.type === 'Normal' && this.field.pseudoWeather['iondeluge']))) move.type = 'Electric';
		if (gen === 1 && pokemon.volatiles['laserfocus'] && move.category !== 'Status') move.willCrit = true;
	});
}

// Generation 1 runs BasePower without the move's own handler (Facade, Brine, Venoshock, Knock Off...). It has no final
// damage step either: Aurora Veil halves the power of hits that are not critical unless Reflect or Light Screen covers
// it, and Glaive Rush's user takes double until its next move
function basePower(battle) {
	battle.onEvent('BasePower', battle.format, 1, function (power, attacker, defender, move) {
		let out;
		if (later(this, move) && move.onBasePower) out = guarded(this, `${move.id} power`, () => move.onBasePower.call(this, power, attacker, defender, move));
		if (defender?.side.sideConditions['auroraveil'] && !defender.getMoveHitData(move).crit
			&& !defender.volatiles[move.category === 'Physical' ? 'reflect' : 'lightscreen']) this.chainModify(0.5);
		if (defender?.volatiles['glaiverush']) this.chainModify(2);
		return out;
	});
}

// Generation 2 runs only the move's own AfterMove: a later move's volatile that ends there (Charge, once an Electric move
// is used) gets it after the move
function volatileAfterMove(battle) {
	const { actions } = battle;
	const runMove = actions.runMove;
	if (runMove.laterMoves) return;
	const wrapped = function (moveOrMoveName, pokemon, ...rest) {
		const result = runMove.call(this, moveOrMoveName, pokemon, ...rest);
		if (!pokemon.moveThisTurn || pokemon.fainted) return result;
		const move = battle.dex.getActiveMove(pokemon.moveThisTurn);
		for (const [id, state] of Object.entries(pokemon.volatiles)) {
			const effect = battle.dex.conditions.get(id);
			if (!effect.onAfterMove || !later(battle, battle.dex.moves.get(id))) continue;
			guarded(battle, `${id} after move`, () => battle.singleEvent('AfterMove', effect, state, pokemon, null, move));
		}
		return result;
	};
	wrapped.laterMoves = true;
	actions.runMove = wrapped;
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

// Moves Encore does not lock in (generation 2's moveUsed)
const ENCORE_SKIPS = new Set(['metronome', 'mimic', 'mirrormove', 'sketch', 'sleeptalk', 'transform']);

// Generation 1 runs AfterMove without the move's own handler (Sparkling Aria, Spit Up, Beak Blast...). It also does not
// record the move Encore locks in, which only generation 2's Pokemon.moveUsed does; generation 1 plays generation 2's Encore
function afterMove(battle) {
	battle.onEvent('AfterMove', battle.format, 1, function (pokemon, target, move) {
		if (later(this, move) && move.onAfterMove) {
			// The older code keeps no list of the targets hit (Sparkling Aria reads it; what it does still needs the hit's mark)
			move.hitTargets ??= target ? [target] : [];
			guarded(this, `${move.id} after move`, () => move.onAfterMove.call(this, pokemon, target, move));
		}
		pokemon.lastMoveEncore = ENCORE_SKIPS.has(move.id) ? null : pokemon.lastMove;
	});
}

// Later two-turn moves (Bounce, Dive, Phantom Force, Meteor Beam...) count on twoturnmove adding the move's own volatile
// (their invulnerability, and the mark that the charge is done) and lasting two turns. Generation 1's twoturnmove does
// neither, so they charged again every turn, locked in. The charge adds the volatile; the attack ends the lock; a charge
// cut short (full paralysis clears twoturnmove) drops the volatile before the next move
function twoTurnMoves(battle) {
	const charging = (pokemon, move) => later(battle, move) && move.flags['charge'];
	battle.onEvent('ChargeMove', battle.format, 1, function (attacker, defender, move) {
		if (charging(attacker, move)) attacker.addVolatile(move.id, defender, move);
	});
	battle.onEvent('AfterMove', battle.format, 2, function (pokemon, target, move) {
		if (charging(pokemon, move) && pokemon.volatiles['twoturnmove']?.move === move.id && !pokemon.volatiles[move.id]) pokemon.removeVolatile('twoturnmove');
	});
	battle.onEvent('BeforeMove', battle.format, 1, function (pokemon) {
		if (pokemon.volatiles['twoturnmove']) return;
		for (const id of Object.keys(pokemon.volatiles)) if (charging(pokemon, this.dex.moves.get(id))) pokemon.removeVolatile(id);
	});
}

// Generations 1-2 work out speed without Tailwind's doubling; the turn order gets it, as Pokemon.getActionSpeed would
function tailwindSpeed(battle) {
	const getActionSpeed = battle.getActionSpeed;
	if (getActionSpeed.laterMoves) return;
	const wrapped = function (action) {
		getActionSpeed.call(this, action);
		const pokemon = action.pokemon;
		if (!pokemon?.side.sideConditions['tailwind'] || typeof action.speed !== 'number') return;
		const speed = pokemon.getStat('spe', false, false) * 2;
		if (action.choice === 'move' && action.fractionalPriority < 0) { action.speed = -speed; return; }
		action.speed = this.trunc(this.field.getPseudoWeather('trickroom') ? 10000 - speed : speed, 13);
	};
	wrapped.laterMoves = true;
	battle.getActionSpeed = wrapped;
}

// What generations 1-2's moveHit does not do for a later move: start a slot condition (Wish, Healing Wish, Lunar Dance),
// and in generation 1 run HitField (Perish Song, Court Change), HitSide (Quick Guard, Wide Guard) and AfterHit (Ceaseless
// Edge, Stone Axe, Mortal Spin, Ice Spinner)
function moveHitGaps(battle) {
	const { actions } = battle;
	const moveHit = actions.moveHit;
	if (moveHit.laterMoves) return;
	const gen = battle.gen;
	const wrapped = function (target, pokemon, move, moveData, isSecondary, isSelf) {
		const from = battle.log.length;
		const result = moveHit.call(this, target, pokemon, move, moveData, isSecondary, isSelf);
		if (isSecondary || isSelf || !later(battle, move)) return result;
		const data = moveData || move;
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
		if (!worked || result) return result;
		// The older code reported the move as doing nothing (generation 2: Wish) before its effect started here
		const fail = `|-fail|${target ?? pokemon}`;
		const at = battle.log.lastIndexOf(fail);
		if (at >= from) battle.log.splice(at, 1);
		return true;
	};
	wrapped.laterMoves = true;
	actions.moveHit = wrapped;
}
