import { Config } from './utils/template-interfaces/Setting.interface';

/** (1/4) initialize config object */
let config: Config = {} as Config;

/** (2/4) load local development settings ./setting.local.js (if exist) */
try {
  config = require('./setting.local.js').default || {};
  if (config.loadVerbose) {
    console.info(
      '%c [SeaTable Plugin Development] Configuration merged with "./src/setting.local.js" (this message can be disabled by adding `loadVerbose: false` to the local development settings)',
      'color: #ff8000'
    );
    console.info(
      '%c [SeaTable Plugin Development] This is your config object:',
      'color: #ff8000',
      config
    );
  }
} catch (error) {
  console.error(
    '[SeaTable Plugin Development] Please create "./src/setting.local.js" (from `setting.local.dist.js`)'
  );
  throw error;
}

/** (3/4) remove server trailing slash(es) (if any, common configuration error)*/
if (config.server !== config.server.replace(/\/+$/, '')) {
  config.server = config.server.replace(/\/+$/, '');
}

/* (4/4) init window.dtablePluginConfig  */
window.dtablePluginConfig = config;
