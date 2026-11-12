import intl from 'react-intl-universal';
import info from '../../plugin-config/info.json';
import { AppIsShowState } from '../template-interfaces/App.interface';

/**
 * The key the plugin's settings are stored under in the base. It is ALSO an
 * identifier, not a label: changing it would orphan every base's progress. Always the
 * English name, whatever the interface language — pluginDisplayName() is the one shown.
 */
const PLUGIN_NAME: string = info.display_name.en;

/**
 * The plugin's name in the interface language (info.json's `display_name`, the same
 * names SeaTable shows in its plugin list). Call it at render time: the locale is set
 * in entry.tsx, after the modules are evaluated.
 */
function pluginDisplayName(): string {
  const names = info.display_name as Record<string, string>;
  const lang = String(intl.getInitOptions().currentLocale || 'en')
    .replace(/_/g, '-')
    .toLowerCase();
  return names[lang] ?? names[lang.split('-')[0]] ?? names.en;
}

// Initial App State
const INITIAL_IS_SHOW_STATE: AppIsShowState = {
  isShowPlugin: true,
  isLoading: true,
  isShowPresets: true,
};

export { PLUGIN_NAME, pluginDisplayName, INITIAL_IS_SHOW_STATE };
