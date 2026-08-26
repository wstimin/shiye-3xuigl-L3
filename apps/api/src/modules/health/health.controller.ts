import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'shiye-api', version: '1.0.4', time: new Date().toISOString() };
  }
}
