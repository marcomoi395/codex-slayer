import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CodexModule } from './codex/codex.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), CodexModule],
})
export class AppModule {}
