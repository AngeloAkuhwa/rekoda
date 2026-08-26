import { Module } from '@nestjs/common';
import { RiskPolicyService } from './risk-policy.service.js';

/**
 * Risk policy is a module rather than a helper because every ingress needs
 * the SAME instance of the same rules. A second copy with its own table is
 * the alternate cheaper path Appendix D.3 exists to forbid.
 */
@Module({ providers: [RiskPolicyService], exports: [RiskPolicyService] })
export class RiskModule {}
