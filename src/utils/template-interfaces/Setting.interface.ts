export interface Config {
  APIToken: string;
  server: string;
  workspaceID: string;
  dtableName: string;
  lang: string;
  local?: any;
  loadVerbose?: boolean;
}
