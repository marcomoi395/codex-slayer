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

  it('rejects vault access without an encryption key', async () => {
    const vault = new AccountVault(databasePath);
    await expect(vault.list()).rejects.toThrow(
      'CODEX_ENCRYPTION_KEY is required',
    );
    vault.close();
  });
});
