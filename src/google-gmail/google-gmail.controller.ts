import { BadRequestException, Controller, Get, Query, Redirect } from '@nestjs/common';

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
  @Get('test')
  testAuthorization() {
    return this.googleGmailService.createAuthorization();
  }

  @Get('callback')
  callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error) {
      throw new BadRequestException(`Google OAuth authorization failed: ${error}`);
    }

    if (!code || !state) {
      throw new BadRequestException('Google OAuth callback requires code and state');
    }

    return this.googleGmailService.exchangeCode(code, state);
  }
}
