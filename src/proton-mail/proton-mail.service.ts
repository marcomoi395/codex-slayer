
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { PROTON_MAIL_CONFIG } from './proton-mail.constants';
import type { ProtonMailConfig } from './proton-mail.config';
import type {
  ProtonMailBrowser,
  ProtonMailLoginResult,
  ProtonMailLoginStatus,
  ProtonMailPage,
  ProtonMailResponseListener,
} from './proton-mail.types';

interface ProtonMailConversationSender {
  Name?: string;
  Address?: string;
}

interface ProtonMailConversation {
  ID?: string;
  Order?: number;
  Time?: number;
  Subject?: string;
  Senders?: ProtonMailConversationSender[];
}

interface ProtonMailConversationResponse {
  Conversations?: ProtonMailConversation[];
}

@Injectable()
export class ProtonMailService {
  private loginBrowser: ProtonMailBrowser | null = null;
  private verificationBrowser: ProtonMailBrowser | null = null;
  private loginStatus: ProtonMailLoginStatus = 'login_failed';

  constructor(
    @Inject(PROTON_MAIL_CONFIG) private readonly config: ProtonMailConfig,
  ) {}

  checkEmail(email: string): { connectionId: string | null } {
    return {
      connectionId:
        email.trim().toLowerCase() === this.config.email.trim().toLowerCase()
          ? this.connectionId
          : null,
    };
  }

  startManualLogin(): ProtonMailLoginResult {
    if (this.loginBrowser || this.loginStatus === 'login_started') {
      return { status: 'login_in_progress' };
    }
    if (this.loginStatus === 'login_completed') {
      return { status: 'login_completed' };
    }

    this.loginStatus = 'login_started';
    void this.openManualLogin();
    return { status: 'login_started' };
  }

  async completeManualLogin(): Promise<ProtonMailLoginResult> {
    if (this.loginStatus === 'login_completed') {
      return { status: 'login_completed' };
    }
    if (!this.loginBrowser) {
      throw new ConflictException('No Proton Mail login session is active');
    }

    const browser = this.loginBrowser;
    this.loginBrowser = null;
    try {
      await browser.close();
      this.loginStatus = 'login_completed';
      return { status: 'login_completed' };
    } catch {
      this.loginStatus = 'login_failed';
      throw new ServiceUnavailableException(
        'Proton Mail browser could not be closed',
      );
    }
  }

  private async openManualLogin(): Promise<void> {
    try {
      const browser = await this.launchBrowser();
      this.loginBrowser = browser;
      const page = await this.getBrowserPage(browser);
      await page.goto(this.config.url);
    } catch {
      this.loginStatus = 'login_failed';
      if (this.loginBrowser) {
        await this.loginBrowser.close();
        this.loginBrowser = null;
      }
    }
  }


  private async getBrowserPage(
    browser: ProtonMailBrowser,
  ): Promise<ProtonMailPage> {
    return browser.pages?.()[0] ?? (await browser.newPage());
  }
  async getLatestOpenAiVerificationCode(
    connectionId: string,
    requestedTime?: number,
  ): Promise<string> {
    if (connectionId !== this.connectionId) {
      throw new UnauthorizedException('Invalid Proton Mail connection');
    }

    let stage = 'browser_launch';
    try {
      this.verificationBrowser = await this.launchBrowser();
      stage = 'page_selection';
      const page = await this.getBrowserPage(this.verificationBrowser);
      const conversationsPromise = this.captureConversationsResponse(
        page,
        requestedTime,
      );

      stage = 'homepage_navigation';
      await page.goto(this.config.url);
      const matchingConversations = await conversationsPromise;
      const newestConversation = [...matchingConversations]
        .sort(
          (left, right) =>
            (right.Time ?? right.Order ?? 0) -
            (left.Time ?? left.Order ?? 0),
        )
        .find((conversation) => conversation.ID);

      if (!newestConversation?.ID) {
        throw new NotFoundException(
          'OpenAI verification conversation not found',
        );
      }

      const messageUrl = new URL(
        `/u/1/inbox/${encodeURIComponent(newestConversation.ID)}`,
        this.config.url,
      ).toString();
      stage = 'message_navigation';
      await page.goto(messageUrl);

      stage = 'message_content';
      const snapshot = await this.readVerificationSnapshot(page);
      const code = snapshot.match(/\b\d{6}\b/)?.[0];
      if (!code) {
        throw new NotFoundException(
          'OpenAI verification code not found in conversation',
        );
      }

      return code;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (this.verificationBrowser) {
        await this.verificationBrowser.close();
        this.verificationBrowser = null;
      }
      throw new ServiceUnavailableException(
        `Proton Mail verification message could not be opened during ${stage}`,
      );
    }
  }

