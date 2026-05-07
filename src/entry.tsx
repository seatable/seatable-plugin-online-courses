import { createRoot } from 'react-dom/client';
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
    const container = document.querySelector('#plugin-wrapper') as HTMLElement;
    if (!container) return;

    const rootKey = '__audit_plugin_root';
    let root = (container as any)[rootKey];
    if (!root) {
      root = createRoot(container);
      (container as any)[rootKey] = root;
    }
    root.render(<App showDialog={true} key={Date.now()} />);
  },
};

export default SeaTablePlugin;

window.app.registerPluginItemCallback(info.name, SeaTablePlugin.execute);
