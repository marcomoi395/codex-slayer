import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { CodexService } from './codex.service';
import type { CodexAccountRequest } from './codex.types';

@Controller('auth/codex')
export class CodexController {
  constructor(private readonly codexService: CodexService) {}

  @Get('status')
  getStatus() {
    return this.codexService.getStatus();
  }

  @Get('accounts')
  getAccounts() {
    return this.codexService.getAccounts();
  }
  @Get('accounts/export')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="codex-accounts.txt"')
  @Header('Cache-Control', 'no-store')
  exportAccounts(): Promise<string> {
    return this.codexService.exportAccounts();
  }
  @Get('accounts/credentials/export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="codex-credentials.json"')
  @Header('Cache-Control', 'no-store')
  exportCredentials(): Promise<string> {
    return this.codexService.exportCredentials();
  }

  @Post('accounts/import')
  importAccounts(@Body('content') content: string) {
    return this.codexService.importAccounts(content);
  }

  @Post('accounts')
  saveAccount(@Body() credentials: CodexAccountRequest) {
    return this.codexService.saveAccount(credentials);
  }

  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  startBatch(
    @Body('connectionIds') connectionIds: string[],
  ): { started: true; runId: string } {
    if (
      !Array.isArray(connectionIds) ||
      connectionIds.length === 0 ||
      connectionIds.some((id) => typeof id !== 'string' || !id)
    ) {
      throw new BadRequestException('Select at least one Codex account');
    }
    const status = this.codexService.getStatus();
    if (status.active || status.batch?.active) {
      throw new BadRequestException('A Codex login flow is already active');
    }
    void this.codexService.startBatchFlow(connectionIds).catch(() => undefined);
    return { started: true, runId: this.codexService.getStatus().batch!.runId };
  }


  @Delete('accounts/:connectionId')
  async deleteAccount(
    @Param('connectionId') connectionId: string,
  ): Promise<void> {
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