  private async readVerificationSnapshot(page: ProtonMailPage): Promise<string> {
    if (!page.ariaSnapshot) {
      throw new ServiceUnavailableException(
        'Camoufox accessibility snapshot is unavailable',
      );
    }

    const deadline = Date.now() + 10_000;
    let lastSnapshot = '';

    while (Date.now() <= deadline) {
      lastSnapshot = await page.ariaSnapshot({ mode: 'ai' });
      const hasEmailSubject = /Your temporary ChatGPT/i.test(lastSnapshot);
      const hasSixDigitCode = /\b\d{6}\b/.test(lastSnapshot);

      if (hasEmailSubject && hasSixDigitCode) {
        return lastSnapshot;
      }

      await page.waitForTimeout(250);
    }

    throw new NotFoundException(
      `OpenAI verification code was not found in accessibility snapshot (length=${lastSnapshot.length})`,
    );
  }

  private captureConversationsResponse(
    page: ProtonMailPage,
    requestedTime?: number,
  ): Promise<ProtonMailConversation[]> {
    if (!page.on) {
      throw new ServiceUnavailableException(
        'Proton Mail network response listener is unavailable',
      );
    }

    const onResponse = page.on.bind(page);

    return new Promise<ProtonMailConversation[]>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        page.off?.('response', listener);
        resolve([]);
      }, 5_000);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        page.off?.('response', listener);
        callback();
      };

      const listener: ProtonMailResponseListener = (response) => {
        const rawResponseUrl = response.url();
        const responseUrl = new URL(rawResponseUrl);
        if (responseUrl.pathname !== '/api/mail/v4/conversations') {
          return;
        }

        void response
          .text()
          .then((body) => {
            const payload = JSON.parse(body) as ProtonMailConversationResponse;
            const conversations = payload.Conversations ?? [];

            if (conversations.length === 0) {
              return;
            }

            const matchingConversations = conversations.filter(
              (conversation) => {
                const senderMatched = (conversation.Senders ?? []).some(
                  (sender) =>
                    sender.Address?.trim().toLowerCase() ===
                    'noreply@tm.openai.com',
                );
                const subjectMatched = conversation.Subject?.trim()
                  .toLowerCase()
                  .startsWith('your temporary chatgpt');
                const timeMatched =
                  requestedTime === undefined ||
                  (typeof conversation.Time === 'number' &&
                    conversation.Time >= requestedTime);

                return senderMatched && subjectMatched && timeMatched;
              },
            );

            finish(() => resolve(matchingConversations));
          })
          .catch((error: unknown) => {
            finish(() => reject(error));
          });
      };

      onResponse('response', listener);
    });
  }


  private get connectionId(): string {
    return `proton:${this.config.email.trim().toLowerCase()}`;
  }

  private async launchBrowser(): Promise<ProtonMailBrowser> {
    try {
      // Camoufox is ESM-only; dynamic import keeps Nest's CommonJS build working.
      const { Camoufox } = await import('camoufox-js');
      return Camoufox({
        headless: false,
        user_data_dir: this.config.profileDir,
      });
    } catch {
      throw new ServiceUnavailableException(
        'Proton Mail browser is unavailable',
      );
    }
  }
}
