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
/** Prepare private directories and load or create one stable instance id. */
export declare function instanceStorage(home: string, instanceKey: string): Promise<{
    readonly instanceId: string;
    readonly descriptorPath: string;
}>;
/** Atomically replace only a safe descriptor with a private temporary file. */
export declare function writeDescriptor(path: string, value: InstanceDescriptor): Promise<void>;
/** Delete only the file still naming this process's boot generation. */
export declare function removeDescriptor(path: string, bootId: string): Promise<void>;
//# sourceMappingURL=private-files.d.ts.map