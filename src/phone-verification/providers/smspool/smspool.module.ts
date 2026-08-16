import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';

import { PhoneVerificationModule } from '../../phone-verification.module';
import { PhoneVerificationProvider } from '../../phone-verification.provider';
import { SMSPOOL_CONFIG, SMSPOOL_DEFAULTS } from './smspool.constants';
import { SmsPoolConfig } from './smspool.config';
import { SmsPoolService } from './smspool.service';
import { SmsPoolController } from './smspool.controller';

@Module({
  imports: [ConfigModule, PhoneVerificationModule],
  controllers: [SmsPoolController],
  providers: [
    {
      provide: SMSPOOL_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): SmsPoolConfig => {
        const apiKey = configService.get<string>('SMSPOOL_API_KEY');

        if (!apiKey) {
          throw new Error('SMSPOOL_API_KEY is required');
        }

        return {
          apiKey,
          baseUrl:
            configService.get<string>('SMSPOOL_BASE_URL') ??
            SMSPOOL_DEFAULTS.baseUrl,
          pollIntervalMs: Number(
            configService.get<string>('SMSPOOL_POLL_INTERVAL_MS') ??
              SMSPOOL_DEFAULTS.pollIntervalMs,
          ),
          pollTimeoutMs: Number(
            configService.get<string>('SMSPOOL_POLL_TIMEOUT_MS') ??
              SMSPOOL_DEFAULTS.pollTimeoutMs,
          ),
        };
      },
    },
    SmsPoolService,
    {
      provide: PhoneVerificationProvider,
      useExisting: SmsPoolService,
    },
  ],
  exports: [SmsPoolService, PhoneVerificationProvider],
})
export class SmsPoolModule {}
