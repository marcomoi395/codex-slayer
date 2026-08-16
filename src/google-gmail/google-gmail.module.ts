import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';

import {
  GOOGLE_GMAIL_CONFIG,
  GOOGLE_GMAIL_DEFAULTS,
} from './google-gmail.constants';
import type { GoogleGmailConfig } from './google-gmail.config';
import { GoogleGmailController } from './google-gmail.controller';
import { GoogleGmailService } from './google-gmail.service';

@Module({
  imports: [ConfigModule],
  controllers: [GoogleGmailController],
  providers: [
    {
      provide: GOOGLE_GMAIL_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): GoogleGmailConfig => ({
        clientId: configService.get<string>('GOOGLE_CLIENT_ID') ?? '',
        clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET') ?? '',
        redirectUri: configService.get<string>('GOOGLE_REDIRECT_URI') ?? '',
        authorizationUrl:
          configService.get<string>('GOOGLE_AUTHORIZATION_URL') ??
          GOOGLE_GMAIL_DEFAULTS.authorizationUrl,
        tokenUrl:
          configService.get<string>('GOOGLE_TOKEN_URL') ??
          GOOGLE_GMAIL_DEFAULTS.tokenUrl,
        scope: GOOGLE_GMAIL_DEFAULTS.scope,
        connectionId: configService.get<string>('GOOGLE_GMAIL_CONNECTION_ID'),
        showTokens: configService.get<string>('GOOGLE_GMAIL_SHOW_TOKENS') === 'true',
        stateTtlMs: GOOGLE_GMAIL_DEFAULTS.stateTtlMs,
      }),
    },
    GoogleGmailService,
  ],
  exports: [GoogleGmailService],
})
export class GoogleGmailModule {}
