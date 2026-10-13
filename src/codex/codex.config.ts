export interface CodexConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope: string;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
  accountsFile: string;
  databasePath?: string;
  encryptionKey?: string;
  stateTtlMs: number;
}
