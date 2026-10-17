export interface CodexConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  quotaUrl?: string;
  scope: string;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
  databasePath?: string;
  encryptionKey?: string;
  stateTtlMs: number;
}
