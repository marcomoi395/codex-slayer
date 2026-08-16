export interface PhoneNumberResult {
  phoneNumber: string;
  orderId: string;
  expiresAt?: number;
}

export interface VerificationCodeResult {
  code: string | null;
  received: boolean;
}

export interface RefundResult {
  refunded: boolean;
  orderId: string;
}

export interface BalanceResult {
  balance: number;
  currency?: string;
}

export interface PhoneVerificationProviderOptions {
  country: number;
  service: number;
  quantity: number;
  pricingOption: number;
}
