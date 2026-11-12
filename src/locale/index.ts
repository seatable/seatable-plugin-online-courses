import { AvailableLocales } from '../utils/template-interfaces/App.interface';

const files = require.context('./lang', false, /\.json$/);

const AVAILABLE_LOCALES: AvailableLocales = files.keys().reduce((locales: any, key) => {
  const fileName = key.replace(/\.\/|\.json/g, '');
  locales[fileName] = files(key);
  return locales;
}, {});

// English unless the dev harness asks otherwise (`lang` in setting.local.js, which
// only the dev entry loads, as window.dtablePluginConfig). The production bundle must
// not import that file: it is git-ignored, so a fresh clone could not build, and the
// zip would default to whatever language its builder had set locally.
const DEFAULT_LOCALE: string = (window as any).dtablePluginConfig?.lang || 'en';

/**
 * The locale file for the language SeaTable reports, matched loosely: SeaTable's codes
 * (`zh-cn`, possibly `pt-br`) do not always spell the file names (`zh_CN`, `pt`), and an
 * exact match would silently fall back to English. Case and `-`/`_` are ignored, then the
 * bare language is tried. The interface (entry.tsx) and the course texts (courseTexts.ts)
 * both go through here, so they always agree on the language.
 */
function resolveLocale(lang?: string | null): string {
  if (!lang) return DEFAULT_LOCALE;
  const names = Object.keys(AVAILABLE_LOCALES);
  const wanted = lang.replace(/-/g, '_').toLowerCase();
  return (
    names.find((name) => name.toLowerCase() === wanted) ||
    names.find((name) => name.toLowerCase() === wanted.split('_')[0]) ||
    DEFAULT_LOCALE
  );
}

export { AVAILABLE_LOCALES, DEFAULT_LOCALE, resolveLocale };
