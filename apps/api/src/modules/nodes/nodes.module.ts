import { Module } from '@nestjs/common';
import { XuiModule } from '../xui/xui.module.js';
import { NodesController } from './nodes.controller.js';
import { NodesService } from './nodes.service.js';
import { SuiModule } from '../sui/sui.module.js';
import { PanelNetworkController } from './panel-network.controller.js';
import { PanelNetworkService } from './panel-network.service.js';

@Module({ imports: [XuiModule, SuiModule], controllers: [NodesController, PanelNetworkController], providers: [NodesService, PanelNetworkService], exports: [NodesService] })
export class NodesModule {}
