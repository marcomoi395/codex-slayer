export interface GoogleGmailTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface GoogleGmailConnection {
  connectionId: string;
  scope?: string;
}
export interface GoogleGmailTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export interface GoogleGmailAuthorization {
  state: string;
  authorizationUrl: string;
  createdAt: number;
}
