import { Controller, Get, Post, Query } from '@nestjs/common';

import { CodexService } from './codex.service';

@Controller('auth/codex')
export class CodexController {
  constructor(private readonly codexService: CodexService) {}

  @Get('authorize')
  createAuthorizationLink() {
    return this.codexService.createAuthorizationLink();
  }

  @Post('accounts')
  startAccountFlow() {
    return this.codexService.startAccountFlow();
  }

  @Get('callback')
  callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    return this.codexService.handleCallback(code, state, error);
  }
}
