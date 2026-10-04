---
description: "Linux Web profile 层：发布稳定 Harness 实例身份和受限 SSH 发现描述。"
kind: "package-bundle"
---

# @harness-remote/companion

[English](README.md) | 中文

## 概述

为附着的 Desktop 标识一个 Linux Harness Web 实例。此 bundle 插入 Companion 路由，并在成功启动后写入私有描述文件。固定路径 SSH helper 仅按 allowlist 读取实例键；`--identity` 在配置时省略启动凭据。此包不启动或停止 Web 服务。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将此 bundle 挂载到提供远端 Web 页面的同一个 Linux profile。本机 Desktop controller 必须使用相同的 `instanceKey`、预期实例身份、Web 端口和固定 SSH helper 路径。真实 Linux 安装与服务重启由操作者执行。

### 获得的能力

patch 插入 `remote-workspace-companion`，`instanceKey` 默认为 `default`。经认证的 `/api/remote-workspace/identity` 路由让控制器在 Cookie 交换后再次核对身份。helper wrapper 需要同一服务用户的 `DSH_HOME` 和 `DSH_REMOTE_INSTANCE_KEYS`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

`private-files.ts` 保存稳定实例 ID，并在 `0700` 子目录中原子写入对应启动代次的描述文件。`dsh-remote-info.mjs` 拒绝不安全路径和 allowlist 外的键，将输出限制在 64 KiB，stderr 只输出错误码。卸载时仅删除 boot ID 仍匹配的描述文件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [远程包组](../README.zh.md) — Linux Companion 源码。
- [实施状态](../../../docs/implementation-status.zh.md) — 当前验证范围。

-----

<a id="model-experience"></a>
## 模型体验

无。Companion 只提供浏览器认证身份，不贡献面向模型的内容。

#### KV Cache 影响

无；Companion 不改变远端提示词、请求或 Session 历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

发现功能有以下限制：

- 要求 Linux 和绑定 `127.0.0.1` 的 Web listener。
- 服务用户必须拥有 DSH_HOME 及其私有描述文件子目录；不安全权限或符号链接会被拒绝。
- SSH helper wrapper 和实例键 allowlist 需要单独安装；此包不配置 SSH 或 frp。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
