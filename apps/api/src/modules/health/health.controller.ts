import { Controller, Get } from '@nestjs/common';
import { readBuildInfo } from '../../shared/build-info.js';
import { maintenanceOperations } from '../../shared/maintenance-state.js';

const buildInfo = readBuildInfo();

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'shiye-api', ...buildInfo, maintenanceOperations: maintenanceOperations(), time: new Date().toISOString() };
  }
}
