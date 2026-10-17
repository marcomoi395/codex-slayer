import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { createServer, type Server } from 'node:http';
import type { Browser, Locator, Page } from 'playwright-core';

import { AccountVault, type AccountVaultRecord } from './account-vault';
import { CODEX_CONFIG } from './codex.constants';
import type { CodexConfig } from './codex.config';
import { CodexQuotaClient, type CodexQuotaClassification } from './codex-quota';
import type {
  CodexAccountRequest,
  CodexAccountSummary,
  CodexAuthorization,
  CodexBatchAccountResult,
  CodexBatchResult,
  CodexBatchStatus,
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

interface CallbackWaiter {
  resolve: (response: CodexCallbackResponse) => void;
  reject: (error: unknown) => void;
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

const BATCH_CALLBACK_TIMEOUT_MS = 60_000;

@Injectable()
export class CodexService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly callbackWaiters = new Map<string, CallbackWaiter>();
  private readonly accountVault: AccountVault;
  private status: CodexStatus = { active: false, logs: [] };
  private browser?: Browser;
  private callbackServer?: Server;
  private batchRunning = false;
  private batchStatus?: CodexBatchStatus;

  constructor(
    @Inject(CODEX_CONFIG) private readonly config: CodexConfig,
    @Inject(CodexQuotaClient)
    private readonly quotaClient: Pick<CodexQuotaClient, 'classify'> =
      new CodexQuotaClient({ url: config.quotaUrl }),
  ) {
    this.accountVault = new AccountVault(
      config.databasePath ?? 'codex-accounts.sqlite',
      config.encryptionKey,
    );
  }

  getStatus(): CodexStatus {
    return {
      ...this.status,
      ...(this.batchStatus
        ? {
            batch: {
              ...this.batchStatus,
              accounts: this.batchStatus.accounts.map((account) => ({
                ...account,
              })),
            },
          }
        : {}),
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

  async saveAccount(
    credentials: CodexAccountRequest,
  ): Promise<{ saved: true }> {
    this.validateAccountCredentials(credentials);
    await this.accountVault.upsert({
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
      totpSecret: credentials.totpSecret,
    });
    return { saved: true };
  }

  async startAccountFlow(
    credentials: CodexAccountRequest,
  ): Promise<{ started: true }> {
    this.validateAccountCredentials(credentials);
    if (this.pending.size > 0 || this.status.active || this.batchRunning) {
      throw new BadRequestException('A Codex login flow is already active');
    }
    await this.beginAccountFlow(credentials);
    return { started: true };
  }


  async startBatchFlow(limit?: number): Promise<CodexBatchResult> {
    if (this.batchRunning || this.pending.size > 0 || this.status.active) {
      throw new BadRequestException('A Codex login flow is already active');
    }
    this.batchRunning = true;
    this.batchStatus = {
      active: true,
      total: 0,
      completed: 0,
      authenticated: 0,
      skipped: 0,
      indeterminate: 0,
      failed: 0,
      accounts: [],
    };
    let records: AccountVaultRecord[];
    try {
      records = await this.accountVault.listCredentials(limit);
    } catch (error) {
      this.batchRunning = false;
      this.batchStatus = undefined;
      this.updateStatus('batch_failed', {
        active: false,
        step: 'batch',
        level: 'error',
        message: `Codex account batch could not start: ${this.safeFailureMessage(error)}`,
      });
      throw error;
    }
    const result: CodexBatchResult = {
      total: records.length,
      completed: 0,
      authenticated: 0,
      skipped: 0,
      indeterminate: 0,
      failed: 0,
      accounts: [],
    };
    this.batchStatus = { active: true, ...result, accounts: [] };
    this.updateStatus('batch_started', {
      active: true,
      step: 'batch',
      message: `Starting Codex account batch (${records.length} accounts)`,
    });

    try {
      for (const record of records) {
        this.updateBatchStatus({ currentEmail: record.email });
        this.updateStatus('batch_progress', {
          active: true,
          email: record.email,
          step: 'batch',
          message: 'Processing Codex account batch item',
        });
        let accountResult: CodexBatchAccountResult;
        if (record.accessToken) {
          let classification: CodexQuotaClassification = 'indeterminate';
          try {
            classification = await this.quotaClient.classify({
              accessToken: record.accessToken,
            });
          } catch {
            classification = 'indeterminate';
          }
          if (classification === 'valid') {
            accountResult = { email: record.email, outcome: 'skipped' };
          } else if (classification === 'indeterminate') {
            accountResult = {
              email: record.email,
              outcome: 'indeterminate',
              reason: 'Quota status could not be determined',
            };
          } else {
            accountResult = await this.runBatchAccount(record);
          }
        } else {
          accountResult = await this.runBatchAccount(record);
        }
        result.accounts.push(accountResult);
        result.completed += 1;
        result[accountResult.outcome] += 1;
        this.batchStatus = {
          ...result,
          active: true,
          ...(this.batchStatus?.currentEmail
            ? { currentEmail: this.batchStatus.currentEmail }
            : {}),
        };
      }
      return { ...result, accounts: result.accounts.map((account) => ({ ...account })) };
    } finally {
      this.batchRunning = false;
      this.batchStatus = { ...result, active: false };
      this.updateStatus('batch_completed', {
        active: false,
        step: 'batch',
        message: `Codex account batch completed (${result.completed}/${result.total})`,
      });
    }
  }

  private async runBatchAccount(
    record: AccountVaultRecord,
  ): Promise<CodexBatchAccountResult> {
    this.updateStatus('batch_account', {
      active: true,
      email: record.email,
      step: 'batch',
      message: 'Running Codex account authorization',
    });
    try {
      await this.runSavedAccountFlow(record);
      return { email: record.email, outcome: 'authenticated' };
    } catch (error) {
      return {
        email: record.email,
        outcome: 'failed',
        reason: this.safeFailureMessage(error),
      };
    }
  }

  private async runSavedAccountFlow(record: AccountVaultRecord): Promise<void> {
    this.validateAccountCredentials({
      email: record.email,
      password: record.password,
      totpSecret: record.totpSecret,
    });
    let waiter!: CallbackWaiter;
    const completion = new Promise<CodexCallbackResponse>((resolve, reject) => {
      waiter = { resolve, reject };
    });
    let state: string | undefined;
    try {
      const authorization = await this.beginAccountFlow(
        {
          email: record.email,
          password: record.password,
          totpSecret: record.totpSecret,
        },
        waiter,
      );
      state = authorization.state;
      await this.waitForBatchCallback(completion);
    } finally {
      if (state) {
        this.pending.delete(state);
        this.callbackWaiters.delete(state);
      }
      await this.closeBrowser();
      this.closeCallbackServer();
    }
  }

  private async waitForBatchCallback(
    completion: Promise<CodexCallbackResponse>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ServiceUnavailableException(
                  'Codex authorization callback timed out',
                ),
              ),
            BATCH_CALLBACK_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private updateBatchStatus(options: { currentEmail?: string }): void {
    if (!this.batchStatus) return;
    this.batchStatus = {
      ...this.batchStatus,
      ...options,
      accounts: this.batchStatus.accounts.map((account) => ({ ...account })),
    };
  }

  private async beginAccountFlow(
    credentials: CodexAccountRequest,
    waiter?: CallbackWaiter,
  ): Promise<CodexAuthorization> {
    let authorization: CodexAuthorization | undefined;
    try {
      const email = credentials.email.trim().toLowerCase();
      await this.accountVault.upsert({
        email,
        password: credentials.password,
        totpSecret: credentials.totpSecret,
      });
      this.updateStatus('validating', {
        active: true,
        email,
        step: 'credentials',
        message: 'Validating Codex account credentials',
      });
      authorization = await this.createAuthorizationLink(email);

      const pending = this.pending.get(authorization.state);
      if (!pending) throw new Error('Authorization state was not created');
      pending.password = credentials.password;
      pending.totpSecret = credentials.totpSecret;
      if (waiter) this.callbackWaiters.set(authorization.state, waiter);

      await this.openBrowser(authorization.authorizationUrl, credentials);
      this.updateStatus('awaiting_callback', {
        step: 'callback',
        message: 'Waiting for Codex authorization callback',
      });
      return authorization;
    } catch (error) {
      if (authorization) {
        this.pending.delete(authorization.state);
        this.callbackWaiters.delete(authorization.state);
      }
      await this.closeBrowser();
      this.closeCallbackServer();
      this.updateStatus('failed', {
        active: false,
        step: 'start',
        level: 'error',
        message: this.safeFailureMessage(error),
      });
      throw error;
    }
  }

  private async createAuthorizationLink(
    email?: string,
  ): Promise<CodexAuthorization> {
    if (
      this.pending.size > 0 ||
      this.callbackServer ||
      (this.status.active && this.status.state !== 'validating')
    ) {
      throw new BadRequestException(
        'A Codex authorization flow is already active',
      );
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    try {
      await this.startCallbackServer();
    } catch {
      this.closeCallbackServer();
      throw new ServiceUnavailableException(
        'Unable to start the OAuth callback server',
      );
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
      await this.failCallback('Codex authorization was denied', state);
      throw new UnauthorizedException('Codex authorization failed');
    }
    if (!code || !state) {
      if (state) this.pending.delete(state);
      await this.failCallback('Codex authorization callback was incomplete', state);
      throw new BadRequestException('Codex callback requires code and state');
    }

    const session = this.pending.get(state);
    if (!session || Date.now() - session.createdAt > this.config.stateTtlMs) {
      if (session) this.pending.delete(state);
      await this.failCallback(
        'Codex authorization state was invalid or expired',
        state,
      );
      throw new UnauthorizedException(
        'Codex OAuth state is invalid or expired',
      );
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
      if (!response.ok)
        throw new UnauthorizedException('Codex token exchange failed');

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
        ? (await this.accountVault.list()).find(
            (item) => item.email === session.email,
          )
        : undefined;
      this.pending.delete(state);
      const callbackResponse: CodexCallbackResponse = {
        ok: true,
        email: session.email,
        connectionId: account?.connectionId,
      };
      const waiter = this.callbackWaiters.get(state);
      this.callbackWaiters.delete(state);
      waiter?.resolve(callbackResponse);
      this.updateStatus('completed', {
        active: false,
        email: session.email,
        step: 'callback',
        message: 'Codex account authorization completed',
      });
      return callbackResponse;
    } catch (callbackError) {
      this.pending.delete(state);
      const waiter = this.callbackWaiters.get(state);
      this.callbackWaiters.delete(state);
      waiter?.reject(callbackError);
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
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
    this.closeCallbackServer();
    this.pending.clear();
    this.callbackWaiters.clear();
    this.batchRunning = false;
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
      throw new BadRequestException(
        'Email, password and TOTP secret are required',
      );
    }
    const normalizedTotp = credentials.totpSecret
      .replace(/[\s-]/g, '')
      .toUpperCase();
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
      address && typeof address === 'object'
        ? address.port
        : this.config.callbackPort;
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
        .then(() =>
          response.writeHead(200).end('Codex authorization complete.'),
        )
        .catch(() => response.writeHead(400).end('Codex authorization failed.'))
        .finally(() => this.closeCallbackServer());
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
    } catch {
      await this.closeBrowser();
      throw new ServiceUnavailableException(
        'Camoufox could not launch. Check the browser files and Linux runtime libraries.',
      );
    }

    try {
      await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      await this.closeBrowser();
      throw new ServiceUnavailableException(
        'Camoufox started but could not open the Codex login page. Check outbound network access.',
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
    this.updateStatus('email', {
      step: 'email',
      message: 'Submitting Codex email',
    });
    await this.continueButton(page).click();
  }

  private async fillAndSubmitPassword(
    page: Page,
    password: string,
  ): Promise<void> {
    await this.waitForSafeRoute(page);
    const field = await this.findVisible(page, [
      page.getByLabel(/password/i),
      page.getByRole('textbox', { name: /password/i }),
    ]);
    await field.fill(password);
    this.updateStatus('password', {
      step: 'password',
      message: 'Submitting Codex password',
    });
    await this.continueButton(page).click();
  }

  private async fillAndSubmitTotp(page: Page, secret: string): Promise<void> {
    await this.waitForSafeRoute(page);
    const field = await this.findVisible(page, [
      page.getByLabel(/one[- ]time|verification|authenticator|security code/i),
      page.getByRole('textbox', {
        name: /one[- ]time|verification|authenticator|security code/i,
      }),
    ]);
    const code = authenticator.generate(
      secret.replace(/[\s-]/g, '').toUpperCase(),
    );
    await field.fill(code);
    this.updateStatus('totp', {
      step: 'totp',
      message: 'Submitting one-time code',
    });
    await this.continueButton(page).click();
  }

  private async continueConsentIfPresent(page: Page): Promise<void> {
    await this.waitForSafeRoute(page);
    const consent = page.getByRole('button', { name: 'Continue', exact: true });
    try {
      await consent.waitFor({ state: 'visible', timeout: 3_000 });
      this.updateStatus('consent', {
        step: 'consent',
        message: 'Confirming Codex consent',
      });
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
    throw new ServiceUnavailableException(
      'Codex login page changed; manual completion is required',
    );
  }

  private async waitForSafeRoute(page: Page): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const route = this.getBrowserRoute(page);
      if (
        route === 'captcha' ||
        route === 'email-verification' ||
        route === 'phone-verification'
      ) {
        throw new ServiceUnavailableException(MANUAL_STEP_MESSAGE);
      }
      if (route === 'onboarding' || route === 'unsupported') {
        throw new ServiceUnavailableException(
          'Codex login route changed; manual completion is required',
        );
      }
      if (
        route === 'password' ||
        route === 'totp' ||
        route === 'consent' ||
        route === 'email'
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.ensureSafeRoute(page);
  }

  private ensureSafeRoute(page: Page): void {
    const route = this.getBrowserRoute(page);
    if (
      route === 'captcha' ||
      route === 'email-verification' ||
      route === 'phone-verification'
    ) {
      throw new ServiceUnavailableException(MANUAL_STEP_MESSAGE);
    }
    if (route === 'onboarding' || route === 'unsupported') {
      throw new ServiceUnavailableException(
        'Codex login route changed; manual completion is required',
      );
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
    if (/email[-_/]verification|verify[-_/]email/.test(pathname))
      return 'email-verification';
    if (/phone|add[-_/]phone/.test(pathname)) return 'phone-verification';
    if (/about[-_/]you|onboard|profile/.test(pathname)) return 'onboarding';
    if (/password/.test(pathname)) return 'password';
    if (/totp|mfa|otp|one[-_/]time|verification/.test(pathname)) return 'totp';
    if (/consent/.test(pathname)) return 'consent';
    if (
      /create[-_/]account|sign[-_/]in|log[-_/]in|authorize|identifier/.test(
        pathname,
      )
    )
      return 'email';
    if (/callback/.test(pathname)) return 'consent';
    return 'unsupported';
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
    const {
      active = this.status.active,
      email,
      step,
      level,
      message,
    } = options;
    this.status = {
      active,
      state,
      ...(email !== undefined
        ? { email }
        : this.status.email
          ? { email: this.status.email }
          : {}),
      ...(step !== undefined
        ? { step }
        : this.status.step
          ? { step: this.status.step }
          : {}),
      logs: message
        ? [
            ...this.status.logs,
            { at: Date.now(), message, ...(level ? { level } : {}) },
          ].slice(-20)
        : this.status.logs,
    };
  }

  private async failCallback(message: string, state?: string): Promise<void> {
    if (state) {
      this.pending.delete(state);
      const waiter = this.callbackWaiters.get(state);
      this.callbackWaiters.delete(state);
      waiter?.reject(new UnauthorizedException('Codex authorization failed'));
    } else {
      this.pending.clear();
      this.callbackWaiters.clear();
    }
    this.updateStatus('failed', {
      active: false,
      step: 'callback',
      level: 'error',
      message,
    });
    await this.closeBrowser();
    this.closeCallbackServer();
  }

  private safeFailureMessage(error: unknown): string {
    if (error instanceof ServiceUnavailableException) return error.message;
    if (error instanceof BadRequestException) return error.message;
    return 'Codex account flow failed to start';
  }

  private async launchBrowser(): Promise<Browser> {
    // camoufox-js is ESM-only; static import breaks the CommonJS Jest runtime.
    const { Camoufox } = await import('camoufox-js');
    return Camoufox({ headless: true });
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    try {
      await browser?.close();
    } catch {
      // Cleanup must not stop the next saved-account attempt.
    }
  }

  private closeCallbackServer(): void {
    const server = this.callbackServer;
    this.callbackServer = undefined;
    try {
      if (server?.listening) server.close();
    } catch {
      // Cleanup must not stop the next saved-account attempt.
    }
  }

  private async parseTokenResponse(
    response: Response,
  ): Promise<CodexTokenResponse> {
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
    if ('scope' in value && typeof value.scope === 'string')
      token.scope = value.scope;
    if ('token_type' in value && typeof value.token_type === 'string') {
      token.token_type = value.token_type;
    }
    return token;
  }
}
