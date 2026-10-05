import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Configuration shared with the fixed-path info helper's instance-key allowlist. */
export interface Config {
    /** Allowlisted identifier shared by the descriptor and restricted helper. */
    readonly instanceKey: string;
}
/** Required Host services. */
export declare const inject: string[];
/** Validated remote instance key. */
export declare const Config: z<Config>;
/** Register an authenticated identity route and publish this boot's private descriptor after readiness. */
export declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map