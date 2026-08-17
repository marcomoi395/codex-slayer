export interface CodexConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope: string;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
  createAccountUrl: string;
  stateTtlMs: number;
}
