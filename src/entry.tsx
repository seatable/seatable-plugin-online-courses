import ReactDOM from 'react-dom';
import App from './app';
import info from './plugin-config/info.json';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from './locale';
import intl from 'react-intl-universal';

const SeaTablePlugin = {
  execute: () => {
    let lang =
      window.dtable && Object.keys(AVAILABLE_LOCALES).includes(window.dtable.lang)
        ? window.dtable.lang
        : DEFAULT_LOCALE;
    intl.init({ currentLocale: lang, locales: AVAILABLE_LOCALES });
    ReactDOM.render(<App showDialog={true} />, document.querySelector('#plugin-wrapper'));
  },
};

export default SeaTablePlugin;

window.app.registerPluginItemCallback(info.name, SeaTablePlugin.execute);
