import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { SmsPoolService } from './smspool.service';

interface RefundRequest {
  orderId: string;
  expiresAt?: number;
}

@Controller('smspool')
export class SmsPoolController {
  constructor(private readonly smsPoolService: SmsPoolService) {}

  @Get('balance')
  getBalance() {
    return this.smsPoolService.getBalance();
  }
  @Get('orders')
  getPurchasedOrders() {
    return this.smsPoolService.getPurchasedOrders();
  }

  @Post('phone-number')
  getPhoneNumber() {
    return this.smsPoolService.getPhoneNumber();
  }

  @Get('code/:orderId')
  getCode(@Param('orderId') orderId: string) {
    return this.smsPoolService.getCode(orderId);
  }

  @Post('refund')
  refund(@Body() body: RefundRequest) {
    return this.smsPoolService.refund(body.orderId, body.expiresAt);
  }
}
