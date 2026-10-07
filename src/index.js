import { createRoot } from 'react-dom/client';
import DTable from 'dtable-sdk';
import App from './app.tsx';
import './setting.ts';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from './locale/index.ts';

let root = null;
let langRoot = null;
// Cached init promise so concurrent `execute()` calls share one in-flight init.
// Reset to null on failure so the next attempt actually retries. Holding the
// promise (rather than a plain "initialized" boolean flipped at start) avoids
// two failure modes: (a) flipping the flag early lets App mount against a
// missing `window.dtableSDK` if init throws mid-await; (b) flipping it late
// lets concurrent callers each spawn their own `new DTable()` +
// `syncWithServer()` in parallel, which duplicates network work and slows
// plugin open noticeably.
let initPromise = null;
let currentLang = DEFAULT_LOCALE;

class SeaTablePlugin {
  static init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const dtableSDK = new DTable();

        // local develop
        window.app = {};
        window.app.state = {};
        window.dtable = {
          ...window.dtablePluginConfig,
        };
        await dtableSDK.init(window.dtablePluginConfig);
        await dtableSDK.syncWithServer();

        window.app.collaborators = dtableSDK.dtableStore.collaborators;
        window.app.collaboratorsCache = {};
        window.app.state.collaborators = dtableSDK.dtableStore.collaborators;
        window.dtableWebAPI = dtableSDK.dtableWebAPI;
        window.app.onClosePlugin = SeaTablePlugin.onClosePlugin;
        window.dtableSDK = dtableSDK;
      } catch (err) {
        initPromise = null;
        throw err;
      }
    })();
    return initPromise;
  }

  static async execute(lang = currentLang) {
    await this.init();
    currentLang = lang;
    intl.init({ currentLocale: lang, fallbackLocale: 'en', locales: AVAILABLE_LOCALES });
    const rootElement = document.querySelector('#plugin-wrapper');
    if (!root) {
      root = createRoot(rootElement);
    }
    root.render(<App isDevelopment lang={lang} key={Date.now()} />);
  }

  static onClosePlugin() {
    const LanguageDropdown =
      require('./components/template-components/LanguageDropDown/index').default;
    const langDropElement = document.getElementById('language-dropdown');
    if (!langRoot) {
      langRoot = createRoot(langDropElement);
    }
    langRoot.render(
      <LanguageDropdown lang={currentLang} updateLanguageAndIntl={updateLanguageAndIntl} />
    );
  }
}

const updateLanguageAndIntl = (newLang) => {
  currentLang = newLang;
  // Re-open the plugin with the new language immediately
  SeaTablePlugin.execute(newLang);
};

SeaTablePlugin.execute();

const openBtn = document.getElementById('plugin-controller');
openBtn.addEventListener(
  'click',
  function () {
    SeaTablePlugin.execute();
  },
  false
);
