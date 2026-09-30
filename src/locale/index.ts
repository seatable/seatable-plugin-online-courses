import { AvailableLocales } from '../utils/template-interfaces/App.interface';
import setting from '../setting.local';

const files = require.context('./lang', false, /\.json$/);

const AVAILABLE_LOCALES: AvailableLocales = files.keys().reduce((locales: any, key) => {
  const fileName = key.replace(/\.\/|\.json/g, '');
  locales[fileName] = files(key);
  return locales;
}, {});

// If the lang in setting.local.js is not set, then 'en' is the default language value
const DEFAULT_LOCALE = setting.lang || 'en';

export { AVAILABLE_LOCALES, DEFAULT_LOCALE };
