import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GoogleGmailService } from './google-gmail.service';

@Controller('auth/google/gmail')
export class GoogleGmailController {
  constructor(private readonly googleGmailService: GoogleGmailService) {}

  @Get('authorize')
  @Redirect()
  authorize() {
    const authorization = this.googleGmailService.createAuthorization();

    return {
      url: authorization.authorizationUrl,
      statusCode: 302,
    };
  }

  @Get('connections')
  getConnections() {
    return this.googleGmailService.getConnections();
  }

  @Post('check-email')
  async checkEmail(@Body() body: { email?: string }) {
    if (typeof body?.email !== 'string' || !body.email.trim()) {
      throw new BadRequestException('email is required');
    }

    const connectionId = await this.googleGmailService.getCredentialConnectionId(
      body.email.trim(),
    );
    return { connectionId: connectionId ?? null };
  }

  @Post('verification-code')
  getVerificationCode(
    @Body() body: { credential?: { connectionId?: string } },
  ) {
    const connectionId = body?.credential?.connectionId;
    if (!connectionId) {
      throw new BadRequestException('credential.connectionId is required');
    }

    return this.googleGmailService.getLatestOpenAiVerificationCode(
      connectionId,
    );
  }

  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error) {
      throw new BadRequestException(
        `Google OAuth authorization failed: ${error}`,
      );
    }

    if (!code || !state) {
      throw new BadRequestException(
        'Google OAuth callback requires code and state',
      );
    }
    const connection = await this.googleGmailService.exchangeCode(code, state);

    const credentialPath = resolve(process.cwd(), 'credential.json');
    const credential = {
      connectionId: connection.connectionId,
      emailAddress: connection.emailAddress,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresIn: connection.expiresIn,
      expiresAt: connection.expiresAt,
      scope: connection.scope,
      tokenType: connection.tokenType,
    };
    let credentials: Record<string, unknown>[] = [];
    try {
      const content = await readFile(credentialPath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (Array.isArray(parsed)) {
        credentials = parsed.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null,
        );
      } else if (parsed && typeof parsed === 'object') {
        const storedCredentials = Reflect.get(parsed, 'credentials');
        const legacyCredential = Reflect.get(parsed, 'credential');
        const values = Array.isArray(storedCredentials)
          ? storedCredentials
          : [legacyCredential];
        credentials = values.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    credentials.push(credential);
    await writeFile(
      credentialPath,
      JSON.stringify({ credentials }, null, 2),
      'utf8',
    );
    return { url: '/dashboard/', statusCode: 302 };
  }
}
