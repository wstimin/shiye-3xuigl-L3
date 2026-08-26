import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { networkRouteUpsertSchema, outboundImportPreviewSchema, outboundImportSchema, remoteClientCreateSchema, remoteClientPatchSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { XuiService } from './xui.service.js';

@Controller()
export class XuiController {
  constructor(private readonly xui: XuiService) {}

  @Post('admin/xui/test')
  @UseGuards(AuthGuard)
  @Roles('admin')
  test(@Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) { return this.xui.testConnection(body); }

  @Post('admin/xui-servers/:id/test-draft')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testStoredServerDraft(@Param('id') id: string, @Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) {
    return this.xui.testStoredServerDraft(id, body);
  }

  @Post('admin/xui/certs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testCertFiles(@Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) { return this.xui.testConnectionCertFiles(body); }

  @Post('admin/xui-servers/:id/certs-draft')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testStoredServerDraftCertFiles(@Param('id') id: string, @Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) {
    return this.xui.testStoredServerDraftCertFiles(id, body);
  }

  @Post('admin/xui-servers/:id/test')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testStoredServer(@Param('id') id: string) { return this.xui.testStoredServer(id); }

  @Post('admin/xui-servers/:id/detect-version')
  @UseGuards(AuthGuard)
  @Roles('admin')
  detectVersion(@Param('id') id: string) { return this.xui.detectStoredServerVersion(id); }

  @Post('admin/xui-servers/:id/reality-detect')
  @UseGuards(AuthGuard)
  @Roles('admin')
  detectReality(@Param('id') id: string) { return this.xui.detectRealityTarget(id); }

  @Get('admin/xui-servers/:id/certs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  storedServerCertFiles(@Param('id') id: string) { return this.xui.storedServerCertFiles(id); }

  @Get('admin/xui-servers/:id/status')
  @UseGuards(AuthGuard)
  @Roles('admin')
  storedServerStatus(@Param('id') id: string) { return this.xui.storedServerStatus(id); }

  @Get('admin/xui-servers/:id/client-presence')
  @UseGuards(AuthGuard)
  @Roles('admin')
  storedServerClientPresence(@Param('id') id: string) { return this.xui.storedServerClientPresence(id); }

  @Get('admin/sync-logs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncLogs(@Query() query: { serverId?: string; action?: string; status?: string; limit?: string }) {
    return this.xui.syncLogs(query);
  }

  @Post('admin/xui-servers/:id/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServer(@Param('id') id: string) { return this.xui.syncServer(id); }

  @Post('admin/xui-servers/:id/sync-socks')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServerSocksOutbounds(@Param('id') id: string) { return this.xui.syncServerSocksOutbounds(id); }

  @Get('admin/network-outbounds')
  @UseGuards(AuthGuard)
  @Roles('admin')
  networkOutbounds(@Query('serverId') serverId?: string) { return this.xui.listNetworkOutbounds(serverId); }

  @Post('admin/network-outbounds/preview')
  @UseGuards(AuthGuard)
  @Roles('admin')
  previewOutbound(@Body(new ZodValidationPipe(outboundImportPreviewSchema)) body: z.infer<typeof outboundImportPreviewSchema>) {
    return this.xui.previewOutboundImport(body);
  }

  @Post('admin/network-outbounds/import')
  @UseGuards(AuthGuard)
  @Roles('admin')
  importOutbound(@Body(new ZodValidationPipe(outboundImportSchema)) body: z.infer<typeof outboundImportSchema>) {
    return this.xui.importNetworkOutbounds(body);
  }

  @Delete('admin/network-outbounds/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteOutbound(@Param('id') id: string, @Query('remote') remote?: string, @Query('takeover') takeover?: string) {
    return this.xui.deleteNetworkOutbound(
      id,
      remote === 'true' || remote === '1',
      takeover === 'true' || takeover === '1'
    );
  }

  @Get('admin/network-routes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  networkRoutes(@Query('serverId') serverId?: string) { return this.xui.listNetworkRoutes(serverId); }

  @Post('admin/network-routes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createNetworkRoute(@Body(new ZodValidationPipe(networkRouteUpsertSchema)) body: z.infer<typeof networkRouteUpsertSchema>) {
    return this.xui.upsertNetworkRoute(body);
  }

  @Patch('admin/network-routes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateNetworkRoute(@Param('id') id: string, @Body(new ZodValidationPipe(networkRouteUpsertSchema)) body: z.infer<typeof networkRouteUpsertSchema>) {
    return this.xui.upsertNetworkRoute(body, id);
  }

  @Delete('admin/network-routes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteNetworkRoute(@Param('id') id: string, @Query('remote') remote?: string, @Query('takeover') takeover?: string) {
    return this.xui.deleteNetworkRoute(
      id,
      remote === 'true' || remote === '1',
      takeover === 'true' || takeover === '1'
    );
  }

  @Post('admin/service-nodes/:id/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServiceNode(@Param('id') id: string) { return this.xui.syncServiceNode(id); }

  @Post('admin/service-nodes/:id/set-enable')
  @UseGuards(AuthGuard)
  @Roles('admin')
  setServiceNodeEnable(@Param('id') id: string, @Body() body: { enable?: boolean }) {
    return this.xui.setServiceNodeRemoteEnable(id, body.enable === true);
  }

  @Post('admin/service-nodes/:id/reset-traffic')
  @UseGuards(AuthGuard)
  @Roles('admin')
  resetServiceNodeTraffic(@Param('id') id: string) { return this.xui.resetServiceNodeTraffic(id); }

  @Post('admin/service-nodes/:id/remote-client')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createServiceNodeRemoteClient(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(remoteClientCreateSchema)) body: z.infer<typeof remoteClientCreateSchema>
  ) {
    return this.xui.createServiceNodeRemoteClient(id, body);
  }

  @Patch('admin/service-nodes/:id/remote-client')
  @UseGuards(AuthGuard)
  @Roles('admin')
  patchServiceNodeRemoteClient(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(remoteClientPatchSchema)) body: z.infer<typeof remoteClientPatchSchema>
  ) {
    return this.xui.patchServiceNodeRemoteClient(id, body);
  }

  @Delete('admin/service-nodes/:id/remote-client')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteServiceNodeRemoteClient(@Param('id') id: string, @Query('keepTraffic') keepTraffic?: string) {
    return this.xui.deleteServiceNodeRemoteClient(id, keepTraffic === 'true' || keepTraffic === '1');
  }

  @Post('admin/customers/:id/nodes/:nodeId/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.refreshCustomerNodeBinding(id, nodeId);
  }

  @Post('admin/customers/:id/nodes/:nodeId/remote-client')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createCustomerNodeRemoteClient(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(remoteClientCreateSchema)) body: z.infer<typeof remoteClientCreateSchema>
  ) {
    return this.xui.createCustomerNodeRemoteClient(id, nodeId, body);
  }

  @Patch('admin/customers/:id/nodes/:nodeId/remote-client')
  @UseGuards(AuthGuard)
  @Roles('admin')
  patchCustomerNodeRemoteClient(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(remoteClientPatchSchema)) body: z.infer<typeof remoteClientPatchSchema>
  ) {
    return this.xui.patchCustomerNodeRemoteClient(id, nodeId, body);
  }

  @Delete('admin/customers/:id/nodes/:nodeId/remote-client')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteCustomerNodeRemoteClient(@Param('id') id: string, @Param('nodeId') nodeId: string, @Query('keepTraffic') keepTraffic?: string) {
    return this.xui.deleteCustomerNodeRemoteClient(id, nodeId, keepTraffic === 'true' || keepTraffic === '1');
  }

  @Get('admin/customers/:id/nodes/:nodeId/traffic')
  @UseGuards(AuthGuard)
  @Roles('admin')
  customerNodeTraffic(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.customerNodeTraffic(id, nodeId);
  }

  @Post('admin/customers/:id/nodes/:nodeId/reset-traffic')
  @UseGuards(AuthGuard)
  @Roles('admin')
  resetCustomerNodeTraffic(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.resetCustomerNodeTraffic(id, nodeId);
  }
}
