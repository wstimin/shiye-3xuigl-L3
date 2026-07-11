import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module.js';
import { XuiModule } from '../xui/xui.module.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';

@Module({ imports: [JobsModule, XuiModule], controllers: [DiagnosticsController], providers: [DiagnosticsService] })
export class DiagnosticsModule {}
