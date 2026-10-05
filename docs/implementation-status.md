# Verification status

The source and pinned Harness commits are recorded in source-baseline.json. Protocol version is 1 and plugin version is 0.1.0.

See [verification.json](verification.json) for measured split, build, and test results. Installed Desktop/Linux business acceptance, real frp recovery, and real-system cleanup remain notRun.

On 2026-10-05, direct Git installation was repaired by declaring the root as a Harness bundle with committed Companion runtime files. Real pnpm Git installation and the Harness bundle reader passed on Windows. WSL Ubuntu passed installation and bundle selection through the distributed Harness CLI, then loaded Companion through Harness runtime resolution. Temporary service fixtures verified descriptor publication, native permissions, identity queries, and disposal. The root runtime is byte-for-byte identical to the existing Companion artifact; the Companion business implementation is unchanged.

The initial failure and successful commands are recorded in `docs/evidence/git-install-*.txt`. Reinstallation in the Ubuntu Desktop shown in the reported screenshot remains notRun.

A subsequent startup fix addresses `remote-companion: unsafe private directory`. Linux regressions reproduced an owned 0775 DSH_HOME and overly readable reused private directories. Companion now validates directory type, ownership, and descriptor inode before removing excessive permissions. Symlinks, foreign-owned directories, and world-writable directories remain rejected. This change modifies Companion source and rebuilds both the standalone archive and committed Git runtime.

Native permission regressions, real Git installation followed by runtime activation, identity routing, restricted helper queries, and descriptor disposal passed in isolated WSL Ubuntu with fixture services. Evidence is in `docs/evidence/permissions-*.txt`. User-provided terminal output confirms the screenshot machine has an owned 0775 `.dsh` and no private subtree, matching the failing regression. SSH to that machine was refused.

The user subsequently reported an installed runtime SHA-256 matching the repaired file, while the screenshot still referenced original runtime line numbers. After fully restarting the Harness process running the web profile, the user confirmed Agent enabled successfully. Installed-host activation is user-reported passed; the separate two-machine SSH/frp workflow remains notRun.
