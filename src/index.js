import ReactDOM from 'react-dom';
import DTable from 'dtable-sdk';
import App from './app.tsx';
import './setting.ts';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from './locale/index.ts';

class SeaTablePlugin {
  static async init() {
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
  }

  static async execute(lang = DEFAULT_LOCALE) {
    await this.init();
    intl.init({ currentLocale: lang, locales: AVAILABLE_LOCALES });
    const rootElement = document.getElementById('plugin-wrapper');
    ReactDOM.unmountComponentAtNode(rootElement);
    ReactDOM.render(<App isDevelopment lang={lang} />, rootElement);
    const langDropElement = document.getElementById('language-dropdown');
    ReactDOM.unmountComponentAtNode(langDropElement);
  }

  static onClosePlugin(lang) {
    const LanguageDropdown =
      require('./components/template-components/LanguageDropDown/index').default;
    const langDropElement = document.getElementById('language-dropdown');

    ReactDOM.render(
      <LanguageDropdown lang={lang} updateLanguageAndIntl={updateLanguageAndIntl} />,
      langDropElement
    );

    ReactDOM.unmountComponentAtNode(document.getElementById('plugin-controller'));
  }
}

SeaTablePlugin.execute();

const openBtn = document.getElementById('plugin-controller');
let lang;

const updateLanguageAndIntl = (newLang) => {
  lang = newLang;
};
openBtn.addEventListener(
  'click',
  function () {
    SeaTablePlugin.execute(lang);
  },
  false
);
