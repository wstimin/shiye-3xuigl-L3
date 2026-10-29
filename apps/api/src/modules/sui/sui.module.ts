import { Module } from '@nestjs/common';
import { SuiController } from './sui.controller.js';
import { SuiService } from './sui.service.js';
import { SuiBusinessService } from './sui-business.service.js';

@Module({
  controllers: [SuiController],
  providers: [SuiService, SuiBusinessService],
  exports: [SuiService, SuiBusinessService]
})
export class SuiModule {}
