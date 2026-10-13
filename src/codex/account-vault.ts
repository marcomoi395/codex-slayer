import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AccountVaultRecord {
  connectionId?: string;
  email: string;
  password: string;
  totpSecret?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export interface AccountVaultSummary {
  email: string;
  connectionId: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredAccount {
  connectionId: string;
  email: string;
  password: string;
  totpSecret: string | null;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  tokenType: string | null;
  createdAt: number;
  updatedAt: number;
}

export class AccountVault {
  private database?: DatabaseSync;
  private readonly key?: Buffer;

  constructor(
    private readonly databasePath: string,
    encryptionKey?: string,
  ) {
    if (encryptionKey?.trim()) {
      this.key = createHash('sha256').update(encryptionKey).digest();
    }
  }

  async upsert(record: AccountVaultRecord): Promise<AccountVaultSummary> {
    this.requireKey();
    const database = await this.getDatabase();
    const email = record.email.trim().toLowerCase();
    const now = Date.now();
    const connectionId = record.connectionId ?? randomBytes(16).toString('hex');
    const existing = database
      .prepare('SELECT connectionId, createdAt FROM accounts WHERE email = ?')
      .get(email) as { connectionId: string; createdAt: number } | undefined;
    const id = existing?.connectionId ?? connectionId;
    const createdAt = existing?.createdAt ?? now;
    database
      .prepare(
        `INSERT INTO accounts (
          connectionId, email, password, totpSecret, accessToken, refreshToken,
          idToken, expiresAt, scope, tokenType, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          connectionId = excluded.connectionId,
          password = excluded.password,
          totpSecret = excluded.totpSecret,
          accessToken = excluded.accessToken,
          refreshToken = excluded.refreshToken,
          idToken = excluded.idToken,
          expiresAt = excluded.expiresAt,
          scope = excluded.scope,
          tokenType = excluded.tokenType,
          updatedAt = excluded.updatedAt`,
      )
      .run(
        id,
        email,
        this.encrypt(record.password),
        record.totpSecret === undefined ? null : this.encrypt(record.totpSecret),
        this.encrypt(record.accessToken),
        record.refreshToken === undefined ? null : this.encrypt(record.refreshToken),
        record.idToken === undefined ? null : this.encrypt(record.idToken),
        record.expiresAt ?? null,
        record.scope ?? null,
        record.tokenType ?? null,
        createdAt,
        now,
      );
    return { email, connectionId: id, createdAt, updatedAt: now };
  }

  async list(): Promise<AccountVaultSummary[]> {
    this.requireKey();
    const database = await this.getDatabase();
    return database
      .prepare(
        'SELECT email, connectionId, createdAt, updatedAt FROM accounts ORDER BY email',
      )
      .all() as unknown as AccountVaultSummary[];
  }

  async delete(identifier: string): Promise<boolean> {
    this.requireKey();
    const database = await this.getDatabase();
    const result = database
      .prepare('DELETE FROM accounts WHERE connectionId = ? OR email = ?')
      .run(identifier, identifier.trim().toLowerCase());
    return result.changes > 0;
  }

  async get(connectionId: string): Promise<AccountVaultRecord | undefined> {
    this.requireKey();
    const database = await this.getDatabase();
    const stored = database
      .prepare('SELECT * FROM accounts WHERE connectionId = ?')
      .get(connectionId) as StoredAccount | undefined;
    if (!stored) return undefined;
    return {
      connectionId: stored.connectionId,
      email: stored.email,
      password: this.decrypt(stored.password),
      totpSecret: stored.totpSecret === null ? undefined : this.decrypt(stored.totpSecret),
      accessToken: this.decrypt(stored.accessToken),
      refreshToken:
        stored.refreshToken === null ? undefined : this.decrypt(stored.refreshToken),
      idToken: stored.idToken === null ? undefined : this.decrypt(stored.idToken),
      expiresAt: stored.expiresAt ?? undefined,
      scope: stored.scope ?? undefined,
      tokenType: stored.tokenType ?? undefined,
    };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private requireKey(): asserts this is this & { key: Buffer } {
    if (!this.key) {
      throw new Error('CODEX_ENCRYPTION_KEY is required to access the account vault');
    }
  }

  private async getDatabase(): Promise<DatabaseSync> {
    if (this.database) return this.database;
    await mkdir(dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        connectionId TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        totpSecret TEXT,
        accessToken TEXT NOT NULL,
        refreshToken TEXT,
        idToken TEXT,
        expiresAt INTEGER,
        scope TEXT,
        tokenType TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
    return this.database;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.');
  }

  private decrypt(value: string): string {
    const [iv, authTag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
