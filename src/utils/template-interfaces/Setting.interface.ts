export interface Config {
  APIToken: string;
  server: string;
  workspaceID: string;
  dtableName: string;
  lang: string;
  local?: any;
  loadVerbose?: boolean;
  // Optional, DEV ONLY. Some checks call account-level endpoints (e.g. listing the
  // base's automation rules) that inside a real base authenticate with the session
  // cookie — which never reaches the dev server, a different origin. Supply an
  // account token, or credentials to exchange for one.
  accountToken?: string;
  username?: string;
  password?: string;
}
