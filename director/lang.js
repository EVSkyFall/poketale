export const LANGS = Object.freeze(['ko', 'en']);
export const DEFAULT_LANG = 'ko';

export function checkLang(lang) {
  if (!LANGS.includes(lang)) throw new TypeError(`Unknown language: ${lang}`);
  return lang;
}
