import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Milliseconds between descriptor repairs. A plugin reload or a plugin-manager
 * run against the same profile disposes this activation and deletes the file,
 * and the replacement activation only republishes when it reaches readiness. */
export declare const REPAIR_INTERVAL_MS = 5000;
/** Configuration shared with the fixed-path info helper's instance-key allowlist. */
export interface Config {
    /** Allowlisted identifier shared by the descriptor and restricted helper. */
    readonly instanceKey: string;
}
/** Required Host services. */
export declare const inject: string[];
/** Validated remote instance key. */
export declare const Config: z<Config>;
/**
 * Register an authenticated identity route and keep this boot's private
 * descriptor present for as long as the process runs: publish at activation,
 * publish again on application readiness, and repair any later removal or
 * replacement from another activation. The restricted helper reads only this
 * file, so a missing descriptor makes every connection attempt fail until the
 * running Web process is restarted when no repair loop exists.
 */
export declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map