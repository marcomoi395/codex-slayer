export interface GoogleGmailTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface GoogleGmailConnection {
  connectionId: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  emailAddress?: string;
}
export interface GoogleGmailTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  emailAddress?: string;
}

export interface GoogleGmailAuthorization {
  state: string;
  authorizationUrl: string;
  createdAt: number;
}
