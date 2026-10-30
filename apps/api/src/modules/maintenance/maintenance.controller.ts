import { Body, Controller, Get, Param, Post, Req, Res, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { MaintenanceService } from './maintenance.service.js';

@Controller('admin/maintenance')
@UseGuards(AuthGuard)
@Roles('admin')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}
  @Get() status() { return this.maintenance.status(); }
  @Post('check') check() { return this.maintenance.check(); }
  @Post('update') update(@Body() body: { checkId?: unknown; confirmed?: unknown }) {
    if (body.confirmed !== true || typeof body.checkId !== 'string') throw new BadRequestException('请检测版本并确认更新');
    return this.maintenance.startUpdate(body.checkId);
  }
  @Post('backups') backup() { return this.maintenance.enqueue('backup'); }
  @Post('uploads') upload(@Req() request: Request) { return this.maintenance.upload(request); }
  @Post('restore') restore(@Body() body: { inspectionId?: unknown; confirmed?: unknown }) {
    if (body.confirmed !== true || typeof body.inspectionId !== 'string') throw new BadRequestException('请先校验备份并确认恢复');
    const source = this.maintenance.job(body.inspectionId);
    if (source.kind !== 'inspect' || source.state !== 'succeeded') throw new BadRequestException('请先上传并校验备份');
    return this.maintenance.enqueue('restore', { inspectionId: body.inspectionId, confirmed: true });
  }
  @Get('jobs/:id') job(@Param('id') id: string) { return this.maintenance.job(id); }
  @Get('backups/:id/download') download(@Param('id') id: string, @Res() response: Response) {
    const file = this.maintenance.download(id);
    response.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Content-Disposition': `attachment; filename="${file.name}"` });
    file.stream.on('error', () => response.destroy()); file.stream.pipe(response);
  }
}
