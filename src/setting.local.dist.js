/* 
local development settings
*/
export default {
  // server URL of the seatable server of the plugin (required)
  server: 'https://cloud.seatable.io',
  // name of the dtable to add the plugin to (required, dtable must exist under this name)
  dtableName: 'Default',
  // base api token (required)
  APIToken: '01ab23[...]45cd67',
  // id of the workspace with the dtable of the plugin (required, workspace must exist)
  workspaceID: '1',
  // account token, only needed for checks that read account-level data such as the
  // base's automation rules (in a real base the session cookie does this, but it
  // cannot reach the dev server). Either set it directly...
  // accountToken: '89ab[...]cdef',
  // ...or let the plugin obtain one from your credentials:
  // username: 'you@example.com',
  // password: '…',
  // default language of the plugin
  lang: 'en',
  // show verbose messages
  loadVerbose: true,
};
