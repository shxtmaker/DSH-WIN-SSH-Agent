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

## 描述文件生命周期

helper 只读取 `$DSH_HOME/remote-workspace/run/<instanceKey>.json`；控制端从不写入被控端文件。该文件由运行中的 Companion 写入，描述目录为 0700，描述文件为 0600。

Companion 在三个时机保持该文件存在：

1. 插件启用时立即尝试发布，不再只等待应用就绪；
2. Harness 应用就绪后再次发布；
3. 运行期间按固定间隔（5 秒）核对：文件缺失、被其他启动代次覆盖、端口变化或内容不完整时重新发布。

因此 profile 热重载、插件管理器的安装或卸载（两者都会释放旧 Companion 并删除其描述文件）、插件管理 CLI 的临时 profile 加载，以及手工删除文件，都不再需要重启 Harness 即可在数秒内恢复。只有更换 Companion 代码本身才需要重启运行该 profile 的进程。释放时 Companion 只删除 bootId 与自身一致的描述文件，不会误删后续启动代次或正在运行的其他实例的文件。

helper 的失败码对应关系：

| 错误码 | 含义 |
| --- | --- |
| INFO_FAILED | 描述文件缺失、不可读或内容不完整（最常见：文件被删除且尚未重新发布） |
| CONFIG_REQUIRED | DSH_HOME 或实例键白名单未配置 |
| LINUX_REQUIRED | 非 Linux 平台 |
| BAD_INPUT | 输入 JSON、--identity 参数或实例键不在白名单 |
| UNSAFE_PATH | DSH_HOME 或私有目录类型、所有者、权限不安全 |
| UNSAFE_FILE | 描述文件类型、所有者、权限不安全 |
| BAD_DESCRIPTOR | 描述文件字段缺失、类型错误或超出上限 |

重新发布失败时，被控端 Harness 日志出现 `remote-companion: descriptor repair failed: <原因>`；同一原因只记录一次，恢复后再次失败会重新记录。

## Web 身份与就绪

控制端将 launchUrl 的临时 token 换取 Host 内存中的 Cookie，再访问 GET /api/remote-workspace/identity。响应包含 protocolVersion、instanceKey、instanceId、bootId、profile、workspaceHint、version 和 capabilities。当前 Companion 声明 web 与 remote.mux 能力。

控制端核对预期实例身份及该次 SSH 发现的 bootId，再检查 /api/remote.mux WebSocket 就绪。只有所有检查成功后才进入 app-ready。本地代理绑定 loopback，以一次性票据换取本地 Cookie；被控端 Cookie 不传给浏览器。

## 断开与恢复

控制端仅管理自身的 SSH 子进程、本地转发和认证代理。SSH 中断时暂停代理，重新发现和认证后核对身份。实例身份不符时拒绝恢复。控制端不自动重放产生副作用的业务请求，远端页面负责重新查询任务状态。
