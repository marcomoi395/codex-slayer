import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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
  @Post('accounts')
  saveAccount(@Body() credentials: CodexAccountRequest) {
    return this.codexService.saveAccount(credentials);
  }

  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  startBatch(@Query('limit') limit?: string): { started: true } {
    const parsedLimit =
      limit === undefined ? undefined : this.parseBatchLimit(limit);
    const status = this.codexService.getStatus();
    if (status.active || status.batch?.active) {
      throw new BadRequestException('A Codex login flow is already active');
    }
    void this.codexService.startBatchFlow(parsedLimit).catch(() => undefined);
    return { started: true };
  }

  private parseBatchLimit(limit: string): number {
    const parsed = Number(limit);
    if (!/^\d+$/.test(limit) || !Number.isSafeInteger(parsed)) {
      throw new BadRequestException('Batch limit must be a non-negative integer');
    }
    return parsed;
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
