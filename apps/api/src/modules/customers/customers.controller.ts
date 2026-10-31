import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { balanceAdjustSchema, customerListQuerySchema, customerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { CustomersService } from './customers.service.js';

@Controller()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('admin/customers')
  @UseGuards(AuthGuard)
  @Roles('admin')
  list(@Query(new ZodValidationPipe(customerListQuerySchema)) query: z.infer<typeof customerListQuerySchema>) {
    return this.customers.list(query);
  }

  @Post('admin/customers')
  @UseGuards(AuthGuard)
  @Roles('admin')
  create(@Body(new ZodValidationPipe(customerUpsertSchema)) body: z.infer<typeof customerUpsertSchema>) {
    return this.customers.create(body);
  }

  @Patch('admin/customers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(customerUpsertSchema.partial(), true)) body: Partial<z.infer<typeof customerUpsertSchema>>) {
    return this.customers.update(id, body);
  }

  @Get('admin/customers/:id/secrets')
  @UseGuards(AuthGuard)
  @Roles('admin')
  secrets(@Param('id') id: string) {
    return this.customers.secrets(id);
  }

  @Delete('admin/customers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.customers.remove(id);
  }

  @Post('admin/customers/:id/balance-adjustments')
  @UseGuards(AuthGuard)
  @Roles('admin')
  adjustBalance(@Param('id') id: string, @Body(new ZodValidationPipe(balanceAdjustSchema)) body: z.infer<typeof balanceAdjustSchema>, @CurrentUser() user: SessionUser) {
    return this.customers.adjustBalance(id, body, user.username);
  }

  @Get('user/me')
  @UseGuards(AuthGuard)
  @Roles('user')
  me(@CurrentUser() user: SessionUser) {
    return this.customers.userDashboard(user.customerId || '');
  }
}
