# 从 DSH-WIN-SSH 迁移

## 对应关系

| 原项目内容 | 当前项目 |
| --- | --- |
| controller、client、bundle；本机 SSH 配置 | DSH-WIN-SSH-Controller |
| companion；Linux 受限 helper 配置 | DSH-WIN-SSH-Agent |

两个项目保留原插件名称、0.1.0 版本、协议版本 1、profile patch ID、固定 helper 默认路径和目标记录格式。此次拆分不要求修改已有目标记录、实例身份、SSH alias 或 frp 入口。

## 已安装环境

使用同版本包的环境无需为项目拆分重复安装。需要重新安装时，控制端在 Desktop profile 的同一条命令中提供三个控制端 tarball；被控端只在对应 Web profile 安装 Companion。分别参照各端安装说明。

DSH_HOME/remote-workspace/targets.json 由控制端管理，Linux DSH_HOME 下的实例 ID 和私有描述文件由 Companion 管理。迁移时保留这些数据。两个 DSH_HOME 属于各自主机，不应互相覆盖。

## 源码维护

各项目独立克隆和构建。升级协议时同时检查双方的身份字段、认证流程和能力兼容性，按各端分别发布安装包。原 DSH-WIN-SSH 仓库保留原始源码和分包结果，可用于对照和回滚。

## 0.1.0 / rc.2 → 0.2.0-alpha.1 / alpha.2 升级与回退

固定基线由 `dsh-v0.2.0-rc.2`（`639ed015…`）变为 `dsh-v0.2.1-alpha.2`（`d7432673…`），插件版本由 `0.1.0` 变为 `0.2.0-alpha.1`。两端仍是独立仓库、独立构建、独立安装包，不互相导入源码。

### 兼容矩阵

| 组合 | 处理 |
| --- | --- |
| 新 Controller + 新 Agent，两侧均为 alpha.2 | 首版目标组合 |
| 新 Controller + 旧 Agent（远端仍为 rc.2 宿主） | 设计为发现协议 1 的**只连接降级**：旧 helper 对 `--control` 返回结构化 `BAD_INPUT`，管理页显示手动启动说明，不显示服务按钮 |
| 旧 Controller + 新 Agent | 不预先保证；只作为可选观察 |
| 新插件加载在 rc.2 宿主 | 不承诺；peerDependencies 指向 alpha.2 |
| 旧插件加载在 alpha.2 宿主 | 不作为回退方案 |

判断"旧 Agent"的**唯一**依据是 `--control` 返回结构化 `BAD_INPUT`。SSH 不可达、权限错误、配置损坏保留各自错误，不会被误判为旧版本。

### 数据保留

- `targets.json` 格式不变，不加入 capabilities、健康状态、Cookie 或服务字段；旧版可直接读取。
- 远端实例 ID 与运行描述不重新生成；重启只更新 `bootId`。
- 能力与健康信息只保留在 Host 内存，不落盘。
- 远端服务登记（`control/services.json`）与操作回执（`control/operations/`）独立存放，旧软件可忽略，不需要删除旧会话目录。
- 首版不新增 `ui-preferences.json`：只有"记住打开偏好"才需要它，本次未实现该偏好，因此不引入多余格式。

### 升级顺序（仅说明，未执行）

1. 记录两端已安装版本、来源与 hash，确认实际 profile、DSH_HOME、helper 路径、unit 与工作目录。
2. 备份配置、SSH helper wrapper、unit、`targets.json`、实例 ID 与会话数据。活动数据库使用应用支持的一致性备份或停止后复制，不能漏掉 WAL；不要把凭据放进公开产物。
3. 在数据副本上验证 alpha.2，不让新旧 Harness 同时写同一个 profile/数据库。
4. 先升级 Linux Harness 与 Agent，核对服务就绪、HTTP loopback、目录 browse 组合、描述与能力输出。
5. 再升级 Windows Harness Desktop 与 Controller，完整退出托盘/Host 后重启。
6. 重新连接并签发一次新票据。旧页面可能仍持有过期 Cookie、旧端口或旧连接，不要求它无感继承授权。

### 回退顺序（仅说明，未执行）

1. 先停止新版写入，保留升级后数据的独立副本与诊断记录。
2. 恢复旧宿主与旧插件组合、原 wrapper/unit。
3. 旧版能否读取 alpha.2 写过的数据必须通过隔离试验确认；未确认时不要直接对新格式数据降级运行。
4. 升级后新增的会话不会自动合并，保留该部分副本，不得覆盖后丢失新数据。
5. **恢复旧 `0.1.0` Controller 会重新带回一小时 Cookie 缺陷**。旧版本把本地授权绑定到 `Max-Age=3600`，页面长期打开后新建会话与用量查询会返回本地 401。回退到旧版不等于该缺陷已解决。

### 未验证组合

macOS Controller、HTTPS、IPv6、路径前缀与独立内嵌主页面均未执行，记为 `NOT_RUN`，不列为首版支持承诺。真实 Windows→Linux 使用链（T5）在没有明确隔离环境时为 `NOT_RUN`。
