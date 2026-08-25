import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { balanceLogListQuerySchema, clearHistorySchema, rechargeOrderListQuerySchema, renewalSchema, userRenewalSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { FinanceService } from './finance.service.js';

@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('admin/recharge-orders')
  @UseGuards(AuthGuard)
  @Roles('admin')
  rechargeOrders(@Query(new ZodValidationPipe(rechargeOrderListQuerySchema)) query: z.infer<typeof rechargeOrderListQuerySchema>) {
    return this.finance.rechargeOrders(query);
  }

  @Get('admin/balance-logs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  balanceLogs(@Query(new ZodValidationPipe(balanceLogListQuerySchema)) query: z.infer<typeof balanceLogListQuerySchema>) {
    return this.finance.balanceLogs(query);
  }

  @Delete('admin/recharge-orders/history')
  @UseGuards(AuthGuard)
  @Roles('admin')
  clearRechargeOrderHistory(@Body(new ZodValidationPipe(clearHistorySchema)) body: z.infer<typeof clearHistorySchema>) {
    if (body.confirmText !== 'CLEAR_RECHARGE_HISTORY') throw new BadRequestException('确认文本不正确');
    return this.finance.clearRechargeOrderHistoryRange(body.from, body.to);
  }

  @Delete('admin/balance-logs/history')
  @UseGuards(AuthGuard)
  @Roles('admin')
  clearBalanceLogHistory(@Body(new ZodValidationPipe(clearHistorySchema)) body: z.infer<typeof clearHistorySchema>) {
    if (body.confirmText !== 'CLEAR_BALANCE_HISTORY') throw new BadRequestException('确认文本不正确');
    return this.finance.clearBalanceLogHistoryRange(body.from, body.to);
  }

  @Post('user/renewals')
  @UseGuards(AuthGuard)
  @Roles('user')
  renew(@Body(new ZodValidationPipe(userRenewalSchema)) body: z.infer<typeof userRenewalSchema>, @CurrentUser() user: SessionUser) {
    return this.finance.renewCustomerNode(user.customerId || '', body.nodeId, body.months, user.username, body.requestId);
  }

  @Post('admin/customers/:id/nodes/:nodeId/renew')
  @UseGuards(AuthGuard)
  @Roles('admin')
  adminRenew(@Param('id') id: string, @Param('nodeId') nodeId: string, @Body(new ZodValidationPipe(renewalSchema)) body: z.infer<typeof renewalSchema>, @CurrentUser() user: SessionUser) {
    return this.finance.renewCustomerNode(id, nodeId, body.months, user.username, body.requestId);
  }
}
