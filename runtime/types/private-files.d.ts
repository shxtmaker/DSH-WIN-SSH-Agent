/** Credential-bearing descriptor stored only under a private DSH home. */
export interface InstanceDescriptor {
    readonly protocolVersion: 1;
    readonly instanceKey: string;
    readonly instanceId: string;
    readonly bootId: string;
    readonly profile: string;
    readonly workspaceHint: string;
    readonly port: number;
    readonly launchUrl: string;
}
/** Facts that tie one stored descriptor to the process that is still running. */
export interface DescriptorIdentity {
    /** Boot generation ID of the running Companion. */
    readonly bootId: string;
    /** Stable instance ID persisted under the private DSH home. */
    readonly instanceId: string;
    /** Loopback port of the running Harness Web listener. */
    readonly port: number;
}
/** Prepare private directories and load or create one stable instance id. */
export declare function instanceStorage(home: string, instanceKey: string): Promise<{
    readonly instanceId: string;
    readonly descriptorPath: string;
}>;
/** Atomically replace only a safe descriptor with a private temporary file. */
export declare function writeDescriptor(path: string, value: InstanceDescriptor): Promise<void>;
/** Delete only the file still naming this process's boot generation. */
export declare function removeDescriptor(path: string, bootId: string): Promise<void>;
/**
 * Return whether the stored descriptor still exists, stays private, and names
 * this running boot. A plugin reload, a plugin-manager run, an operator or any
 * other instance can remove or replace the file while this process keeps
 * running; the caller republishes whenever this check fails.
 */
export declare function descriptorMatches(path: string, expected: DescriptorIdentity): Promise<boolean>;
//# sourceMappingURL=private-files.d.ts.map