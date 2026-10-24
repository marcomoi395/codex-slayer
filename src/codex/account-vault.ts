import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AccountVaultRecord {
  connectionId?: string;
  email: string;
  password: string;
  totpSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export type AccountVaultStatus = 'pending' | 'authenticated';

export interface AccountVaultSummary {
  email: string;
  connectionId: string;
  status: AccountVaultStatus;
  createdAt: number;
  updatedAt: number;
}

interface StoredAccount {
  connectionId: string;
  email: string;
  password: string;
  totpSecret: string | null;
  accessToken: string | null;
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
      .prepare('SELECT connectionId, createdAt, accessToken FROM accounts WHERE email = ?')
      .get(email) as
      | { connectionId: string; createdAt: number; accessToken: string | null }
      | undefined;
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
          accessToken = COALESCE(excluded.accessToken, accounts.accessToken),
          refreshToken = COALESCE(excluded.refreshToken, accounts.refreshToken),
          idToken = COALESCE(excluded.idToken, accounts.idToken),
          expiresAt = COALESCE(excluded.expiresAt, accounts.expiresAt),
          scope = COALESCE(excluded.scope, accounts.scope),
          tokenType = COALESCE(excluded.tokenType, accounts.tokenType),
          updatedAt = excluded.updatedAt`,
      )
      .run(
        id,
        email,
        this.encrypt(record.password),
        record.totpSecret === undefined
          ? null
          : this.encrypt(record.totpSecret),
        record.accessToken === undefined
          ? null
          : this.encrypt(record.accessToken),
        record.refreshToken === undefined
          ? null
          : this.encrypt(record.refreshToken),
        record.idToken === undefined ? null : this.encrypt(record.idToken),
        record.expiresAt ?? null,
        record.scope ?? null,
        record.tokenType ?? null,
        createdAt,
        now,
      );
    return {
      email,
      connectionId: id,
      status:
        record.accessToken !== undefined || Boolean(existing?.accessToken)
          ? 'authenticated'
          : 'pending',
      createdAt,
      updatedAt: now,
    };
  }

  async list(): Promise<AccountVaultSummary[]> {
    this.requireKey();
    const database = await this.getDatabase();
    return database
      .prepare(
        `SELECT email, connectionId,
          CASE WHEN accessToken IS NULL THEN 'pending' ELSE 'authenticated' END AS status,
          createdAt, updatedAt
        FROM accounts ORDER BY email`,
      )
      .all() as unknown as AccountVaultSummary[];
  }

  async listCredentials(limit?: number): Promise<AccountVaultRecord[]> {
    this.requireKey();
    const database = await this.getDatabase();
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 0)
    ) {
      throw new RangeError('Account batch size must be a non-negative integer');
    }
    const statement =
      limit === undefined
        ? database.prepare('SELECT * FROM accounts ORDER BY email')
        : database.prepare(
            'SELECT * FROM accounts ORDER BY email LIMIT ?',
          );
    const rows = (limit === undefined
      ? statement.all()
      : statement.all(limit)) as unknown as StoredAccount[];
    return rows.map((stored) => this.toRecord(stored));
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
    return stored ? this.toRecord(stored) : undefined;
  }

  private toRecord(stored: StoredAccount): AccountVaultRecord {
    return {
      connectionId: stored.connectionId,
      email: stored.email,
      password: this.decrypt(stored.password),
      totpSecret:
        stored.totpSecret === null
          ? undefined
          : this.decrypt(stored.totpSecret),
      accessToken:
        stored.accessToken === null
          ? undefined
          : this.decrypt(stored.accessToken),
      refreshToken:
        stored.refreshToken === null
          ? undefined
          : this.decrypt(stored.refreshToken),
      idToken:
        stored.idToken === null ? undefined : this.decrypt(stored.idToken),
      expiresAt: stored.expiresAt ?? undefined,
      scope: stored.scope ?? undefined,
      tokenType: stored.tokenType ?? undefined,
    };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private requireKey(): Buffer {
    if (!this.key)
      throw new Error(
        'CODEX_ENCRYPTION_KEY is required to access the account vault',
      );
    return this.key;
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
        accessToken TEXT,
        refreshToken TEXT,
        idToken TEXT,
        expiresAt INTEGER,
        scope TEXT,
        tokenType TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
    const columns = this.database
      .prepare('PRAGMA table_info(accounts)')
      .all();
    const accessTokenRequired = columns.some(
      (column) =>
        column &&
        typeof column === 'object' &&
        'name' in column &&
        column.name === 'accessToken' &&
        'notnull' in column &&
        column.notnull === 1,
    );
    if (accessTokenRequired) this.migrateLegacySchema(this.database);
    return this.database;
  }

  private migrateLegacySchema(database: DatabaseSync): void {
    database.exec(`
      BEGIN;
      ALTER TABLE accounts RENAME TO accounts_legacy;
      CREATE TABLE accounts (
        connectionId TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        totpSecret TEXT,
        accessToken TEXT,
        refreshToken TEXT,
        idToken TEXT,
        expiresAt INTEGER,
        scope TEXT,
        tokenType TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      INSERT INTO accounts (
        connectionId, email, password, totpSecret, accessToken, refreshToken,
        idToken, expiresAt, scope, tokenType, createdAt, updatedAt
      )
      SELECT connectionId, email, password, totpSecret, accessToken, refreshToken,
        idToken, expiresAt, scope, tokenType, createdAt, updatedAt
      FROM accounts_legacy;
      DROP TABLE accounts_legacy;
      COMMIT;
    `);
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.');
  }

  private decrypt(value: string): string {
    const [iv, authTag, ciphertext] = value
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
