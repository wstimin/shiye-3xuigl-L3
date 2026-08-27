import { Controller, Get } from '@nestjs/common';
import { readBuildInfo } from '../../shared/build-info.js';

const buildInfo = readBuildInfo();

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'shiye-api', ...buildInfo, time: new Date().toISOString() };
  }
}
