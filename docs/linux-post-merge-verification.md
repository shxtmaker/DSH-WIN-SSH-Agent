# 合并后的 Linux 运行时与安装包复验

日期：2026-10-21。结论：**PASS**。

本次验证直接针对 GitHub `main` 已发布的合并提交 `98339b06c2bbcb2f86469a18a706b003fbadda17`。验证完成后的文档提交不修改源码、运行文件或安装包。此前因 WSL 无响应而记录的 `NOT_RUN` 保留为历史状态，本次结果作为独立补充证据。

## 验证环境与范围

运行环境为 Windows 11 上的 WSL Ubuntu，Node.js 为 `24.19.0`，测试账号 UID 为 `1000`。隔离安装使用已安装的 Harness CLI `0.2.1-rc.2`；该 CLI 在本次插件安装中调用的 pnpm 版本为 `12.4.2`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Linux 项目回归 | 57 项通过，0 项失败，2 项条件跳过 | [测试输出](evidence/linux-post-merge/tests.txt) |
| GitHub 固定提交安装 | PASS | [Git 安装输出](evidence/linux-post-merge/github-install.txt) |
| GitHub 下载的独立安装包 | PASS | [安装包验证与安装输出](evidence/linux-post-merge/archive-install.txt) |
| 安装后的 Linux 运行时 | 两种安装方式均通过 | 同上两份安装输出 |

两个跳过项分别为“非 Linux 平台拒绝检查”和“需要 root 的异属主目录权限检查”。服务管理回归使用模拟 `systemctl`，不操作真实用户服务。

每次安装使用独立临时目录和 profile。验证加载实际安装的 Companion 与 helper，并使用固定的 Web、Connection 测试服务。检查包括：

- 未绑定端口、零端口、HTTPS 和 IPv6 配置被拒绝，且不产生启动描述文件。
- 已有目录权限按约定收紧，私有目录与描述文件分别保持 `0700` 和 `0600`。
- 身份接口与 helper 返回一致的实例和启动身份，不返回私有启动凭据。
- 删除描述文件后，运行中的修复循环重新发布同一启动代次的描述文件，helper 查询恢复。
- 销毁组件后，对应启动描述文件被删除。

安装包为 `harness-remote-companion-0.2.0-alpha.2.tgz`，共 `21803` 字节，SHA-256 为：

```text
829ad45fc69e8d56935d28d5dbc4caa110c9cb030d413e1e75a54f339373a7c3
```

该文件从 GitHub 固定提交下载，与已发布校验清单及本地文件一致；Linux 端再次检查了哈希、包元数据和必需文件，然后实际安装并执行上述运行时验证。

## WSL 无响应的排查与恢复

恢复前，`wsl --version` 可以立即返回，但 `wsl --list --verbose` 和执行 `/bin/echo WSL_READY` 均超过 8 秒未响应，`wsl --shutdown` 超过 12 秒未响应。发行版注册仍指向 `G:\WSL`，磁盘空间充足。

正常停止 `WslService` 超时。结束其旧进程并重新启动后，服务仍停在 `StartPending`，说明单独重启 WSL 服务未解决阻塞。

随后发现，WMI 类定义查询和网络适配器查询正常，而 `Win32_OperatingSystem`、`Win32_Processor`、`Win32_Process` 的实例查询超时。通过进程已加载模块确认，PID `5620` 承载 `CIMWin32` provider。仅回收该 provider 宿主进程后，WMI 查询恢复，等待中的 `WslService` 随即转为 `Running`。发行版列表在 `0.063` 秒内返回，Ubuntu 冷启动并输出 `WSL_READY` 用时 `3.359` 秒。

据此，本次直接阻塞点定位为 Windows 的 `CIMWin32` provider 宿主异常。没有采集线程转储，无法进一步确定该宿主内部最初卡住的调用或触发原因。恢复没有重建 WMI 数据库、注销发行版、修改虚拟磁盘、修改网络模式或重启 Windows。

微软文档说明了 [WMI provider 的宿主关系及阻塞影响](https://learn.microsoft.com/en-us/windows/win32/wmisdk/debugging-providers)，以及[通过 provider 模块定位宿主进程的方法](https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/troubleshoot-wmi-high-cpu-issues)。本次故障判断以本机对照探测和恢复结果为依据。

## 证据边界

本次结果覆盖合并后的 Linux 隔离运行时、真实文件权限、Git 安装和独立安装包安装。生产部署、真实 SSH/LAN/WAN/frp、已安装 Desktop 操作及真实模型调用仍为 `NOT_RUN`。

机器可读记录、精确测试命令、运行文件哈希和证据文件哈希见 [linux-post-merge-verification.json](linux-post-merge-verification.json)。
