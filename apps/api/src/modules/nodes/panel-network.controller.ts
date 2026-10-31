import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard } from "../../shared/auth.guard.js";
import { Roles } from "../../shared/roles.decorator.js";
import { ZodValidationPipe } from "../../shared/zod-validation.pipe.js";
import {
  PanelNetworkService,
  panelInboundCreateSchema,
  panelOutboundPublishSchema,
  suiOutboundImportSchema,
} from "./panel-network.service.js";
@Controller("admin/panel-servers/:id")
@UseGuards(AuthGuard)
@Roles("admin")
export class PanelNetworkController {
  constructor(private readonly network: PanelNetworkService) {}
  @Get("outbound-choices")
  choices(
    @Param("id")
    id: string,
  ) {
    return this.network.choices(id);
  }
  @Post("publish-outbound")
  publish(
    @Param("id")
    id: string,
    @Body(new ZodValidationPipe(panelOutboundPublishSchema))
    body: z.infer<typeof panelOutboundPublishSchema>,
  ) {
    return this.network.publish(id, body.source);
  }
  @Post("create-inbound")
  create(
    @Param("id")
    id: string,
    @Body(new ZodValidationPipe(panelInboundCreateSchema))
    body: z.infer<typeof panelInboundCreateSchema>,
  ) {
    return this.network.createInbound(id, body);
  }
  @Post("outbounds/preview")
  preview(
    @Param("id")
    id: string,
    @Body(new ZodValidationPipe(suiOutboundImportSchema))
    body: z.infer<typeof suiOutboundImportSchema>,
  ) {
    return this.network.previewSui(id, body);
  }
  @Post("outbounds/import")
  import(
    @Param("id")
    id: string,
    @Body(new ZodValidationPipe(suiOutboundImportSchema))
    body: z.infer<typeof suiOutboundImportSchema>,
  ) {
    return this.network.importSui(id, body);
  }
}
