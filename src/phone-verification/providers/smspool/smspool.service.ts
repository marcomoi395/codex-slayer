import { setTimeout as wait } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';
import { PhoneVerificationProvider } from '../../phone-verification.provider';
import type {
  BalanceResult,
  PhoneNumberResult,
  PhoneVerificationProviderOptions,
  RefundResult,
  VerificationCodeResult,
} from '../../phone-verification.types';
import { SMSPOOL_CONFIG, SMSPOOL_DEFAULTS } from './smspool.constants';
import type { SmsPoolConfig } from './smspool.config';
import type {
  SmsPoolBalanceResponse,
  SmsPoolCancelResponse,
  SmsPoolOrder,
  SmsPoolOrderResponse,
} from './smspool.types';

@Injectable()
export class SmsPoolService extends PhoneVerificationProvider {
  constructor(@Inject(SMSPOOL_CONFIG) private readonly config: SmsPoolConfig) {
    super();
  }

  async getBalance(): Promise<BalanceResult> {
    const response =
      await this.request<SmsPoolBalanceResponse>('/request/balance');

    return {
      balance: Number(response.balance ?? 0),
      currency: response.currency,
    };
  }

  async getPhoneNumber(
    options: PhoneVerificationProviderOptions = {
      country: SMSPOOL_DEFAULTS.country,
      service: SMSPOOL_DEFAULTS.service,
      quantity: SMSPOOL_DEFAULTS.quantity,
      pricingOption: SMSPOOL_DEFAULTS.pricingOption,
    },
  ): Promise<PhoneNumberResult> {
    const response = await this.request<SmsPoolOrderResponse>('/purchase/sms', {
      country: options.country,
      service: options.service,
      quantity: options.quantity,
      pricing_option: options.pricingOption,
    });

    return {
      phoneNumber: this.required(
        response.phone_number ?? response.number,
        'phone number',
      ),
      orderId: this.required(response.order_id ?? response.orderid, 'order ID'),
      expiresAt: response.expires_at ?? response.expiry,
    };
  }

  async getCode(orderId: string): Promise<VerificationCodeResult> {
    const deadline = Date.now() + this.config.pollTimeoutMs;

    while (true) {
      const orders = await this.getOrders();
      const order = orders.find((item) => item.orderId === orderId);
      const code = order?.code ?? null;

      if (code) {
        return { code, received: true };
      }

      if (Date.now() >= deadline) {
        break;
      }

      await wait(this.config.pollIntervalMs);
    }

    return { code: null, received: false };
  }

  async refund(orderId: string, expiresAt?: number): Promise<RefundResult> {
    const response = await this.request<SmsPoolCancelResponse>('/sms/cancel', {
      orderid: orderId,
      expiry: expiresAt ?? Math.floor(Date.now() / 1000),
    });

    return {
      refunded: Boolean(response.refunded ?? response.success),
      orderId: response.order_id ?? response.orderid ?? orderId,
    };
  }

  private async getOrders(): Promise<SmsPoolOrder[]> {
    const response = await this.request<unknown>('/request/orders_new', {
      format: 2,
      limit: 1,
    });

    const data = this.asRecord(response);
    const rows = Array.isArray(response)
      ? response
      : (data.orders ?? data.data ?? []);

    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const item = this.asRecord(row);
      const orderId = item.order_id ?? item.orderid;
      const phoneNumber = item.phone_number ?? item.number;

      if (typeof orderId !== 'string' || typeof phoneNumber !== 'string') {
        return [];
      }

      return [
        {
          orderId,
          phoneNumber,
          code: this.readCode(item),
          expiresAt: this.readNumber(item.expires_at ?? item.expiry),
        },
      ];
    });
  }

  private async request<T>(
    path: string,
    body: Record<string, string | number> = {},
  ): Promise<T> {
    const payload = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, String(value)]),
      ),
      key: this.config.apiKey,
    });

    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`SMSPool request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private required(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`SMSPool response missing ${field}`);
    }

    return value;
  }

  private readCode(value: Record<string, unknown>): string | null {
    const code = value.code ?? value.sms_code ?? value.message;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }

  private readNumber(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  }
}
