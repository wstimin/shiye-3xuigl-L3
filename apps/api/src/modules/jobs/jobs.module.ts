import { Module } from '@nestjs/common';
import { XuiModule } from '../xui/xui.module.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

@Module({ imports: [XuiModule], controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
