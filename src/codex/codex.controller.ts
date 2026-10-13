import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';

import { CodexService } from './codex.service';
import type { CodexAccountRequest } from './codex.types';

@Controller('auth/codex')
export class CodexController {
  constructor(private readonly codexService: CodexService) {}

  @Get('authorize')
  createAuthorizationLink() {
    return this.codexService.createAuthorizationLink();
  }

  @Get('status')
  getStatus() {
    return this.codexService.getStatus();
  }

  @Get('accounts')
  getAccounts() {
    return this.codexService.getAccounts();
  }
  @Post('accounts')
  startAccountFlow(@Body() credentials: CodexAccountRequest) {
    return this.codexService.startAccountFlow(credentials);
  }

  @Delete('accounts/:connectionId')
  async deleteAccount(@Param('connectionId') connectionId: string): Promise<void> {
    await this.codexService.deleteAccount(connectionId);
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
