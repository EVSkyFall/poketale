export const norm = s => String(s ?? '').normalize('NFKC').replace(/♀/g, 'f').replace(/♂/g, 'm').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export const foldNorm = s => norm(String(s ?? '').normalize('NFD').replace(/\p{M}/gu, ''));

export const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
