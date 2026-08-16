import { Injectable } from '@nestjs/common';

import { PhoneVerificationProvider } from './phone-verification.provider';
import {
  PhoneNumberResult,
  RefundResult,
  VerificationCodeResult,
} from './phone-verification.types';

@Injectable()
export class PhoneVerificationService extends PhoneVerificationProvider {
  getPhoneNumber(): Promise<PhoneNumberResult> {
    throw new Error('Not implemented');
  }

  getCode(_phoneNumber: string): Promise<VerificationCodeResult> {
    throw new Error('Not implemented');
  }

  refund(_phoneNumber: string): Promise<RefundResult> {
    throw new Error('Not implemented');
  }
}
