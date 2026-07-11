import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { DiagnosticsService } from './diagnostics.service.js';

@Controller('admin/diagnostics')
@UseGuards(AuthGuard)
@Roles('admin')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  overview() {
    return this.diagnostics.overview();
  }
}
