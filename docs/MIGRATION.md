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

各项目独立克隆和构建。升级协议时同时检查双方的身份字段、认证流程和能力兼容性，按各端分别发布安装包。原 [DSH-WIN-SSH](http://192.168.3.100:3300/lqy/DSH-WIN-SSH) 保留原始源码和分包结果，可用于对照和回滚。
