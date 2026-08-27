export interface ProtonMailResponse {
  url(): string;
  text(): Promise<string>;
}

export type ProtonMailResponseListener = (
  response: ProtonMailResponse,
) => void;

export interface ProtonMailPage {
  goto(url: string): Promise<unknown>;
  on?(event: 'response', listener: ProtonMailResponseListener): void;
  off?(event: 'response', listener: ProtonMailResponseListener): void;
  url(): string;
  ariaSnapshot?(options?: {
    mode?: 'ai' | 'default';
    depth?: number;
  }): Promise<string>;
  isClosed?: () => boolean;
  locator(selector: string): ProtonMailLocator;
  frameLocator?(selector: string): ProtonMailFrameLocator;
  context?: () => ProtonMailContext;
  waitForTimeout(timeoutMs: number): Promise<unknown>;
  evaluate<T, A = undefined>(
    pageFunction: (arg: A) => T | Promise<T>,
    arg?: A,
  ): Promise<T>;
}

export interface ProtonMailContext {
  cookies(url?: string): Promise<ProtonMailCookie[]>;
}

export interface ProtonMailCookie {
  name: string;
  value: string;
}

export interface ProtonMailFrameLocator {
  locator(selector: string): ProtonMailLocator;
}

export interface ProtonMailLocator {
  count(): Promise<number>;
  nth(index: number): ProtonMailLocator;
  click(): Promise<unknown>;
  fill?(value: string): Promise<unknown>;
  press?(key: string): Promise<unknown>;
  innerText(): Promise<string>;
  getAttribute?(name: string): Promise<string | null>;
  allInnerTexts?(): Promise<string[]>;
  locator?(selector: string): ProtonMailLocator;
}

export interface ProtonMailBrowser {
  newPage(): Promise<ProtonMailPage>;
  pages?: () => ProtonMailPage[];
  close(): Promise<void>;
}
export type ProtonMailLoginStatus =
  | 'login_started'
  | 'login_in_progress'
  | 'login_completed'
  | 'login_timed_out'
  | 'login_failed';

export interface ProtonMailLoginResult {
  status: ProtonMailLoginStatus;
}
