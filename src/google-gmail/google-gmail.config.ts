export interface GoogleGmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope: string;
  stateTtlMs: number;
  connectionId?: string;
  showTokens: boolean;
}
