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
