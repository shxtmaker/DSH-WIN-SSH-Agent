# DSH-WIN-SSH-Agent

DeepSeek Harness SSH 远程工作区被控端。

在 Linux Harness Web profile 中发布实例身份和私有启动描述文件，通过受限 SSH helper 向控制端提供连接信息。远端 Harness 执行工作区操作并保存会话。

## 安装文件

- [harness-remote-companion-0.1.0.tgz](dist/remote/harness-remote-companion-0.1.0.tgz)

安装包版本为 0.1.0，适用于 Harness 0.2.0-rc.2。校验值见 [SHA256SUMS.txt](dist/remote/SHA256SUMS.txt)。在仓库根目录执行 node scripts/verify-artifacts.mjs 即可验证。

## 使用

按 [安装与使用说明](docs/INSTALL.md) 配置本端，再与 [DSH-WIN-SSH-Controller](http://192.168.3.100:3300/lqy/DSH-WIN-SSH-Controller) 配合使用。两侧通过协议版本 1 通信。

## 源码与构建

源码位于 packages/remote/。本项目可以单独克隆、构建和打包。构建从固定的 Harness 提交准备依赖环境，无需克隆另一端项目。命令见 [构建说明](docs/BUILD.md)。

本项目包含 companion 安装包及固定路径 helper 配置示例。 迁移说明见 [原项目迁移](docs/MIGRATION.md)，两侧通信字段见 [协议说明](docs/PROTOCOL.md)，验证记录见 [验证状态](docs/implementation-status.zh.md)。

## 许可证

采用 [MIT License](LICENSE)，保留 DeepSeek Harness 的许可证及版权声明。
