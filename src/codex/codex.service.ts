import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Browser, Locator, Page } from 'playwright-core';

import { AccountVault } from './account-vault';
import { CODEX_CONFIG } from './codex.constants';
import type { CodexConfig } from './codex.config';
import type {
  CodexAccountRequest,
  CodexAccountSummary,
  CodexAuthorization,
  CodexCallbackResponse,
  CodexConnection,
  CodexStatus,
  CodexTokenResponse,
} from './codex.types';

interface PendingAuthorization extends CodexAuthorization {
  codeVerifier: string;
  redirectUri: string;
  email?: string;
  password?: string;
  totpSecret?: string;
}

type BrowserRoute =
  | 'email'
  | 'password'
  | 'totp'
  | 'consent'
  | 'email-verification'
  | 'phone-verification'
  | 'captcha'
  | 'onboarding'
  | 'unsupported';

const MANUAL_STEP_MESSAGE =
  'Codex requires a manual security step (CAPTCHA or email/phone verification). Complete it manually, then retry.';

@Injectable()
export class CodexService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly accountVault: AccountVault;
  private status: CodexStatus = { active: false, logs: [] };
  private browser?: Browser;
  private callbackServer?: Server;

  constructor(@Inject(CODEX_CONFIG) private readonly config: CodexConfig) {
    this.accountVault = new AccountVault(
      config.databasePath ?? 'codex-accounts.sqlite',
      config.encryptionKey,
    );
  }

  getStatus(): CodexStatus {
    return {
      ...this.status,
      logs: this.status.logs.map((log) => ({ ...log })),
    };
  }

  getAccounts(): Promise<CodexAccountSummary[]> {
    return this.accountVault.list();
  }

  async deleteAccount(connectionId: string): Promise<void> {
    if (!connectionId || !(await this.accountVault.delete(connectionId))) {
      throw new BadRequestException('Codex account was not found');
    }
  }

  async startAccountFlow(
    credentials: CodexAccountRequest,
  ): Promise<{ started: true }> {
    this.validateAccountCredentials(credentials);
    if (this.pending.size > 0 || this.status.active) {
      throw new BadRequestException('A Codex login flow is already active');
    }

    let authorization: CodexAuthorization | undefined;
    try {
      this.updateStatus('validating', {
        active: true,
        email: credentials.email.trim().toLowerCase(),
        step: 'credentials',
        message: 'Validating Codex account credentials',
      });
      authorization = await this.createAuthorizationLink(credentials.email);

      const pending = this.pending.get(authorization.state);
      if (!pending) throw new Error('Authorization state was not created');
      pending.password = credentials.password;
      pending.totpSecret = credentials.totpSecret;

      await this.openBrowser(authorization.authorizationUrl, credentials);
      this.updateStatus('awaiting_callback', {
        step: 'callback',
        message: 'Waiting for Codex authorization callback',
      });
      return { started: true };
    } catch (error) {
      if (authorization) this.pending.delete(authorization.state);
      await this.closeBrowser();
      await this.closeCallbackServer();
      this.updateStatus('failed', {
        active: false,
        step: 'start',
        level: 'error',
        message: this.safeFailureMessage(error),
      });
      throw error;
    }
  }

  private async createAuthorizationLink(email?: string): Promise<CodexAuthorization> {
    if (this.pending.size > 0 || this.callbackServer || (this.status.active && this.status.state !== 'validating')) {
      throw new BadRequestException('A Codex authorization flow is already active');
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    try {
      await this.startCallbackServer();
    } catch {
      await this.closeCallbackServer();
      throw new ServiceUnavailableException('Unable to start the OAuth callback server');
    }
    const redirectUri = this.getRedirectUri();
    const createdAt = Date.now();
    const authorizationUrl = this.buildAuthorizationUrl(
      redirectUri,
      state,
      codeChallenge,
    );

    this.pending.set(state, {
      state,
      authorizationUrl,
      createdAt,
      codeVerifier,
      redirectUri,
      email: email?.trim().toLowerCase(),
    });

    this.updateStatus('authorization_created', {
      active: true,
      email: email?.trim().toLowerCase(),
      step: 'authorization',
      message: 'Codex authorization flow created',
    });
    return { state, authorizationUrl, createdAt };
  }

  async handleCallback(
    code?: string,
    state?: string,
    error?: string,
  ): Promise<CodexCallbackResponse> {
    if (error) {
      if (state) this.pending.delete(state);
      await this.failCallback('Codex authorization was denied');
      throw new UnauthorizedException('Codex authorization failed');
    }
    if (!code || !state) {
      if (state) this.pending.delete(state);
      await this.failCallback('Codex authorization callback was incomplete');
      throw new BadRequestException('Codex callback requires code and state');
    }

    const session = this.pending.get(state);
    if (!session || Date.now() - session.createdAt > this.config.stateTtlMs) {
      if (session) this.pending.delete(state);
      await this.failCallback('Codex authorization state was invalid or expired');
      throw new UnauthorizedException('Codex OAuth state is invalid or expired');
    }

    try {
      this.updateStatus('exchanging_token', {
        email: session.email,
        step: 'callback',
        message: 'Exchanging Codex authorization code',
      });
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          code,
          redirect_uri: session.redirectUri,
          code_verifier: session.codeVerifier,
        }),
      });
      if (!response.ok) throw new UnauthorizedException('Codex token exchange failed');

      const token = await this.parseTokenResponse(response);
      const connection: CodexConnection = {
        connectionId: randomUUID(),
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        idToken: token.id_token,
        expiresIn: token.expires_in,
        expiresAt: token.expires_in
          ? Date.now() + token.expires_in * 1000
          : undefined,
        scope: token.scope,
        tokenType: token.token_type,
      };
      if (session.email && session.password !== undefined) {
        await this.saveConnection(connection, session);
      }
      const account = session.email
        ? (await this.accountVault.list()).find((item) => item.email === session.email)
        : undefined;
      this.pending.delete(state);
      this.updateStatus('completed', {
        active: false,
        email: session.email,
        step: 'callback',
        message: 'Codex account authorization completed',
      });
      return {
        ok: true,
        email: session.email,
        connectionId: account?.connectionId,
      };
    } catch (callbackError) {
      this.pending.delete(state);
      this.updateStatus('failed', {
        active: false,
        email: session.email,
        step: 'callback',
        level: 'error',
        message: 'Codex account authorization failed',
      });
      throw callbackError;
    } finally {
      await this.closeBrowser();
      await this.closeCallbackServer();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
    await this.closeCallbackServer();
    this.pending.clear();
    this.accountVault.close();
  }

  private async saveConnection(
    connection: CodexConnection,
    session: PendingAuthorization,
  ): Promise<void> {
    await this.accountVault.upsert({
      connectionId: connection.connectionId,
      email: session.email!,
      password: session.password!,
      totpSecret: session.totpSecret,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      scope: connection.scope,
      tokenType: connection.tokenType,
    });
    session.password = undefined;
    session.totpSecret = undefined;
  }

  private validateAccountCredentials(credentials: CodexAccountRequest): void {
    if (
      !credentials ||
      typeof credentials.email !== 'string' ||
      !/^\S+@\S+\.\S+$/.test(credentials.email.trim()) ||
      typeof credentials.password !== 'string' ||
      !credentials.password ||
      typeof credentials.totpSecret !== 'string' ||
      !credentials.totpSecret.trim()
    ) {
      throw new BadRequestException('Email, password and TOTP secret are required');
    }
    const normalizedTotp = credentials.totpSecret.replace(/[\s-]/g, '').toUpperCase();
    const unpaddedLength = normalizedTotp.replace(/=+$/, '').length;
    if (
      !/^[A-Z2-7]+=*$/.test(normalizedTotp) ||
      [1, 3, 6].includes(unpaddedLength % 8)
    ) {
      throw new BadRequestException('TOTP secret is invalid');
    }
  }

  private buildAuthorizationUrl(
    redirectUri: string,
    state: string,
    codeChallenge: string,
  ): string {
    const url = new URL(this.config.authorizationUrl);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: this.config.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    })) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private getRedirectUri(): string {
    const address = this.callbackServer?.address();
    const port =
      address && typeof address === 'object' ? address.port : this.config.callbackPort;
    return `http://${this.config.callbackHost}:${port}${this.config.callbackPath}`;
  }

  private async startCallbackServer(): Promise<void> {
    if (this.callbackServer) return;
    this.callbackServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', this.getRedirectUri());
      if (url.pathname !== this.config.callbackPath) {
        response.writeHead(404).end();
        return;
      }
      void this.handleCallback(
        url.searchParams.get('code') ?? undefined,
        url.searchParams.get('state') ?? undefined,
        url.searchParams.get('error') ?? undefined,
      )
        .then(() => response.writeHead(200).end('Codex authorization complete.'))
        .catch(() => response.writeHead(400).end('Codex authorization failed.'));
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.callbackServer!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.callbackPort, this.config.callbackHost);
    });
  }

  private async openBrowser(
    authorizationUrl: string,
    credentials: CodexAccountRequest,
  ): Promise<void> {
    let page: Page;
    try {
      this.browser = await this.launchBrowser();
      const context = await this.browser.newContext();
      page = await context.newPage();
      await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      await this.closeBrowser();
      throw new ServiceUnavailableException(
        'Unable to start browser. Install the selected browser runtime first.',
      );
    }

    try {
      this.updateStatus('browser_started', {
        step: 'email',
        message: 'Codex browser flow started',
      });
      await this.fillAndSubmitEmail(page, credentials.email);
      await this.fillAndSubmitPassword(page, credentials.password);
      await this.fillAndSubmitTotp(page, credentials.totpSecret!);
      await this.continueConsentIfPresent(page);
    } catch (error) {
      await this.closeBrowser();
      throw error;
    }
  }

  private async fillAndSubmitEmail(page: Page, email: string): Promise<void> {
    this.ensureSafeRoute(page);
    const field = await this.findVisible(page, [
      page.getByLabel(/email(?: address)?/i),
      page.getByRole('textbox', { name: /email(?: address)?/i }),
    ]);
    await field.fill(email);
    this.updateStatus('email', { step: 'email', message: 'Submitting Codex email' });
    await this.continueButton(page).click();
  }

  private async fillAndSubmitPassword(page: Page, password: string): Promise<void> {
    await this.waitForSafeRoute(page);
    const field = await this.findVisible(page, [
      page.getByLabel(/password/i),
      page.getByRole('textbox', { name: /password/i }),
    ]);
    await field.fill(password);
    this.updateStatus('password', { step: 'password', message: 'Submitting Codex password' });
    await this.continueButton(page).click();
  }

  private async fillAndSubmitTotp(page: Page, secret: string): Promise<void> {
    await this.waitForSafeRoute(page);
    const field = await this.findVisible(page, [
      page.getByLabel(/one[- ]time|verification|authenticator|security code/i),
      page.getByRole('textbox', { name: /one[- ]time|verification|authenticator|security code/i }),
    ]);
    const code = this.generateTotp(secret);
    await field.fill(code);
    this.updateStatus('totp', { step: 'totp', message: 'Submitting one-time code' });
    await this.continueButton(page).click();
  }

  private async continueConsentIfPresent(page: Page): Promise<void> {
    await this.waitForSafeRoute(page);
    const consent = page.getByRole('button', { name: 'Continue', exact: true });
    try {
      await consent.waitFor({ state: 'visible', timeout: 3_000 });
      this.updateStatus('consent', { step: 'consent', message: 'Confirming Codex consent' });
      await consent.click();
    } catch {
      // Consent is optional. Callback navigation may already be in progress.
    }
  }

  private continueButton(page: Page): Locator {
    return page.getByRole('button', { name: 'Continue', exact: true });
  }

  private async findVisible(page: Page, locators: Locator[]): Promise<Locator> {
    for (const locator of locators) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 10_000 });
        return locator;
      } catch {
        // Try the next semantic label, never a generated selector.
      }
    }
    this.ensureSafeRoute(page);
    throw new ServiceUnavailableException('Codex login page changed; manual completion is required');
  }

  private async waitForSafeRoute(page: Page): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const route = this.getBrowserRoute(page);
      if (route === 'captcha' || route === 'email-verification' || route === 'phone-verification') {
        throw new ServiceUnavailableException(MANUAL_STEP_MESSAGE);
      }
      if (route === 'onboarding' || route === 'unsupported') {
        throw new ServiceUnavailableException('Codex login route changed; manual completion is required');
      }
      if (route === 'password' || route === 'totp' || route === 'consent' || route === 'email') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.ensureSafeRoute(page);
  }

  private ensureSafeRoute(page: Page): void {
    const route = this.getBrowserRoute(page);
    if (route === 'captcha' || route === 'email-verification' || route === 'phone-verification') {
      throw new ServiceUnavailableException(MANUAL_STEP_MESSAGE);
    }
    if (route === 'onboarding' || route === 'unsupported') {
      throw new ServiceUnavailableException('Codex login route changed; manual completion is required');
    }
  }

  private getBrowserRoute(page: Page): BrowserRoute {
    let pathname = '';
    try {
      pathname = new URL(page.url()).pathname.toLowerCase();
    } catch {
      return 'unsupported';
    }
    if (/captcha/.test(pathname)) return 'captcha';
    if (/email[-_/]verification|verify[-_/]email/.test(pathname)) return 'email-verification';
    if (/phone|add[-_/]phone/.test(pathname)) return 'phone-verification';
    if (/about[-_/]you|onboard|profile/.test(pathname)) return 'onboarding';
    if (/password/.test(pathname)) return 'password';
    if (/totp|mfa|otp|one[-_/]time|verification/.test(pathname)) return 'totp';
    if (/consent/.test(pathname)) return 'consent';
    if (/create[-_/]account|sign[-_/]in|authorize|identifier/.test(pathname)) return 'email';
    if (/callback/.test(pathname)) return 'consent';
    return 'unsupported';
  }

  private generateTotp(secret: string): string {
    const normalized = secret.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]+=*$/.test(normalized)) throw new Error('Invalid TOTP secret');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const character of normalized.replace(/=+$/, '')) {
      const value = alphabet.indexOf(character);
      if (value < 0) throw new Error('Invalid TOTP secret');
      buffer = (buffer << 5) | value;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    if (bytes.length === 0) throw new Error('Invalid TOTP secret');
    const counter = Math.floor(Date.now() / 30_000);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
    counterBuffer.writeUInt32BE(counter >>> 0, 4);
    const digest = createHmac('sha1', Buffer.from(bytes)).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const value =
      ((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3];
    return String(value % 1_000_000).padStart(6, '0');
  }

  private updateStatus(
    state: string,
    options: {
      active?: boolean;
      email?: string;
      step?: string;
      level?: string;
      message?: string;
    } = {},
  ): void {
    const { active = this.status.active, email, step, level, message } = options;
    this.status = {
      active,
      state,
      ...(email !== undefined ? { email } : this.status.email ? { email: this.status.email } : {}),
      ...(step !== undefined ? { step } : this.status.step ? { step: this.status.step } : {}),
      logs: message
        ? [...this.status.logs, { at: Date.now(), message, ...(level ? { level } : {}) }].slice(-20)
        : this.status.logs,
    };
  }

  private async failCallback(message: string): Promise<void> {
    this.updateStatus('failed', {
      active: false,
      step: 'callback',
      level: 'error',
      message,
    });
    await this.closeBrowser();
    await this.closeCallbackServer();
  }

  private safeFailureMessage(error: unknown): string {
    if (error instanceof ServiceUnavailableException) return error.message;
    if (error instanceof BadRequestException) return error.message;
    return 'Codex account flow failed to start';
  }

  private async launchBrowser(): Promise<Browser> {
    // camoufox-js is ESM-only; static import breaks the CommonJS Jest runtime.
    const { Camoufox } = await import('camoufox-js');
    return Camoufox({ headless: false, humanize: 0.5 });
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close();
  }

  private async closeCallbackServer(): Promise<void> {
    const server = this.callbackServer;
    this.callbackServer = undefined;
    if (!server) return;
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async parseTokenResponse(response: Response): Promise<CodexTokenResponse> {
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('access_token' in value) ||
      typeof value.access_token !== 'string'
    ) {
      throw new UnauthorizedException('Codex token response is invalid');
    }
    const token: CodexTokenResponse = { access_token: value.access_token };
    if ('refresh_token' in value && typeof value.refresh_token === 'string') {
      token.refresh_token = value.refresh_token;
    }
    if ('id_token' in value && typeof value.id_token === 'string') {
      token.id_token = value.id_token;
    }
    if ('expires_in' in value && typeof value.expires_in === 'number') {
      token.expires_in = value.expires_in;
    }
    if ('scope' in value && typeof value.scope === 'string') token.scope = value.scope;
    if ('token_type' in value && typeof value.token_type === 'string') {
      token.token_type = value.token_type;
    }
    return token;
  }
}
