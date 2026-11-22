# Validation Record

日期：2026-11-22

环境：Linux `vm`，Node.js v22.23.4，npm 10.9.9，Git 2.34.1。

这份记录只陈述实际运行过的事情。模拟测试不能替代真实宿主兼容结论。

## 离线验证

### 完整测试

```bash
cd workspace-sentinel
node --test
```

最终结果：`108 tests`，`108 pass`，`0 fail`，`0 cancel`，`0 skip`。

覆盖三端适配器、JSON CLI、路径安全、证据归属与改名识别、产物永久删除、软件隔离恢复、计划摘要审批、云端门禁、验证失败回滚、超时强制终止整个进程组、跨挂载点拒绝、状态路径归属校验、文档示例和清单路径。

### 语法与空白

```bash
node --check index.js
node --check src/cli.js
node --check src/core/child-process.js
git diff --check
```

结果：全部通过，无语法错误或空白错误。

### npm 包内容

```bash
npm pack --dry-run
```

结果：打包成功；`30` 个文件，package `30,216` bytes，unpacked `105,464` bytes。内容包含 `index.js`、`cordis.patch.yml`、`src/`、`skills/`、`hooks/`、`.codex-plugin/`、`.claude-plugin/`、`examples/`、`README.md`、`LICENSE`、`VALIDATION.md`。没有加入测试目录。

## Codex 实机检查

实际执行了本地 marketplace 添加、插件安装与列表检查。所用 CLI：

```text
codex-cli 0.139.0
```

在隔离的临时目录与 `CODEX_HOME` 中：

```bash
# 将本仓库复制到 <stage>/plugins/workspace-sentinel
# 将 examples/codex-marketplace.json 放到 <stage>/.agents/plugins/marketplace.json
CODEX_HOME=<stage>/codex-home codex plugin marketplace add <stage> --json
CODEX_HOME=<stage>/codex-home codex plugin add workspace-sentinel@workspace-sentinel-local --json
CODEX_HOME=<stage>/codex-home codex plugin list
```

实际结果：

- `marketplace add`：市场名 `workspace-sentinel-local`，根目录为临时 stage，`alreadyAdded: false`。
- `plugin add`：安装 `workspace-sentinel@workspace-sentinel-local`，版本 `0.1.0`，`authPolicy: ON_INSTALL`。
- `plugin list`：状态 `installed, enabled`。
- 这证明当前 Codex 0.139.0 能发现 `.codex-plugin/plugin.json`、示例市场路径和本地安装包结构。

没有在此次校验中执行真实模型会话，也没有信任或运行 hooks。Codex 对插件 hooks 要求单独审查和信任；安装成功不等于 hooks 已执行或已验证。未运行宿主的实际 hook 触发流程。

## Claude Code

```text
not run: host executable unavailable
```

`claude` 不在当前环境 PATH 中，因此没有运行 `claude plugin validate`、marketplace 安装或真实 hook 会话。Claude 清单和 hooks 只经过离线 JSON/结构测试。

## DeepSeek Harness

```text
not run: no live DSH runtime
```

`dsh` 不在当前环境 PATH 中，因此没有运行 `dsh plugin --profile ... add`、`dsh --profile ... --dump-config` 或真实会话。DSH 适配器只通过模拟 Cordis `ctx.on` 与工具/会话事件测试。`engines.dsh` 故意未声明，不声称生产兼容。

## 已知验证边界

- Codex hooks 已安装但未信任、未在真实回合中触发；Shell 写入的观察仍受快照可用性限制。
- 挂载点防护通过根目录与 `/proc` 的 `st_dev` 差异测试；未覆盖 bind mount 的极端别名场景。
- 验证超时会先 `SIGTERM`、短宽限后 `SIGKILL`；Unix 退出验证使用独立进程组，超时会清理整个命令树；长驻命令在 readiness 前退出时也会清理残留进程组；不覆盖操作系统拒绝终止的不可中断进程。
- Claude hook 的实际输出 schema、SessionStart/SessionEnd 行为和 marketplace 校验未在真实 CLI 中执行。
- DSH 的字段签名、审批通道和 bundle 加载未在真实运行时执行。
- 没有验证 Windows/macOS 的宿主行为；路径函数有 Windows 单元测试，但真实文件系统和宿主 hook 未跑。
- 没有执行 npm 发布、远端 Git 推送或签名/公证流程。
- 长驻应用 readiness 与进程清理使用本地 Node 子进程测试，未覆盖其他语言或守护进程管理器。
