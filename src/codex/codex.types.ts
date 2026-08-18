export interface CodexAuthorization {
  state: string;
  authorizationUrl: string;
  createdAt: number;
}

export interface CodexTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface CodexConnection {
  connectionId: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export interface CodexStartResponse extends CodexAuthorization {
  callbackUrl: string;
  browserUrl: string;
}

export interface CodexAccountRequest {
  email: string;
  password: string;
}
export interface CodexAccountSummary {
  email: string;
  connectionId?: string;
}

export interface CodexStatusLog {
  at: number;
  message: string;
  level?: string;
}

export interface CodexStatus {
  active: boolean;
  state?: string;
  email?: string;
  step?: string;
  logs: CodexStatusLog[];
}
