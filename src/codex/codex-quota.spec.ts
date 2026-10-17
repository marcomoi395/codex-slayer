import {
  CODEX_QUOTA_DEFAULT_URL,
  CodexQuotaClient,
  type CodexQuotaHttpClient,
} from './codex-quota';

describe('CodexQuotaClient', () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let client: CodexQuotaClient;

  beforeEach(() => {
    requests.length = 0;
    const httpClient: CodexQuotaHttpClient = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ plan: { usage: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    client = new CodexQuotaClient({ httpClient });
  });

  it('accepts a successful quota response and sends bearer/account headers', async () => {
    await expect(
      client.classify({ accessToken: 'access-token', accountId: 'account-id' }),
    ).resolves.toBe('valid');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: CODEX_QUOTA_DEFAULT_URL,
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-ID': 'account-id',
        },
      },
    });
  });

  it('omits the account header when no account ID is available', async () => {
    await client.classify({ accessToken: 'access-token' });

    expect(requests[0]?.init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer access-token',
    });
  });

  it('classifies HTTP 401 as reauth-required', async () => {
    client = new CodexQuotaClient({
      httpClient: async () => new Response('unauthorized', { status: 401 }),
    });

    await expect(client.classify({ accessToken: 'access-token' })).resolves.toBe(
      'reauth-required',
    );
  });

  it.each([403, 429, 500])(
    'classifies HTTP %s as indeterminate',
    async (status) => {
      client = new CodexQuotaClient({
        httpClient: async () => new Response('failure', { status }),
      });

      await expect(
        client.classify({ accessToken: 'access-token' }),
      ).resolves.toBe('indeterminate');
    },
  );

  it('classifies malformed success JSON as indeterminate', async () => {
    client = new CodexQuotaClient({
      httpClient: async () => new Response('{not-json', { status: 200 }),
    });

    await expect(client.classify({ accessToken: 'access-token' })).resolves.toBe(
      'indeterminate',
    );
  });

  it('classifies network failures as indeterminate without exposing credentials', async () => {
    const accessToken = 'super-secret-access-token';
    const error = new Error(`request failed for ${accessToken}`);
    client = new CodexQuotaClient({
      httpClient: async () => {
        throw error;
      },
    });

    await expect(client.classify({ accessToken })).resolves.toBe('indeterminate');
  });

  it('uses a configured URL', async () => {
    const url = 'https://quota.example.test/usage';
    client = new CodexQuotaClient({ url });

    await client.classify({ accessToken: 'access-token' });

    expect(requests[0]?.url).toBe(url);
  });
});
