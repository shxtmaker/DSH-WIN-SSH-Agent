# Harness 0.2.1-rc.2 兼容升级

> 本文记录升级提交 `598f41d` 的本地验证。推送前的最终检查及安装包哈希见 [main 交付检查](main-publication-preflight.json)。Agent 合并 main 后的 Linux 运行时未复验，不能沿用合并前的 PASS。

日期：2026-10-21。插件候选版本：`0.2.0-alpha.2`。

## 基线

本次升级基于 `preview/plan-b-0.2.0-alpha.1` 的 `0c76e7beb6a2a102fbd754804ffa3f47cadff6f5`。本地分支为 `codex/harness-0.2.1-rc.2`。

Harness 从 `dsh-v0.2.1-alpha.2`（`d743267388641bc76f17c45ce8b4c231aed1d32c`）升级到 [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)（`687f282e8625c6b8d11ff58211a90524be2e4317`）。构建使用 Node.js `24.19.0` 和 pnpm `11.28.5`。

两端的发现协议与管理协议继续使用版本 `1`。`docs/control-contract.json` 未改变，两端 SHA-256 均为 `2849b077a752cda02ef324feaeb968a9dd6b01a6ccbaf07bcedd7a8ec74f486d`。

## 上游变更与适配

- 新版 `WebServer.port` 在监听前可能为 `undefined`。Companion 只在端口有效后发布描述文件，并直接读取新版公开的 `protocol` 属性。
- 未绑定端口、零端口、HTTPS 和 IPv6 监听均被明确拒绝，不会生成错误的启动 URL 或发布描述文件。
- 更新 Harness peer 依赖、稳定版 Cordis/Schemastery 范围、helper 版本、独立安装包及 Git 运行文件。受限服务控制、操作回执、私有文件权限和实例身份存储格式保持不变。
- 测试入口按平台运行 POSIX 服务检查；Windows 不运行需要 Linux 的模拟 systemctl 测试。

## 验证

| 检查 | 结果 |
| --- | --- |
| 全新固定提交目录构建、类型编译和打包 | PASS |
| Windows 可移植回归 | PASS：19 项，6 项平台条件跳过 |
| Linux 完整项目、协议、helper、权限和服务回归 | PASS：51 项，2 项条件跳过 |
| Linux 发行版 CLI 隔离 Git 安装 | PASS |
| Windows 发行版 CLI 独立包安装与入口解析 | PASS；未在 Windows 启动 Linux Companion |
| Linux 独立 `.tgz` 包安装复验 | NOT_RUN：WSL 后续调用无响应，该次测试已停止 |
| 安装后运行文件、权限、身份、描述文件和销毁 | PASS |
| 未绑定端口、零端口、HTTPS、IPv6 拒绝 | PASS |
| 安装包 SHA-256、helper 完整性和 Git 运行文件一致性 | PASS |

Linux 使用 WSL Ubuntu。服务测试使用模拟 systemctl，不操作真实用户服务。Git 安装测试使用临时 profile、实际安装的 Companion/helper 和固定 Web/Connection 测试服务。跳过项为非 Linux 平台拒绝检查，以及需要 root 的异属主权限检查。

## 构建与证据

Windows 准备目录显式禁用自动 CRLF 转换，使固定上游补丁可重复应用。Git 运行文件校验使用 Buffer 等值比较，篡改时只报告文件路径，避免构造大段二进制差异。

命令、结果范围、安装包哈希见 [机器可读记录](harness-0.2.1-rc.2.json)。原始验证输出位于 [证据目录](evidence/harness-0.2.1-rc.2)。当前安装文件及校验清单位于 `dist/remote/`，安装步骤见 [INSTALL.md](INSTALL.md)。

## 交付范围

本次完成本地源码、构建、安装包与隔离兼容验证。远程分支推送、正式 Release、生产安装、真实 SSH/LAN/WAN/frp、已安装 Desktop 操作及真实模型调用均为 `NOT_RUN`。历史实机记录不能替代本候选版本的验证。
