import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { AccountVault } from '../src/codex/account-vault';

const encryptionKey = 'http-test-encryption-key';

describe('account vault API', () => {
  let app: INestApplication<App>;
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-vault-api-'));
    databasePath = join(directory, 'accounts.sqlite');
    process.env.CODEX_ENCRYPTION_KEY = encryptionKey;
    process.env.CODEX_DATABASE_PATH = databasePath;
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CODEX_ENCRYPTION_KEY;
    delete process.env.CODEX_DATABASE_PATH;
    await rm(directory, { recursive: true, force: true });
  });

  it('lists safe account metadata and deletes through HTTP', async () => {
    const vault = new AccountVault(databasePath, encryptionKey);
    const account = await vault.upsert({
      email: 'api@example.com',
      password: 'password-secret',
      totpSecret: 'totp-secret',
      accessToken: 'access-token',
    });
    vault.close();

    const listed = await request(app.getHttpServer())
      .get('/auth/codex/accounts')
      .expect(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        email: 'api@example.com',
        connectionId: account.connectionId,
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toMatch(
      /password-secret|totp-secret|access-token/,
    );

    await request(app.getHttpServer())
      .delete(`/auth/codex/accounts/${account.connectionId}`)
      .expect(200);
    const afterDeleteVault = new AccountVault(databasePath, encryptionKey);
    expect(await afterDeleteVault.list()).toEqual([]);
    afterDeleteVault.close();
  });

  it('rejects a callback with an unknown OAuth state', async () => {
    await request(app.getHttpServer())
      .get('/auth/codex/callback')
      .query({ code: 'fixture-code', state: 'unknown-state' })
      .expect(401);
    const status = await request(app.getHttpServer())
      .get('/auth/codex/status')
      .expect(200);
    expect(status.body).toMatchObject({ state: 'failed', active: false });
  });
});
