import { NestFactory } from '@nestjs/core';
import express from 'express';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().use('/dashboard', express.static(join(process.cwd(), 'public')));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
