import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
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
  @Post('check-email')
  async checkEmail(@Body() body: { email?: string }) {
    if (typeof body?.email !== 'string' || !body.email.trim()) {
      throw new BadRequestException('email is required');
    }
    const email = body.email.trim();

    return { exists: await this.googleGmailService.hasCredentialEmail(email) };
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
    await writeFile(
      resolve(process.cwd(), 'credential.json'),
      JSON.stringify(
        {
          credential: {
            connectionId: connection.connectionId,
            emailAddress: connection.emailAddress,
            accessToken: connection.accessToken,
            refreshToken: connection.refreshToken,
            expiresIn: connection.expiresIn,
            expiresAt: connection.expiresAt,
            scope: connection.scope,
            tokenType: connection.tokenType,
          },
        },
        null,
        2,
      ),
    );
    return { message: 'Credential saved to credential.json' };
  }
}
