# 控制端与被控端通信

协议版本为 1。控制端通过系统 OpenSSH 执行固定路径 helper，再经 SSH loopback 转发访问被控端 Harness Web。两侧没有跨项目源码或安装依赖。

## SSH 发现

helper 从标准输入接收一行 JSON：

```json
{"protocolVersion":1,"instanceKey":"default"}
```

实例键必须出现在 DSH_REMOTE_INSTANCE_KEYS 白名单中。正常模式返回以下字段；--identity 模式省略 launchUrl。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| protocolVersion | 1 | 协议版本 |
| instanceKey | string | 白名单实例键 |
| instanceId | string | 私有目录中持久化的实例 ID |
| bootId | string | 当前启动代次 ID |
| profile | string | 被控端 profile 名称 |
| workspaceHint | string | 被控端工作区路径 |
| port | integer | 1 至 65535 的 loopback Web 端口 |
| launchUrl | string | 带临时启动 token 的 loopback URL |

输入上限为 4096 字节，描述文件和输出上限为 65536 字节。错误码写入 stderr，进程返回非零状态。完整描述只在控制端 Host 的当前连接内使用，不进入持久化目标或 UI。

## Web 身份与就绪

控制端将 launchUrl 的临时 token 换取 Host 内存中的 Cookie，再访问 GET /api/remote-workspace/identity。响应包含 protocolVersion、instanceKey、instanceId、bootId、profile、workspaceHint、version 和 capabilities。当前 Companion 声明 web 与 remote.mux 能力。

控制端核对预期实例身份及该次 SSH 发现的 bootId，再检查 /api/remote.mux WebSocket 就绪。只有所有检查成功后才进入 app-ready。本地代理绑定 loopback，以一次性票据换取本地 Cookie；被控端 Cookie 不传给浏览器。

## 断开与恢复

控制端仅管理自身的 SSH 子进程、本地转发和认证代理。SSH 中断时暂停代理，重新发现和认证后核对身份。实例身份不符时拒绝恢复。控制端不自动重放产生副作用的业务请求，远端页面负责重新查询任务状态。

## 管理协议（controlVersion 1）

发现协议保持 `protocolVersion: 1` 不变。服务管理使用**同一固定绝对 helper 路径**加固定参数 `--control`，协议名为 `controlVersion`，与发现协议及官方 SSH helper 的私有协议版本互不混用。两端各自保存字节相同的 `docs/control-contract.json`；任何一侧都不导入另一侧的源码。

### 请求

stdin 仍只接受一行 JSON，上限 4096 字节。

```json
{"controlVersion":1,"action":"status","instanceKey":"default"}
```

| 动作 | 附加字段 | 说明 |
| --- | --- | --- |
| `capabilities` | 无 | helper 版本、支持的发现版本、支持动作、当前实例管理模式 |
| `status` | 无 | 登记状态、服务状态、描述状态、监听与 loopback 探测 |
| `operationStatus` | `operationId` | 只查询已有回执，不提交新动作 |
| `start` / `stop` / `restart` | `operationId`、`issuedAt`、`registrationRevision`、可选 `expectedInstanceId` | 唯一允许的写动作 |

不接受命令文本、任意 unit 名、任意路径、Shell 参数、环境变量覆盖或提权。`unit` 只来自被控端已审核的私有登记，不来自网络请求。

### 响应

stdout 为一行 JSON，上限 65536 字节。成功响应带 `ok: true` 与动作专属字段；失败响应带 `ok: false` 与 `error: { code, message }`，`message` 已脱敏且有界。stderr 只允许稳定错误码与脱敏摘要。

固定错误码见 `docs/control-contract.json` 的 `errorCodes`。控制端按 `error.stage` 与 `error.retryable` 决定默认动作，不解析本地化文案。

### 降级与身份

旧 helper 对 `--control` 返回结构化 `BAD_INPUT` 并非零退出，这是**唯一**选择"仅连接"降级的信号；其他非零退出保留各自的 SSH、权限或配置错误，不会被误判为旧版本。

写动作携带 `registrationRevision` 与已知 `expectedInstanceId`。登记变更会生成新 revision；helper 拒绝过期映射或身份冲突，不自动覆盖已有实例身份。

### 时间预算与结果未知

| 项目 | 上限 |
| --- | --- |
| SSH/helper 只读调用 | 10 秒 |
| TCP 健康探测 | 2 秒 |
| 认证 / 事件就绪 | 各 10 秒 |
| 服务命令 | 45 秒 |
| 服务启动后就绪等待 | 最多 60 秒，每 2 秒查询一次 |
| SSH 重连 | 最长 5 分钟，带退避与取消 |

写请求的 `issuedAt` 只接受 24 小时内；回执保留 7 天，数量上限 256，只清理已终结且过期的记录。

超时、SSH 中断或 helper 异常退出可能让 systemd 已经接受操作而客户端没有拿到结果。此时状态为 `outcome-unknown`：只能查询 `operationStatus` 与真实服务状态，**不得**用新的 `operationId` 重新发送 start/stop/restart，也不得把"当前服务 active"当成"本次 restart 已成功"。
