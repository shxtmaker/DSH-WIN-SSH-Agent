# 验证状态

当前兼容目标为 Harness `0.2.1-rc.2`，插件候选版本为 `0.2.0-alpha.2`，基于 `preview/plan-b-0.2.0-alpha.1`。本次结果见 [兼容升级记录](harness-0.2.1-rc.2.md)。下列记录仅说明各自日期的历史验证，不能作为当前版本的实机验证。

## 历史验证记录

本项目来自 DSH-WIN-SSH 的固定提交，记录见 source-baseline.json。该文件同时声明 Harness 构建提交。协议版本为 1，插件版本为 0.1.0。

当前拆分验证的实际结果见 [verification.json](verification.json)。构建、自动测试、模拟链路和实机验收分别记录。

2026-10-05 已修复 Git 仓库直接安装时的 `not-bundle` 错误。Windows 真实 pnpm Git 安装及 Harness 组合包读取通过；WSL Ubuntu 使用发行版 Harness CLI 完成真实 Git 安装与 profile 组合包选择，并通过 Harness 运行时解析器加载 Companion。临时服务夹具中的描述文件、原生权限、身份查询和释放清理检查通过。根目录运行文件与原有 Companion 安装包逐字节一致，Companion 业务实现未修改。

验证命令、初始失败及通过记录位于 `docs/evidence/git-install-*.txt`。截图中的 Ubuntu Desktop 重新安装尚未进行。

随后修复启动时的 `remote-companion: unsafe private directory`。Linux 回归复现了运行账号拥有的 `0775` DSH_HOME 和权限过宽的已有私有子目录。Companion 现在验证目录类型、所有者和文件描述符对应的 inode，再仅移除多余权限；符号链接、其他账号目录及全局可写目录仍被拒绝。本次修改了 Companion 源码，并重新构建独立安装包和 Git 运行文件。

原生权限测试、实际 Git 安装后的运行入口启用、身份路由、受限 helper 查询和描述文件清理均通过，记录见 `docs/evidence/permissions-*.txt`。测试环境为隔离的 WSL Ubuntu；运行服务使用夹具。用户提供的截图机器终端输出确认 `.dsh` 为 `0775`、所有者为 `lqy`，且私有子目录尚不存在，与复现条件一致。该机器的 SSH 连接被拒绝。

用户随后提供的安装文件 SHA-256 与修复版一致，但截图仍引用旧运行文件行号。完全重启运行 `web` profile 的 Harness 进程后，用户确认 Agent 已成功启用。实机启用状态为用户报告通过；双机 SSH/frp 业务验收仍为 notRun。

双机 Desktop/Linux 业务链路、真实 frp 恢复和实机资源清理状态为 notRun。

2026-10-15 增加描述文件修复循环：实机 Ubuntu 在被控端 Web 进程持续运行的情况下丢失了启动描述文件。此前 Companion 只在启用和应用就绪两个时刻写入该文件，因此 profile 热重载或插件管理器操作删除文件后不会补写，后续每次连接都报 helper 提示，必须重启服务才能恢复。现在 Companion 在启用时发布、应用就绪后再次发布，并按 5 秒间隔修复缺失、被其他启动代次替换、内容不完整或端口变化的描述文件；释放时仍只删除自身 boot ID 的描述文件。Windows 与 Ubuntu 单元测试、删除描述文件后校验重新发布的已安装运行时夹具、重新构建以及实机删除检查均通过：23:25:26.273 删除，helper 返回 `INFO_FAILED`，3358 ms 后以相同 bootId、0600 权限重新发布，helper 查询恢复成功，证据见 `docs/evidence/repair-*.txt`。同时新增 `scripts/install-remote-helper.mjs`：一条命令即可把 wrapper 装到控制端固定路径 `/usr/local/bin/dsh-remote-info` 并实测；无 sudo 时回退到仅供该账号执行的 `~/.local/bin`，并打印控制端 profile 需要覆盖的 helperPath。加载实机 profile 树的插件管理器操作未能复现，因为已安装的 CLI 在 Harness 插件管理器 reconcile 阶段即中止；删除与替换两种场景由夹具测试和实机删除检查覆盖。
