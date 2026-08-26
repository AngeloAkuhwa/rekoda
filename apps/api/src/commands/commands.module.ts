import { Module } from '@nestjs/common';
import { CommandBus } from './command-bus.service.js';
import { RiskModule } from '../risk/risk.module.js';

/**
 * The command layer, as a module, so every ingress reaches the SAME bus.
 * A second instance with its own gates is the alternate cheaper path spec
 * §25 and Appendix D.3 both exist to forbid.
 */
@Module({ imports: [RiskModule], providers: [CommandBus], exports: [CommandBus] })
export class CommandsModule {}
