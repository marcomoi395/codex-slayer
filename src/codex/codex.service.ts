import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type Server } from 'node:http';
import type { Browser, Locator, Page } from 'playwright-core';

import { AccountVault } from './account-vault';
import { CODEX_CONFIG } from './codex.constants';
import type { CodexConfig } from './codex.config';
import type {
  CodexAccountRequest,
  CodexAccountSummary,
  CodexAuthorization,
  CodexConnection,
  CodexStartResponse,
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
interface ResolvedAccountCredentials extends CodexAccountRequest {}
type CodexBrowserRoute =
  | 'email-entry'
  | 'password'
  | 'email-verification'
  | 'add-phone'
  | 'about-you'
  | 'consent';

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

  async startAccountFlow(
    credentials: CodexAccountRequest,
  ): Promise<CodexStartResponse> {
    let authorization: CodexStartResponse | undefined;
    try {
      this.updateStatus('validating', {
        active: true,
        email: typeof credentials?.email === 'string' ? credentials.email : undefined,
        step: 'credentials',
        message: 'Validating Codex account credentials',
      });
      this.validateAccountCredentials(credentials);
      authorization = await this.createAuthorizationLink(credentials.email);
      const pending = this.pending.get(authorization.state);
      if (pending) {
        pending.password = credentials.password;
        pending.totpSecret = credentials.totpSecret;
      }
      this.updateStatus('browser', {
        step: 'authorization',
        message: 'Opening Codex authorization flow',
      });
      await this.openBrowser(authorization.authorizationUrl, credentials);
      this.updateStatus('awaiting_callback', {
        step: 'callback',
        message: 'Waiting for Codex authorization callback',
      });
      return authorization;
    } catch (error) {
      if (authorization) this.pending.delete(authorization.state);
      this.updateStatus('failed', {
        active: false,
        step: 'start',
        level: 'error',
        message: 'Codex account flow failed to start',
      });
      throw error;
    }
  }

  async createAuthorizationLink(email?: string): Promise<CodexStartResponse> {
    if (this.pending.size > 0) {
      throw new BadRequestException(
        'A Codex authorization flow is already active',
      );
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
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
      email,
    });
    await this.startCallbackServer();

    this.updateStatus('authorization_created', {
      email,
      step: 'authorization',
      message: 'Codex authorization link created',
    });
    return {
      state,
      authorizationUrl,
      createdAt,
      callbackUrl: redirectUri,
      browserUrl: this.config.createAccountUrl,
    };
  }

  async handleCallback(
    code?: string,
    state?: string,
    error?: string,
  ): Promise<CodexConnection> {
    if (error) {
      this.updateStatus('failed', {
        active: false,
        step: 'callback',
        level: 'error',
        message: 'Codex authorization callback failed',
      });
      throw new UnauthorizedException(`Codex OAuth failed: ${error}`);
    }
    if (!code || !state) {
      this.updateStatus('failed', {
        active: false,
        step: 'callback',
        level: 'error',
        message: 'Codex authorization callback was incomplete',
      });
      throw new BadRequestException('Codex callback requires code and state');
    }

    const session = this.pending.get(state);
    if (!session || Date.now() - session.createdAt > this.config.stateTtlMs) {
      this.pending.delete(state);
      this.updateStatus('failed', {
        active: false,
        step: 'callback',
        level: 'error',
        message: 'Codex authorization state was invalid or expired',
      });
      throw new UnauthorizedException(
        'Codex OAuth state is invalid or expired',
      );
    }

    let completed = false;
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

      if (!response.ok) {
        throw new UnauthorizedException('Codex token exchange failed');
      }

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
      this.pending.delete(state);
      completed = true;
      this.updateStatus('completed', {
        active: false,
        email: session.email,
        step: 'callback',
        message: 'Codex account authorization completed',
      });
      return connection;
    } catch (callbackError) {
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
      if (completed) await this.closeCallbackServer();
    }
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
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
    await this.closeCallbackServer();
    this.accountVault.close();
  }


  private validateAccountCredentials(credentials: CodexAccountRequest): void {
    if (
      !credentials ||
      typeof credentials.email !== 'string' ||
      !credentials.email.trim() ||
      typeof credentials.password !== 'string' ||
      !credentials.password
    ) {
      throw new BadRequestException('Email and password are required');
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
    return `http://${this.config.callbackHost}:${this.config.callbackPort}${this.config.callbackPath}`;
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
          response
            .writeHead(200)
            .end('Codex authorization complete. You may close this tab.'),
        )
        .catch(() =>
          response.writeHead(400).end('Codex authorization failed.'),
        );
    });
    await new Promise<void>((resolve, reject) => {
      this.callbackServer?.once('error', reject);
      this.callbackServer?.listen(
        this.config.callbackPort,
        this.config.callbackHost,
        () => resolve(),
      );
    });
  }


  private async openBrowser(
    authorizationUrl: string,
    credentials: ResolvedAccountCredentials,
  ): Promise<void> {
    console.log('[codex] browser flow started', {
      authorizationHost: new URL(authorizationUrl).host,
      hasEmail: Boolean(credentials.email),
    });
    let page: Page;
    try {
      this.browser = await this.launchBrowser();
      const context = await this.browser.newContext();
      page = await context.newPage();
      await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      await this.closeBrowser();
      await this.closeCallbackServer();
      throw new ServiceUnavailableException(
        'Unable to start browser. Install the selected browser runtime first.',
      );
    }

    try {
    this.updateStatus('browser_started', {
      step: 'browser',
      message: 'Codex browser flow started',
    });
      const signUpLink = page.getByRole('link', { name: /sign up/i });
      const initialRoute = this.getCodexBrowserRoute(page);
      if (await this.isVisible(signUpLink, 3_000)) {
        console.log('[codex] signup link visible');
        const emailInput = page.locator('input[type="email"]');
        await signUpLink.click();
        await this.waitForVisible(page, emailInput, 10_000, 'email input');
        await emailInput.fill(credentials.email);

        const continueButton = page.locator('button[type="submit"]');
        await this.waitForVisible(page, continueButton, 10_000, 'signup continue button');
        const emailEntryRoute = this.getCodexBrowserRoute(page) ?? 'email-entry';
        await continueButton.click();
        console.log('[codex] signup email submitted', {
          url: this.getPageUrl(page),
        });
        const nextRoute = await this.waitForRouteChange(
          page,
          emailEntryRoute,
        );
        if (nextRoute !== 'password') {
          await this.dispatchCurrentBrowserRoute(page, credentials);
          return;
        }

        const passwordInput = page.locator('input[type="password"]');
        await this.waitForVisible(page, passwordInput, 10_000, 'password input');
        await passwordInput.fill(credentials.password);
        const verificationRequestedAt = Date.now();
        const passwordRoute = this.getCodexBrowserRoute(page) ?? 'password';
        await continueButton.click();
        console.log('[codex] signup password submitted', {
          url: this.getPageUrl(page),
        });
        await this.dispatchCurrentBrowserRoute(
          page,
          credentials,
          verificationRequestedAt,
          passwordRoute,
        );
        return;
      }

      if (initialRoute) {
        if (initialRoute === 'password') {
          const passwordInput = page.locator('input[type="password"]');
          await this.waitForVisible(page, passwordInput, 10_000, 'password input');
          await passwordInput.fill(credentials.password);
          const passwordRoute = this.getCodexBrowserRoute(page) ?? 'password';
          await page.locator('button[type="submit"]').click();
          await this.dispatchCurrentBrowserRoute(page, credentials, Date.now(), passwordRoute);
          return;
        }
        await this.dispatchCurrentBrowserRoute(page, credentials);
      }
    } catch (error) {
      await this.closeBrowser();
      await this.closeCallbackServer();
      throw error;
    }
  }

  private getPageUrl(page: Page): string | undefined {
    if (typeof page.url !== 'function') return undefined;
    try {
      const url = new URL(page.url());
      return `${url.origin}${url.pathname}`;
    } catch {
      return page.url();
    }
  }





  private async waitForVisible(
    page: Page,
    locator: Locator,
    timeout: number,
    step: string,
  ): Promise<void> {
    const startedAt = Date.now();
    console.log('[codex] waiting for browser element', {
      step,
      timeout,
      url: this.getPageUrl(page),
    });
    await locator.waitFor({ state: 'visible', timeout });
    console.log('[codex] browser element visible', {
      step,
      elapsedMs: Date.now() - startedAt,
      url: this.getPageUrl(page),
    });
  }
  private getCodexBrowserRoute(page: Page): CodexBrowserRoute | undefined {
    const pathname = new URL(this.getPageUrl(page) ?? 'https://invalid').pathname;
    if (/\/email-verification(?:[/?#]|$)/i.test(pathname)) return 'email-verification';
    if (/\/add-phone(?:[/?#]|$)/i.test(pathname)) return 'add-phone';
    if (/\/about-you(?:[/?#]|$)/i.test(pathname)) return 'about-you';
    if (/\/sign-in-with-chatgpt\/codex\/consent(?:[/?#]|$)/i.test(pathname)) return 'consent';
    if (/\/password(?:[/?#]|$)/i.test(pathname)) return 'password';
    if (/\/create-account(?:[/?#]|$)/i.test(pathname)) return 'email-entry';
    return undefined;
  }

  private async waitForCodexBrowserRoute(
    page: Page,
    timeout = 10_000,
  ): Promise<CodexBrowserRoute> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const route = this.getCodexBrowserRoute(page);
      if (route) return route;
      await delay(250);
    }
    throw new ServiceUnavailableException(
      'Codex browser route was not detected from the URL',
    );
  }
  private async waitForRouteChange(
    page: Page,
    previousRoute: CodexBrowserRoute,
    timeout = 30_000,
  ): Promise<CodexBrowserRoute | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const currentUrl = this.getPageUrl(page);
      const route = this.getCodexBrowserRoute(page);
      if (route && route !== previousRoute) return route;
      if (currentUrl && !route) return undefined;
      await delay(250);
    }
    throw new ServiceUnavailableException(
      `Codex browser route did not change from ${previousRoute}`,
    );
  }

  private async dispatchCurrentBrowserRoute(
    page: Page,
    credentials: ResolvedAccountCredentials,
    requestedAfterMs = Date.now(),
    previousRoute?: CodexBrowserRoute,
  ): Promise<void> {
    const currentRoute = this.getCodexBrowserRoute(page);
    const route = previousRoute
      ? currentRoute && currentRoute !== previousRoute
        ? currentRoute
        : await this.waitForRouteChange(page, previousRoute)
      : currentRoute ?? (await this.waitForCodexBrowserRoute(page));
    if (!route) return;
    console.log('[codex] browser route dispatched', {
      route,
      url: this.getPageUrl(page),
    });
    if (route === 'email-verification' || route === 'add-phone') {
      throw new ServiceUnavailableException(
        'Codex email and phone verification require manual completion',
      );
    }
    if (route === 'about-you') {
      throw new ServiceUnavailableException(
        'Codex profile completion requires manual completion',
      );
    }
    if (route === 'consent') {
      const continueButton = page.getByRole('button', {
        name: 'Continue',
        exact: true,
      });
      await continueButton.waitFor({ state: 'visible', timeout: 10_000 });
      await continueButton.click();
      console.log('[codex] consent Continue clicked', {
        url: this.getPageUrl(page),
      });
    }
  }


  private async isVisible(locator: Locator, timeout: number): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    // Camoufox is ESM-only; dynamic loading keeps the CommonJS Jest runtime compatible.
    const { Camoufox } = await import('camoufox-js');
    return Camoufox({
      headless: false,
      humanize: 0.5,
    });
  }

  private async closeBrowser(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }

  private async closeCallbackServer(): Promise<void> {
    const server = this.callbackServer;
    this.callbackServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async parseTokenResponse(
    response: Response,
  ): Promise<CodexTokenResponse> {
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { access_token?: unknown }).access_token !== 'string'
    ) {
      throw new UnauthorizedException('Codex token response is invalid');
    }
    return value as CodexTokenResponse;
  }
}
