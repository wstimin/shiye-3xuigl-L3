import { applyDecorators, Body, Controller, Get, Header, Put, UseGuards } from '@nestjs/common';
import { settingsUpdateSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('public/branding')
  @NoStore()
  async publicBranding() {
    return { settings: await this.settings.publicSettings() };
  }

  @Get('public/settings')
  @NoStore()
  async publicSettings() {
    return { settings: await this.settings.publicSettings() };
  }

  @Get('admin/settings')
  @NoStore()
  @UseGuards(AuthGuard)
  @Roles('admin')
  async adminSettings() {
    return this.settings.adminSettings();
  }

  @Put('admin/settings')
  @NoStore()
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateSettings(@Body(new ZodValidationPipe(settingsUpdateSchema)) body: z.infer<typeof settingsUpdateSchema>) {
    return this.settings.updateSettings(body);
  }
}

function NoStore() {
  return applyDecorators(
    Header('Cache-Control', 'no-store, no-cache, must-revalidate'),
    Header('Pragma', 'no-cache'),
    Header('Expires', '0')
  );
}
