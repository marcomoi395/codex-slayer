import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PhoneVerificationModule } from './phone-verification/phone-verification.module';
import { SmsPoolModule } from './phone-verification/providers/smspool/smspool.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PhoneVerificationModule,
    SmsPoolModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
