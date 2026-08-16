import {
  PhoneNumberResult,
  PhoneVerificationProviderOptions,
  RefundResult,
  VerificationCodeResult,
} from './phone-verification.types';

export abstract class PhoneVerificationProvider {
  abstract getPhoneNumber(
    options?: PhoneVerificationProviderOptions,
  ): Promise<PhoneNumberResult>;

  abstract getCode(orderId: string): Promise<VerificationCodeResult>;

  abstract refund(orderId: string, expiresAt?: number): Promise<RefundResult>;
}
