import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';

import { CODEX_CONFIG, CODEX_DEFAULTS } from './codex.constants';
import type { CodexConfig } from './codex.config';
import { CodexController } from './codex.controller';
import { CodexService } from './codex.service';
@Module({
  imports: [ConfigModule],
  controllers: [CodexController],
  providers: [
    {
      provide: CODEX_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): CodexConfig => {
        const encryptionKey = configService.get<string>('CODEX_ENCRYPTION_KEY');
        const environment =
          configService.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
        if (environment === 'production' && !encryptionKey?.trim()) {
          throw new Error('CODEX_ENCRYPTION_KEY is required in production');
        }
        return {
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
          databasePath:
            configService.get<string>('CODEX_DATABASE_PATH') ??
            'codex-accounts.sqlite',
          encryptionKey,
          stateTtlMs: CODEX_DEFAULTS.stateTtlMs,
        };
      },
    },
    CodexService,
  ],
  exports: [CodexService],
})
export class CodexModule {}
