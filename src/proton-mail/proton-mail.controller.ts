import { BadRequestException, Body, Controller, Post } from '@nestjs/common';

import { ProtonMailService } from './proton-mail.service';

@Controller('auth/proton-mail')
export class ProtonMailController {
  constructor(private readonly protonMailService: ProtonMailService) {}

  @Post('check-email')
  checkEmail(@Body() body: { email?: string }) {
    if (typeof body?.email !== 'string' || !body.email.trim()) {
      throw new BadRequestException('email is required');
    }

    return this.protonMailService.checkEmail(body.email.trim());
  }

  @Post('verification-code')
  getVerificationCode(
    @Body() body: { credential?: { connectionId?: string } },
  ) {
    const connectionId = body?.credential?.connectionId;
    if (!connectionId) {
      throw new BadRequestException('credential.connectionId is required');
    }

    return this.protonMailService.getLatestOpenAiVerificationCode(connectionId);
  }

  @Post('login')
  startLogin() {
    return this.protonMailService.startManualLogin();
  }

  @Post('login/complete')
  completeLogin() {
    return this.protonMailService.completeManualLogin();
  }
}
