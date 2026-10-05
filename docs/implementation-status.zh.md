# 验证状态

本项目来自 DSH-WIN-SSH 的固定提交，记录见 source-baseline.json。该文件同时声明 Harness 构建提交。协议版本为 1，插件版本为 0.1.0。

当前拆分验证的实际结果见 [verification.json](verification.json)。构建、自动测试、模拟链路和实机验收分别记录。

2026-10-05 已修复 Git 仓库直接安装时的 `not-bundle` 错误。Windows 真实 pnpm Git 安装及 Harness 组合包读取通过；WSL Ubuntu 使用发行版 Harness CLI 完成真实 Git 安装与 profile 组合包选择，并通过 Harness 运行时解析器加载 Companion。临时服务夹具中的描述文件、原生权限、身份查询和释放清理检查通过。根目录运行文件与原有 Companion 安装包逐字节一致，Companion 业务实现未修改。

验证命令、初始失败及通过记录位于 `docs/evidence/git-install-*.txt`。截图中的 Ubuntu Desktop 重新安装尚未进行。

随后修复启动时的 `remote-companion: unsafe private directory`。Linux 回归复现了运行账号拥有的 `0775` DSH_HOME 和权限过宽的已有私有子目录。Companion 现在验证目录类型、所有者和文件描述符对应的 inode，再仅移除多余权限；符号链接、其他账号目录及全局可写目录仍被拒绝。本次修改了 Companion 源码，并重新构建独立安装包和 Git 运行文件。

原生权限测试、实际 Git 安装后的运行入口启用、身份路由、受限 helper 查询和描述文件清理均通过，记录见 `docs/evidence/permissions-*.txt`。测试环境为隔离的 WSL Ubuntu；运行服务使用夹具。用户提供的截图机器终端输出确认 `.dsh` 为 `0775`、所有者为 `lqy`，且私有子目录尚不存在，与复现条件一致。该机器的 SSH 连接被拒绝，Desktop 重试仍为 notRun。

双机 Desktop/Linux 业务链路、真实 frp 恢复和实机资源清理状态为 notRun。
