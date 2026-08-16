import {
  PhoneNumberResult,
  RefundResult,
  VerificationCodeResult,
} from './phone-verification.types';

export abstract class PhoneVerificationProvider {
  abstract getPhoneNumber(): Promise<PhoneNumberResult>;

  abstract getCode(phoneNumber: string): Promise<VerificationCodeResult>;

  abstract refund(phoneNumber: string): Promise<RefundResult>;
}
