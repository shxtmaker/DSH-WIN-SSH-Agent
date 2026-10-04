---
description: "Linux Web profile layer that publishes a stable Harness instance identity and restricted SSH discovery descriptor."
kind: "package-bundle"
---

# @harness-remote/companion

English | [中文](README.zh.md)

## Summary

Identify one Linux Harness Web instance for an attaching Desktop. This bundle inserts a Companion route and writes a private descriptor after successful startup. A fixed-path SSH helper reads only allowlisted instance keys from that descriptor; `--identity` omits the launch credential for configuration. The package does not start or stop the Web service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this bundle in the same Linux profile that serves the remote Web page. The local Desktop controller must refer to the same `instanceKey`, expected instance identity, Web port, and fixed SSH helper path. Real Linux installation and service restart remain operator actions.

### What you get

The patch inserts `remote-workspace-companion` with `instanceKey: default`. Its authenticated `/api/remote-workspace/identity` route gives the controller a second identity check after Cookie exchange. The helper wrapper needs `DSH_HOME` and `DSH_REMOTE_INSTANCE_KEYS` set for the same service user.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

`private-files.ts` stores a stable instance ID and atomically writes a generation-specific descriptor under a `0700` subtree. `dsh-remote-info.mjs` rejects unsafe paths and keys outside its allowlist, limits output to 64 KiB, and emits only error codes on stderr. Removal deletes a descriptor only when its boot ID still matches.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Remote package group](../README.md) — the Linux Companion source.
- [Implementation status](../../../docs/implementation-status.md) — current verification boundary.

-----

<a id="model-experience"></a>
## Model Experience

None, as the Companion contributes only browser authentication identity and no model-facing content.

#### KV Cache effect

None; the Companion does not change remote prompts, requests, or Session history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to discovery:

- Linux and a Web listener bound to `127.0.0.1` are required.
- The service user must own the DSH_HOME and its private descriptor subtree; unsafe permissions or symlinks fail closed.
- The SSH helper wrapper and instance-key allowlist must be installed separately; the package does not configure SSH or frp.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
