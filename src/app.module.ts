import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PhoneVerificationModule } from './phone-verification/phone-verification.module';

@Module({
  imports: [PhoneVerificationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
