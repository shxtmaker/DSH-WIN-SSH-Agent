# 被控端安装与使用

被控端运行于 Linux 的 DeepSeek Harness Web profile，提供实例身份、私有启动描述文件和受限 SSH 查询 helper。Harness 管理工作区文件、模型调用、命令执行和会话数据。

## 环境要求

安装包版本为 0.2.0-alpha.2，适用于 DeepSeek Harness 0.2.1-rc.2。需要 Linux、Node.js，以及监听 127.0.0.1 的 Harness Web profile。运行 Harness、Companion 和 helper 的 Linux 用户必须一致。

## 安装 Companion

当前适配候选以本目录中的 `.tgz` 文件交付。不要使用远程默认分支或旧预览分支代替这些文件。

已有 Git 安装与独立安装包安装应选择一种方式，避免在同一 profile 重复启用组件。切换安装方式前保留现有 profile、目标配置和实例身份，并完全退出相应 Harness 进程。安装完成后重新启动。

### 从独立安装包安装

使用现有 Web profile，以下示例使用 remote-web。在已运行的业务 profile 上安装前，安排可控的退出和重启时段。

```bash
node scripts/verify-artifacts.mjs
dsh --version
dsh plugin --profile remote-web add file:./dist/remote/harness-remote-companion-0.2.0-alpha.2.tgz
dsh plugin --profile remote-web list
```

需要新建 Web profile 时，可在选定的 DSH_HOME 和工作区运行下列命令。命令会启动服务：

```bash
dsh --profile remote-web --from-default-profile web --no-open --port 3080
```

### 启用与配置

安装后在插件管理器中找到 `remote-workspace-companion`，确认 `instanceKey`。默认值为 `default`。需要覆盖配置时，在 profile 的 `cordis.patch.yml` 中追加：

```yaml
- id: remote-workspace-companion
  config:
    instanceKey: default
```

按安装提示重启该 profile，使 Companion 生成描述文件。Web 必须绑定 `127.0.0.1`。

## 配置受限 helper

复制 [remote-helper.sh.example](configs/remote-helper.sh.example)，将 DSH_HOME、实例键白名单和 Companion helper 路径改为该服务的实际值。将 wrapper 安装到控制端约定的固定路径，例如 /usr/local/bin/dsh-remote-info，并赋予执行权限。Linux 服务用户必须能够读取和执行此文件；其他用户不得修改它。

Git 安装到 `web` profile 时，helper 路径为 `~/.dsh/profiles/web/node_modules/dsh-win-ssh-agent-source/runtime/bin/dsh-remote-info.mjs`。独立安装包安装到 `remote-web` 时，helper 路径为 `~/.dsh/profiles/remote-web/node_modules/@harness-remote/companion/bin/dsh-remote-info.mjs`。wrapper 中使用实际用户的绝对路径；运行账号的 `PATH` 中必须能够找到 Node.js。

DSH_REMOTE_INSTANCE_KEYS 是逗号分隔的允许实例键。私有描述目录的权限须为 0700，描述文件须为 0600。helper 会拒绝不安全权限、符号链接和白名单之外的实例键。

## 启动时的目录权限

Companion 启动时检查 `DSH_HOME`、`DSH_HOME/remote-workspace` 和 `DSH_HOME/remote-workspace/run`。对于运行账号拥有的普通目录，自动移除 `DSH_HOME` 的组写权限，并移除两个私有子目录的组权限和其他用户权限。例如，已有的 `.dsh` 为 `0775` 时会收紧为 `0755`，私有子目录的 `0755/0775` 会收紧为 `0700`。此操作不递归修改目录内的文件，也不扩大权限。

如果仍出现 `remote-companion: unsafe private directory: <path>`，请检查错误指向的目录是否为符号链接、是否属于运行 Harness 的账号，以及是否允许其他用户写入。此类目录不会自动修改。使用同一账号检查：

```bash
id
stat -c '%a %U %G %n' "$HOME/.dsh" "$HOME/.dsh/remote-workspace" "$HOME/.dsh/remote-workspace/run"
```

如果配置了自定义 `DSH_HOME`，请使用该路径。确认所有者和路径正确后，再修正相应目录；不要使用 `chmod -R`，不要把描述文件权限放宽到 `0644`。

以运行 Harness 的同一用户读取不含启动凭据的身份：

```bash
printf '%s\n' '{"protocolVersion":1,"instanceKey":"default"}' | /usr/local/bin/dsh-remote-info --identity
```

将 instanceKey、instanceId、profile、workspaceHint、port 提供给 [控制端](http://192.168.3.100:3300/lqy/DSH-WIN-SSH-Controller) 配置目标。完整描述中的 launchUrl 含临时凭据，只供控制端经 SSH 使用，不应复制到聊天、日志或目标配置中。

## SSH 与 frp

操作者配置 OpenSSH 登录和主机密钥。LAN、frp TCP 和 STCP visitor 均通过 SSH 访问本机 helper 与 loopback Web。frp 仅转发 SSH。Companion 不安装或管理 sshd、frpc、frps、visitor 或 Harness 服务。

## 卸载

先让控制端断开，在可控的重启时段执行与安装方式对应的命令。

Git 安装：

```bash
dsh plugin --profile web remove dsh-win-ssh-agent-source
```

独立安装包安装：

```bash
dsh plugin --profile remote-web remove @harness-remote/companion
```

卸载不会删除工作区或会话，也不会修改 SSH、frp 配置。固定路径 wrapper 的停用由操作者管理。恢复原 profile 插件清单可回滚安装。

## 核验 wrapper 与 profile home（B12）

远端 wrapper 的 `DSH_HOME` 必须与 Companion 实际用于实例存储的目录一致。安装时读**实际配置**确认，不要按作者机器路径或 profile 名称猜测：

1. 读取运行中的 unit 或 wrapper，确认其 `Environment=DSH_HOME=<绝对路径>`。
2. 在同一台机器上确认该目录下存在 `remote-workspace/run/<instanceKey>.json`，且文件属主为运行服务的同一 UID、权限为 0600。
3. 确认 `DSH_REMOTE_INSTANCE_KEYS` 含且仅含需要暴露的实例键。
4. 确认 helper 路径与 Controller 配置中的 `helperPath` 完全一致，且为绝对路径。
5. 服务登记位于 `<DSH_HOME>/remote-workspace/control/services.json`，目录 0700、文件 0600、同 UID；其 `instances[<key>].unit` 必须与真实存在的用户 unit 名称逐字一致。

四项中任一项不符时，管理页显示对应的固定错误码（`HELPER_BAD_CONFIG`、`CONFIG_REQUIRED`、`UNSAFE_FILE`、`SERVICE_UNREGISTERED`），不会猜测或自动修正远端配置。

## 安装后自检

- 发现协议：无参数调用 helper 返回完整启动描述；`--identity` 只返回公开身份；两者输出字段与 `docs/PROTOCOL.md` 一致。
- 管理协议：`--control` 接受一行 JSON，`capabilities` 与 `status` 在 Web 停止时仍可返回。
- 旧 helper 兼容：对 `--control` 返回结构化 `BAD_INPUT` 时，管理页降级为只连接模式并给出手动启动说明。
