export declare const MANDATORY_LEGAL_VARS: readonly string[];
export declare function missingLegalVars(env: Record<string, string | undefined>): string[];
export declare function assertLegalIdentityConfigured(
  phase: string,
  env: Record<string, string | undefined>,
): void;
