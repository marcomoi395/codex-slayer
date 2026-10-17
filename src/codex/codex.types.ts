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

export interface CodexCallbackResponse {
  ok: true;
  email?: string;
  connectionId?: string;
}

export interface CodexAccountRequest {
  email: string;
  password: string;
  totpSecret?: string;
}

export interface CodexAccountSummary {
  email: string;
  connectionId?: string;
  status: 'pending' | 'authenticated';
  createdAt?: number;
  updatedAt?: number;
}

export type CodexBatchAccountOutcome =
  | 'authenticated'
  | 'skipped'
  | 'indeterminate'
  | 'failed';

export interface CodexBatchAccountResult {
  email: string;
  outcome: CodexBatchAccountOutcome;
  reason?: string;
}

export interface CodexBatchResult {
  total: number;
  completed: number;
  authenticated: number;
  skipped: number;
  indeterminate: number;
  failed: number;
  accounts: CodexBatchAccountResult[];
}

export interface CodexBatchStatus extends CodexBatchResult {
  active: boolean;
  currentEmail?: string;
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
  batch?: CodexBatchStatus;
  logs: CodexStatusLog[];
}
