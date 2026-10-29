import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import {
  suiControlSchema,
  suiSaveSchema,
  suiServerSchema
} from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { SuiService } from './sui.service.js';
import { SuiBusinessService, suiLinkSchema } from './sui-business.service.js';

@Controller('admin/sui-servers')
@UseGuards(AuthGuard)
@Roles('admin')
export class SuiController {
  constructor(
    private readonly sui: SuiService,
    private readonly business: SuiBusinessService
  ) {}
  @Post(':id/business-link') link(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suiLinkSchema))
    body: z.infer<typeof suiLinkSchema>
  ) {
    return this.business.link(id, body);
  }
  @Post(':id/sync') sync(@Param('id') id: string) {
    return this.business.sync(id);
  }
  @Get(':id/business-nodes') businessNodes(@Param('id') id: string) {
    return this.business.list(id);
  }
  @Get() list() {
    return this.sui.list();
  }
  @Get(':id/secrets') secrets(@Param('id') id: string) {
    return this.sui.secrets(id);
  }
  @Post() create(
    @Body(new ZodValidationPipe(suiServerSchema))
    input: z.infer<typeof suiServerSchema>
  ) {
    return this.sui.upsert(input);
  }
  @Patch(':id') update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suiServerSchema))
    input: z.infer<typeof suiServerSchema>
  ) {
    return this.sui.upsert(input, id);
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return this.sui.remove(id);
  }
  @Post(':id/test') test(@Param('id') id: string) {
    return this.sui.test(id);
  }
  @Get(':id/resources/:resource') read(
    @Param('id') id: string,
    @Param('resource') resource: string,
    @Query('id') remoteId?: string
  ) {
    return this.sui.read(id, resource, remoteId);
  }
  @Post(':id/save') save(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suiSaveSchema))
    input: z.infer<typeof suiSaveSchema>
  ) {
    return this.sui.save(id, input);
  }
  @Post(':id/control') control(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suiControlSchema))
    input: z.infer<typeof suiControlSchema>
  ) {
    return this.sui.control(id, input);
  }
}
