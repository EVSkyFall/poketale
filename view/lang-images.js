export function langPath(path, lang) {
  if (lang === 'ko' || !/_ko\.(png|json)$/.test(path)) return path;
  return path.replace('/text_images/ko/', `/text_images/${lang}/`).replace(/_ko\.(png|json)$/, `${lang === 'en' ? '' : `_${lang}`}.$1`);
}

export const langAtlasKey = (key, lang) => (lang === 'ko' ? key : `${key}@${lang}`);
