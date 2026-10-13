import express from 'express';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(express.static(join(process.cwd(), 'public')));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
