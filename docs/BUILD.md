# 从源码构建

需要 Git、Node.js 24 和 Corepack。固定上游使用 pnpm 11.7.0，提交由 source-baseline.json 声明。构建脚本只使用当前项目源码和固定上游，不读取另一端项目。

## 准备与构建

在当前项目根目录按顺序执行。PowerShell 和 Bash 使用相同的命令：

```text
node scripts/verify-project.mjs
node --test tests/project.test.mjs
node scripts/prepare-upstream.mjs
node scripts/build.mjs
node scripts/test-integration.mjs
node scripts/verify-artifacts.mjs out/remote
node scripts/test-git-install.mjs --harness /absolute/path/to/built-harness
```

每条命令成功后再继续。准备脚本只接受 .build/ 下尚不存在的目标目录。已有目录会被保留。新准备目录使用 node scripts/prepare-upstream.mjs .build/upstream-2；后续构建和集成检查使用 --workspace .build/upstream-2。

已有本地 Harness Git 对象库时，可使用 node scripts/prepare-upstream.mjs --source /absolute/path/to/harness-clone。该选项仍核对固定提交，不复制来源工作区的未提交修改。

构建安装固定锁文件依赖，并生成本端的安装包。被控端编译 Companion 及其 Harness 类型依赖，再仅打包 Companion 运行入口和受限 helper。 网络不可用且 pnpm 缓存完整时，可以使用 node scripts/build.mjs --offline。

## 输出与重复打包

新产物位于 out/remote/，含安装包、SHA256SUMS.txt、配置示例和中文安装说明。仓库中的 dist/remote/ 为已校验的安装文件；构建不会覆盖它。

打包成功后，构建脚本从校验过的 Companion 安装包同步根目录的 `runtime/`、`cordis.patch.yml` 和运行依赖，使 Git 仓库可以直接安装。该步骤不执行安装生命周期脚本。发布源码变化时，将审查后的新安装包及其校验清单同步至 `dist/remote/`，再运行 `verify:project`，确保 Git 运行文件与独立安装包一致。也可运行 `node scripts/sync-git-package.mjs`，从现有 `dist/remote/` 重建 Git 入口。

源码修改后，需要重新准备新的构建目录。构建目录内的源码是准备时复制的快照。对同一快照可直接重复运行 build；已有完整构建输出时，可用 node scripts/build.mjs --pack-only 仅重新打包。

## 检查

test 检查本端源码、构建补丁和安装包隔离，并验证破损包、额外包和错误校验清单被拒绝。test:integration 运行 helper 平台检查；Linux 环境还运行真实临时目录、权限和身份输出测试。Windows 会明确跳过 Linux 用例。

Linux 权限回归可独立运行 `node --test tests/private-files.test.mjs tests/helper.test.mjs`，需要 Node.js 24，临时目录位于原生 Linux 文件系统。测试覆盖已有 `0775` DSH_HOME、权限过宽的私有子目录、稳定身份、私有描述文件及拒绝符号链接和全局可写目录。其他用户所有权的拒绝用例仅在 root 测试进程下执行，普通账号明确跳过；root 用例只修改并清理自己创建的临时夹具。

`test-git-install.mjs` 需要指定已构建的 Harness 目录，其中包含插件管理器的 `lib/types/operations.js`。它在临时 profile 中执行真实 pnpm Git 安装，并使用 Harness 插件管理器的组合包读取函数验证识别、补丁、模块导出和 helper 路径。默认使用当前源码创建独立 Git 快照；`--spec` 可指定远程 Git 地址和提交，用于推送后的复验。临时测试目录会在结束时清理。

也可通过 `--installation /path/to/isolated-cli-installation` 指定由 pnpm 安装了 `@deepseek-ai/dsh@0.2.0-rc.2` 的独立目录。此模式调用真实 `dsh plugin add` 并验证 profile 选中该组合包。在 Linux 上还会通过 Harness 的运行时解析器加载 Companion，以临时服务夹具验证原生描述文件权限、身份查询和卸载清理；这些检查不代表实机 SSH 或 frp 验收。

本地构建和模拟代理测试不能代替 Desktop 与 Linux 双机业务验收。完整上游文档站点校验不属于本项目的最小构建入口。
