export function outcomeOf(result) {
  if (!result) return 'lose';
  if (result.captured) return 'capture';
  if (result.outcome === 'forfeit' || result.forfeited) return 'forfeit';
  if (result.outcome === 'run') return 'run';
  if (result.winner === 'p1') return 'win';
  return 'lose';
}

export const isLoss = result => ['lose', 'forfeit'].includes(outcomeOf(result));
