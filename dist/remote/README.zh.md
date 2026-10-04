# 被控端安装与使用

被控端运行于 Linux 的 DeepSeek Harness Web profile，提供实例身份、私有启动描述文件和受限 SSH 查询 helper。Harness 管理工作区文件、模型调用、命令执行和会话数据。

## 环境要求

安装包版本为 0.1.0，适用于 DeepSeek Harness 0.2.0-rc.2。需要 Linux、Node.js，以及监听 127.0.0.1 的 Harness Web profile。运行 Harness、Companion 和 helper 的 Linux 用户必须一致。

## 安装 Companion

使用现有 Web profile，以下示例使用 remote-web。在已运行的业务 profile 上安装前，安排可控的退出和重启时段。

```bash
node scripts/verify-artifacts.mjs
dsh --version
dsh plugin --profile remote-web add file:./dist/remote/harness-remote-companion-0.1.0.tgz
dsh plugin --profile remote-web list
```

需要新建 Web profile 时，可在选定的 DSH_HOME 和工作区运行下列命令。命令会启动服务：

```bash
dsh --profile remote-web --from-default-profile web --no-open --port 3080
```

安装后检查该 profile 的 cordis.patch.yml，确认 remote-workspace-companion 的 instanceKey。默认值为 default。重启该 profile，使 Companion 生成描述文件。Web 必须绑定 127.0.0.1。

## 配置受限 helper

复制 [remote-helper.sh.example](configs/remote-helper.sh.example)，将 DSH_HOME、实例键白名单和 Companion helper 路径改为该服务的实际值。将 wrapper 安装到控制端约定的固定路径，例如 /usr/local/bin/dsh-remote-info，并赋予执行权限。Linux 服务用户必须能够读取和执行此文件；其他用户不得修改它。

DSH_REMOTE_INSTANCE_KEYS 是逗号分隔的允许实例键。私有描述目录的权限须为 0700，描述文件须为 0600。helper 会拒绝不安全权限、符号链接和白名单之外的实例键。

以运行 Harness 的同一用户读取不含启动凭据的身份：

```bash
printf '%s\n' '{"protocolVersion":1,"instanceKey":"default"}' | /usr/local/bin/dsh-remote-info --identity
```

将 instanceKey、instanceId、profile、workspaceHint、port 提供给 [控制端](http://192.168.3.100:3300/lqy/DSH-WIN-SSH-Controller) 配置目标。完整描述中的 launchUrl 含临时凭据，只供控制端经 SSH 使用，不应复制到聊天、日志或目标配置中。

## SSH 与 frp

操作者配置 OpenSSH 登录和主机密钥。LAN、frp TCP 和 STCP visitor 均通过 SSH 访问本机 helper 与 loopback Web。frp 仅转发 SSH。Companion 不安装或管理 sshd、frpc、frps、visitor 或 Harness 服务。

## 卸载

先让控制端断开，在可控的重启时段执行：

```bash
dsh plugin --profile remote-web remove @harness-remote/companion
```

卸载不会删除工作区或会话，也不会修改 SSH、frp 配置。固定路径 wrapper 的停用由操作者管理。恢复原 profile 插件清单可回滚安装。
