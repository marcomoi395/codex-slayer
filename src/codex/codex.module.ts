import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';

import { GoogleGmailModule } from '../google-gmail/google-gmail.module';
import { CODEX_CONFIG, CODEX_DEFAULTS } from './codex.constants';
import type { CodexConfig } from './codex.config';
import { CodexController } from './codex.controller';
import { CodexService } from './codex.service';

@Module({
  imports: [ConfigModule, GoogleGmailModule],
  controllers: [CodexController],
  providers: [
    {
      provide: CODEX_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): CodexConfig => ({
        clientId:
          configService.get<string>('CODEX_CLIENT_ID') ??
          'app_EMoamEEZ73f0CkXaXp7hrann',
        authorizationUrl:
          configService.get<string>('CODEX_AUTHORIZATION_URL') ??
          CODEX_DEFAULTS.authorizationUrl,
        tokenUrl:
          configService.get<string>('CODEX_TOKEN_URL') ??
          CODEX_DEFAULTS.tokenUrl,
        scope: CODEX_DEFAULTS.scope,
        callbackHost:
          configService.get<string>('CODEX_CALLBACK_HOST') ??
          CODEX_DEFAULTS.callbackHost,
        callbackPort:
          configService.get<number>('CODEX_CALLBACK_PORT') ??
          CODEX_DEFAULTS.callbackPort,
        callbackPath: CODEX_DEFAULTS.callbackPath,
        createAccountUrl:
          configService.get<string>('CODEX_CREATE_ACCOUNT_URL') ??
          CODEX_DEFAULTS.createAccountUrl,
        browserEngine:
          configService.get<string>('CODEX_BROWSER') === 'playwright'
            ? 'playwright'
            : CODEX_DEFAULTS.browserEngine,
        stateTtlMs: CODEX_DEFAULTS.stateTtlMs,
      }),
    },
    CodexService,
  ],
  exports: [CodexService],
})
export class CodexModule {}
