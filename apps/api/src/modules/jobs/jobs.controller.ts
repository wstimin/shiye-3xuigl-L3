import { Controller, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { JobsService } from './jobs.service.js';

@Controller('admin/jobs')
@UseGuards(AuthGuard)
@Roles('admin')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('disable-expired')
  disableExpired() {
    return this.jobs.disableExpiredNodes('manual');
  }

  @Post('sync-traffic')
  syncTraffic() {
    throw new ServiceUnavailableException('流量同步任务暂未启用');
  }
}
