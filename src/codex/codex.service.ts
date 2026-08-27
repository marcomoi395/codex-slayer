import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright';
import type { Browser, Locator, Page } from 'playwright-core';

import { CODEX_CONFIG } from './codex.constants';
import type { CodexConfig } from './codex.config';
import { PhoneVerificationProvider } from '../phone-verification/phone-verification.provider';
import type { PhoneNumberResult } from '../phone-verification/phone-verification.types';
import { GoogleGmailService } from '../google-gmail/google-gmail.service';
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
}
interface ResolvedAccountCredentials extends CodexAccountRequest {
  connectionId: string;
}
interface StoredCodexAccount {
  connectionId?: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  email: string;
}
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
  private readonly connectionsFile = 'codex-accounts.json';
  private status: CodexStatus = { active: false, logs: [] };
  private browser?: Browser;
  private callbackServer?: Server;
  constructor(
    @Inject(CODEX_CONFIG) private readonly config: CodexConfig,
    private readonly googleGmailService: GoogleGmailService,
    @Optional() private readonly phoneVerificationProvider?: PhoneVerificationProvider,
  ) {}

  getStatus(): CodexStatus {
    return {
      ...this.status,
      logs: this.status.logs.map((log) => ({ ...log })),
    };
  }

  async getAccounts(): Promise<CodexAccountSummary[]> {
    const accounts = await this.loadConnections();
    return accounts.map(({ email, connectionId }) => ({ email, connectionId }));
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
      const connectionId = await this.validateAccountCredentials(credentials);
      authorization = await this.createAuthorizationLink(credentials.email);
      this.updateStatus('browser', {
        step: 'authorization',
        message: 'Opening Codex authorization flow',
      });
      await this.openBrowser(authorization.authorizationUrl, {
        ...credentials,
        connectionId,
      });
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
      if (session.email) {
        await this.saveConnection(connection, session.email);
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
    email: string,
  ): Promise<void> {
    const connections = await this.loadConnections();
    connections.push({
      connectionId: connection.connectionId,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken ?? '',
      idToken: connection.idToken ?? '',
      email,
    });
    await writeFile(
      this.connectionsFile,
      JSON.stringify(connections, null, 2),
      'utf8',
    );
  }

  private async loadConnections(): Promise<StoredCodexAccount[]> {
    try {
      const content = await readFile(this.connectionsFile, 'utf8');
      const value: unknown = JSON.parse(content);
      if (!Array.isArray(value)) return [];
      return value as StoredCodexAccount[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
    await this.closeCallbackServer();
  }

  private async validateAccountCredentials(
    credentials: CodexAccountRequest,
  ): Promise<string> {
    if (
      !credentials ||
      typeof credentials.email !== 'string' ||
      !credentials.email.trim() ||
      typeof credentials.password !== 'string' ||
      !credentials.password
    ) {
      throw new BadRequestException('Email and password are required');
    }

    const connectionId =
      await this.googleGmailService.getCredentialConnectionId(
        credentials.email,
      );
    if (!connectionId) {
      throw new UnauthorizedException(
        'Gmail credential is not authorized for this email',
      );
    }

    return connectionId;
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
    if (route === 'email-verification') {
      const codeInput = page.locator(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[id*="code" i]',
      );
      await this.waitForVisible(page, codeInput, 30_000, 'email verification code input');
      await this.completeEmailVerification(
        page,
        codeInput,
        credentials,
        requestedAfterMs,
      );
      return;
    }
    if (route === 'add-phone') {
      await this.completePhoneVerification(page, credentials);
      return;
    }
    if (route === 'about-you') {
      await this.completePostPhoneProfile(page, credentials);
      return;
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
  private async completeEmailVerification(
    page: Page,
    codeInput: Locator,
    credentials: ResolvedAccountCredentials,
    requestedAfterMs = Date.now(),
  ): Promise<void> {
    const verificationCode = await this.getVerificationCodeWithRetry(
      credentials.connectionId,
      requestedAfterMs,
    );
    await codeInput.fill(verificationCode);

    const verificationContinueButton = page.getByRole('button', {
      name: 'Continue',
      exact: true,
    });
    await verificationContinueButton.waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    const currentRoute = this.getCodexBrowserRoute(page) ?? 'email-verification';
    await verificationContinueButton.click();
    console.log('[codex] email verification submitted');
    await this.dispatchCurrentBrowserRoute(
      page,
      credentials,
      requestedAfterMs,
      currentRoute,
    );

  }

  private async getVerificationCodeWithRetry(
    connectionId: string,
    requestedAfterMs: number,
  ): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.googleGmailService.getLatestOpenAiVerificationCode(
          connectionId,
          requestedAfterMs,
        );
      } catch (error) {
        if (!(error instanceof NotFoundException) || attempt === 3) {
          throw error;
        }
        await delay(2_000);
      }
    }

    throw new NotFoundException('OpenAI verification code not found');
  }

  private async hasPhoneSubmissionFallback(page: Page): Promise<boolean> {
    const pageWithEvaluate = page as Page & {
      evaluate?: <T>(pageFunction: () => T) => Promise<T>;
    };
    if (typeof pageWithEvaluate.evaluate !== 'function') return false;

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const found = await pageWithEvaluate.evaluate(() => {
        const text = document.body?.innerText ?? '';
        return (
          /we couldn't send a text message to this phone number[\s\S]*switched to whatsapp/i.test(text) ||
          /phone number already in use[\s\S]*use a different phone number/i.test(text)
        );
      });
      if (found) return true;
      await delay(500);
    }
    return false;
  }

  private async selectTextMessage(page: Page): Promise<void> {
    const pageWithEvaluate = page as Page & {
      evaluate?: <T>(pageFunction: () => T) => Promise<T>;
    };
    if (typeof pageWithEvaluate.evaluate !== 'function') {
      throw new ServiceUnavailableException(
        'Unable to select Text message verification',
      );
    }

    const selected = await pageWithEvaluate.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('input[type="radio"], [role="radio"], label, button'),
      );
      const target = candidates.find((element) =>
        /text message/i.test(
          `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
        ),
      );
      if (!target) return false;
      (target as HTMLElement).click();
      return true;
    });
    if (!selected) {
      throw new ServiceUnavailableException(
        'Text message verification option was not found',
      );
    }
  }

  private async returnToPhoneEntryPage(page: Page): Promise<void> {
    console.log('[codex] returning to phone entry page before retry', {
      url: this.getPageUrl(page),
    });
    await page.goBack({ waitUntil: 'domcontentloaded' });
    const phoneInput = page.locator(
      'input[type="tel"]:visible, input[placeholder*="+1"]:visible, input[placeholder*="phone" i]:visible, input[name*="phone" i]:visible, input[id*="phone" i]:visible',
    );
    await this.waitForVisible(page, phoneInput, 10_000, 'phone entry input after OTP timeout');
    console.log('[codex] phone entry page ready for retry', {
      url: this.getPageUrl(page),
    });
  }

  private async completePostPhoneProfile(
    page: Page,
    credentials: ResolvedAccountCredentials,
  ): Promise<void> {
    const nameInput = page
      .locator(
        'input[autocomplete="name"], input[name*="name" i], input[placeholder*="name" i]',
      )
      .first();
    const ageInput = page
      .locator(
        'input[type="number"], input[name*="age" i], input[placeholder*="age" i]',
      )
      .first();
    await this.waitForVisible(page, nameInput, 10_000, 'post-phone full name input');
    await nameInput.fill('Thanh Loi');
    await this.waitForVisible(page, ageInput, 10_000, 'post-phone age input');
    await ageInput.fill('23');
    console.log('[codex] post-phone profile filled', {
      name: 'Thanh Loi',
      age: 23,
      url: this.getPageUrl(page),
    });
    const currentRoute = this.getCodexBrowserRoute(page) ?? 'about-you';
    await page
      .getByRole('button', { name: /finish creating account/i })
      .click();
    console.log('[codex] post-phone profile submitted', {
      url: this.getPageUrl(page),
    });
    await this.dispatchCurrentBrowserRoute(page, credentials, Date.now(), currentRoute);
  }

  private async completePhoneVerification(
    page: Page,
    credentials: ResolvedAccountCredentials,
  ): Promise<void> {
    if (!this.phoneVerificationProvider) return;

    console.log('[codex] phone verification started', {
      hasPhoneProvider: true,
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      let order: PhoneNumberResult | undefined;
      try {
        console.log('[codex] requesting SMSPool phone', { attempt });
        order = await this.phoneVerificationProvider.getPhoneNumber();
        console.log('[codex] SMSPool phone received', {
          attempt,
          orderId: order.orderId,
          phoneSuffix: order.phoneNumber.slice(-4),
          expiresAt: order.expiresAt,
        });
        const phoneInput = page.locator(
          'input[type="tel"]:visible, input[placeholder*="+1"]:visible, input[placeholder*="phone" i]:visible, input[name*="phone" i]:visible, input[id*="phone" i]:visible',
        );
        const digits = order.phoneNumber.replace(/\D/g, '');
        const phoneNumber =
          digits.length === 11 && digits.startsWith('1')
            ? digits.slice(1)
            : digits;
        console.log('[codex] filling phone input', {
          attempt,
          orderId: order.orderId,
          phoneLength: phoneNumber.length,
          url: this.getPageUrl(page),
        });
        await phoneInput.fill(phoneNumber);
        console.log('[codex] phone input filled; clicking Continue', {
          attempt,
          orderId: order.orderId,
          url: this.getPageUrl(page),
        });
        await page.getByRole('button', { name: /continue/i }).last().click();
        console.log('[codex] phone Continue clicked; waiting for phone OTP', {
          attempt,
          orderId: order.orderId,
          url: this.getPageUrl(page),
        });
        if (await this.hasPhoneSubmissionFallback(page)) {
          console.warn('[codex] phone submission rejected; refunding order', {
            attempt,
            orderId: order.orderId,
            url: this.getPageUrl(page),
          });
          await this.phoneVerificationProvider.refund(
            order.orderId,
            order.expiresAt,
          );
          order = undefined;
          await this.selectTextMessage(page);
          console.log('[codex] switched verification method back to Text message');
          continue;
        }

        const codeInput = page.locator(
          'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[id*="code" i]',
        );
        await this.waitForVisible(page, codeInput, 30_000, 'phone verification code input');
        console.log('[codex] phone code input visible; polling SMSPool', {
          orderId: order.orderId,
        });
        const result = await this.phoneVerificationProvider.getCode(
          order.orderId,
        );
        console.log('[codex] SMSPool phone code result', {
          orderId: order.orderId,
          received: result.received,
          hasCode: Boolean(result.code),
        });
        if (!result.received || !result.code) {
          console.log('[codex] SMSPool code unavailable; refunding order', {
            orderId: order.orderId,
          });
          await this.phoneVerificationProvider.refund(
            order.orderId,
            order.expiresAt,
          );
          order = undefined;
          await this.returnToPhoneEntryPage(page);
          continue;
        }
        await codeInput.fill(result.code);
        console.log('[codex] phone code filled');
        const currentRoute = this.getCodexBrowserRoute(page) ?? 'add-phone';
        await page.getByRole('button', { name: /continue/i }).last().click();
        console.log('[codex] phone code Continue clicked');
        if (this.getCodexBrowserRoute(page) !== currentRoute) {
          await this.dispatchCurrentBrowserRoute(
            page,
            credentials,
            Date.now(),
            currentRoute,
          );
        }
        return;
      } catch (error) {
        console.error('[codex] phone verification failed', {
          attempt,
          orderId: order?.orderId,
          url: this.getPageUrl(page),
          error: error instanceof Error ? error.message : String(error),
        });
        if (order) {
          console.log('[codex] refunding failed phone order', {
            orderId: order.orderId,
          });
          await this.phoneVerificationProvider
            .refund(order.orderId, order.expiresAt)
            .catch((refundError) =>
              console.error('[codex] phone order refund failed', {
                orderId: order?.orderId,
                error:
                  refundError instanceof Error
                    ? refundError.message
                    : String(refundError),
              }),
            );
        }
        if (order) {
          await this.returnToPhoneEntryPage(page).catch((navigationError) =>
            console.error('[codex] returning to phone entry failed', {
              error:
                navigationError instanceof Error
                  ? navigationError.message
                  : String(navigationError),
            }),
          );
        }
        if (attempt === 5) throw error;
      }
    }

    console.error('[codex] phone verification exhausted retries');
    throw new ServiceUnavailableException(
      'Phone verification code was not received',
    );
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.config.browserEngine === 'camoufox') {
      // Camoufox is ESM-only; load it only for the explicit opt-in engine.
      const { Camoufox } = await import('camoufox-js');
      return Camoufox({
        headless: false,
        humanize: 0.5,
      });
    }

    return chromium.launch({ headless: false }) as unknown as Browser;
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
