import { Global, Module } from '@nestjs/common';
import { DatabaseLockService } from './database-lock.service.js';

@Global()
@Module({
  providers: [DatabaseLockService],
  exports: [DatabaseLockService]
})
export class DatabaseLockModule {}
