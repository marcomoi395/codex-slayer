export const CODEX_QUOTA_DEFAULT_URL =
  'https://chatgpt.com/backend-api/wham/usage';

export type CodexQuotaClassification =
  | 'valid'
  | 'reauth-required'
  | 'indeterminate';

export interface CodexQuotaCredentials {
  accessToken: string;
  accountId?: string;
}

export interface CodexQuotaHttpClient {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface CodexQuotaClientOptions {
  url?: string;
  httpClient?: CodexQuotaHttpClient;
}

function isQuotaJson(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CodexQuotaClient {
  private readonly url: string;
  private readonly httpClient: CodexQuotaHttpClient;

  constructor(options: CodexQuotaClientOptions = {}) {
    this.url = options.url ?? CODEX_QUOTA_DEFAULT_URL;
    this.httpClient =
      options.httpClient ?? globalThis.fetch.bind(globalThis);
  }

  async classify(
    credentials: CodexQuotaCredentials,
  ): Promise<CodexQuotaClassification> {
    if (
      !credentials ||
      typeof credentials.accessToken !== 'string' ||
      !credentials.accessToken.trim()
    ) {
      return 'indeterminate';
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${credentials.accessToken}`,
    };
    if (
      typeof credentials.accountId === 'string' &&
      credentials.accountId.trim()
    ) {
      headers['ChatGPT-Account-ID'] = credentials.accountId;
    }

    try {
      const response = await this.httpClient(this.url, {
        method: 'GET',
        headers,
      });
      if (response.status === 401) return 'reauth-required';
      if (response.status < 200 || response.status >= 300) {
        return 'indeterminate';
      }

      const body: unknown = await response.json();
      return isQuotaJson(body) ? 'valid' : 'indeterminate';
    } catch {
      return 'indeterminate';
    }
  }
}
