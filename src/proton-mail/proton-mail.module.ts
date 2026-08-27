import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';

import {
  PROTON_MAIL_CONFIG,
  PROTON_MAIL_DEFAULTS,
} from './proton-mail.constants';
import type { ProtonMailConfig } from './proton-mail.config';
import { ProtonMailController } from './proton-mail.controller';
import { ProtonMailService } from './proton-mail.service';

function getNumberConfig(
  configService: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(configService.get<string>(key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function createProtonMailConfig(
  configService: ConfigService,
): ProtonMailConfig {
  return {
    url:
      configService.get<string>('PROTON_MAIL_URL') ??
      PROTON_MAIL_DEFAULTS.url,
    email: configService.get<string>('PROTON_MAIL_EMAIL') ?? '',
    profileDir:
      configService.get<string>('PROTON_MAIL_PROFILE_DIR') ??
      PROTON_MAIL_DEFAULTS.profileDir,
    sender:
      configService.get<string>('PROTON_MAIL_SENDER') ??
      PROTON_MAIL_DEFAULTS.sender,
    keywords: (configService.get<string>('PROTON_MAIL_KEYWORDS') ?? '')
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean),
    pollIntervalMs: getNumberConfig(
      configService,
      'PROTON_MAIL_POLL_INTERVAL_MS',
      PROTON_MAIL_DEFAULTS.pollIntervalMs,
    ),
    pollTimeoutMs: getNumberConfig(
      configService,
      'PROTON_MAIL_POLL_TIMEOUT_MS',
      PROTON_MAIL_DEFAULTS.pollTimeoutMs,
    ),
    loginTimeoutMs: getNumberConfig(
      configService,
      'PROTON_MAIL_LOGIN_TIMEOUT_MS',
      PROTON_MAIL_DEFAULTS.loginTimeoutMs,
    ),
  };
}

@Module({
  imports: [ConfigModule],
  controllers: [ProtonMailController],
  providers: [
    {
      provide: PROTON_MAIL_CONFIG,
      inject: [ConfigService],
      useFactory: createProtonMailConfig,
    },
    ProtonMailService,
  ],
  exports: [ProtonMailService],
})
export class ProtonMailModule {}
