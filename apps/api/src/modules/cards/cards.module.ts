import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';
import { ExternalCardsService } from './external-cards.service.js';

@Module({ controllers: [CardsController], providers: [CardsService, ExternalCardsService], exports: [CardsService] })
export class CardsModule {}
