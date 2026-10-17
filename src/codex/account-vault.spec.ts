import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountVault } from './account-vault';

describe('AccountVault', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-vault-'));
    databasePath = join(directory, 'accounts.sqlite');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists encrypted records, upserts duplicate email, lists safe metadata, and deletes', async () => {
    const first = new AccountVault(databasePath, 'test-encryption-key');
    const created = await first.upsert({
      email: 'Operator@Example.com',
      password: 'password-secret',
      totpSecret: 'totp-secret',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: 'id-token',
    });
    const updated = await first.upsert({
      email: 'operator@example.com',
      password: 'new-password-secret',
      totpSecret: 'new-totp-secret',
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      idToken: 'new-id-token',
    });

    expect(updated.connectionId).toBe(created.connectionId);
    expect(await first.list()).toEqual([
      expect.objectContaining({
        email: 'operator@example.com',
        connectionId: created.connectionId,
      }),
    ]);
    const raw = await readFile(databasePath, 'utf8');
    for (const secret of [
      'new-password-secret',
      'new-totp-secret',
      'new-access-token',
      'new-refresh-token',
      'new-id-token',
    ]) {
      expect(raw).not.toContain(secret);
    }
    first.close();

    const restarted = new AccountVault(databasePath, 'test-encryption-key');
    expect(await restarted.get(created.connectionId)).toEqual(
      expect.objectContaining({
        email: 'operator@example.com',
        password: 'new-password-secret',
        totpSecret: 'new-totp-secret',
        accessToken: 'new-access-token',
      }),
    );
    expect(await restarted.delete(created.connectionId)).toBe(true);
    expect(await restarted.list()).toEqual([]);
    restarted.close();
  });

  it('saves pending credentials, lists safe status, and reads credentials for a batch', async () => {
    const vault = new AccountVault(databasePath, 'test-encryption-key');
    const saved = await vault.upsert({
      email: ' Pending@Example.com ',
      password: 'pending-password',
      totpSecret: 'pending-totp',
    });

    expect(saved.status).toBe('pending');
    expect(await vault.list()).toEqual([
      expect.objectContaining({
        email: 'pending@example.com',
        connectionId: saved.connectionId,
        status: 'pending',
      }),
    ]);
    expect(JSON.stringify(await vault.list())).not.toContain('pending-password');
    expect(await vault.listCredentials(50)).toEqual([
      expect.objectContaining({
        connectionId: saved.connectionId,
        email: 'pending@example.com',
        password: 'pending-password',
        totpSecret: 'pending-totp',
        accessToken: undefined,
      }),
    ]);

    const authenticated = await vault.upsert({
      email: 'PENDING@example.com',
      password: 'updated-password',
      totpSecret: 'updated-totp',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(authenticated).toEqual(
      expect.objectContaining({
        connectionId: saved.connectionId,
        status: 'authenticated',
      }),
    );
    expect(await vault.get(saved.connectionId)).toEqual(
      expect.objectContaining({
        email: 'pending@example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    );
    vault.close();
  });

  it('retains access, refresh, and ID tokens during a credential-only upsert', async () => {
    const vault = new AccountVault(databasePath, 'test-encryption-key');
    await vault.upsert({
      email: 'reauth@example.com',
      password: 'old-password',
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      idToken: 'old-id-token',
      expiresAt: 1234,
      scope: 'offline_access',
      tokenType: 'Bearer',
    });

    await vault.upsert({
      email: 'reauth@example.com',
      password: 'new-password',
    });

    expect(await vault.listCredentials()).toEqual([
      expect.objectContaining({
        password: 'new-password',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        idToken: 'old-id-token',
        expiresAt: 1234,
        scope: 'offline_access',
        tokenType: 'Bearer',
      }),
    ]);
    vault.close();
  });

  it('rejects vault access without an encryption key', async () => {
    const vault = new AccountVault(databasePath);
    await expect(vault.list()).rejects.toThrow(
      'CODEX_ENCRYPTION_KEY is required',
    );
    vault.close();
  });
});
