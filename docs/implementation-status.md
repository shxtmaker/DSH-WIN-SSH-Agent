# Verification status

The source and pinned Harness commits are recorded in source-baseline.json. Protocol version is 1 and plugin version is 0.1.0.

See [verification.json](verification.json) for measured split, build, and test results. Installed Desktop/Linux business acceptance, real frp recovery, and real-system cleanup remain notRun.

On 2026-10-05, direct Git installation was repaired by declaring the root as a Harness bundle with committed Companion runtime files. Real pnpm Git installation and the Harness bundle reader passed on Windows. WSL Ubuntu passed installation and bundle selection through the distributed Harness CLI, then loaded Companion through Harness runtime resolution. Temporary service fixtures verified descriptor publication, native permissions, identity queries, and disposal. The root runtime is byte-for-byte identical to the existing Companion artifact; the Companion business implementation is unchanged.

The initial failure and successful commands are recorded in `docs/evidence/git-install-*.txt`. Reinstallation in the Ubuntu Desktop shown in the reported screenshot remains notRun.
