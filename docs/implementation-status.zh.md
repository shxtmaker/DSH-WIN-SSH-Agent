# 验证状态

本项目来自 DSH-WIN-SSH 的固定提交，记录见 source-baseline.json。该文件同时声明 Harness 构建提交。协议版本为 1，插件版本为 0.1.0。

当前拆分验证的实际结果见 [verification.json](verification.json)。构建、自动测试、模拟链路和实机验收分别记录。

2026-10-05 已修复 Git 仓库直接安装时的 `not-bundle` 错误。Windows 真实 pnpm Git 安装及 Harness 组合包读取通过；WSL Ubuntu 使用发行版 Harness CLI 完成真实 Git 安装与 profile 组合包选择，并通过 Harness 运行时解析器加载 Companion。临时服务夹具中的描述文件、原生权限、身份查询和释放清理检查通过。根目录运行文件与原有 Companion 安装包逐字节一致，Companion 业务实现未修改。

验证命令、初始失败及通过记录位于 `docs/evidence/git-install-*.txt`。截图中的 Ubuntu Desktop 重新安装尚未进行。

双机 Desktop/Linux 业务链路、真实 frp 恢复和实机资源清理状态为 notRun。
