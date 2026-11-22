# Workspace Sentinel

一个本地 npm 包，同时提供 **OpenAI Codex**、**Claude Code** 和 **DeepSeek Harness** 插件。它记录任务中新建的文件，阻止把临时文件堆到项目根目录，并在满足安全门禁后精简工作区。

核心原则：只处理能确认属于本次任务、由 Agent 创建的文件。任务开始前已有的文件、无法确认归属的文件、符号链接和受保护路径默认不动。

## 两种工作流

### 内容产物（PPT、文档、表格、PDF、图片、HTML）

1. 任务开始后建立 `artifact` 任务。
2. Agent 把草稿、渲染中间页和提取文件写到任务专属 scratch，而不是项目根目录。
3. 登记最终候选和需要删除的中间文件。
4. 只有一个候选时 Agent 可直接选定；有多个版本时 **必须由用户选择保留哪一版**，用户选版前不会删除候选。
5. 最终成品和必要的 support 文件保留；已登记的、确认由本次任务创建的中间文件会被 **永久删除，不进回收站，不可恢复**。
6. 归属不明、计划后被修改、位于受保护路径或属于 preexisting 的文件会出现在 `skipped`，不会为了“清干净”而冒险删除。

### 软件项目

1. 生成运行清单：`keep` 运行时文件、可恢复 `quarantine` 的源码/测试/文档、验证命令和云端保存目标。
2. 向用户展示清单与摘要 digest。**Agent 生成后交用户确认，确认后才可执行最终精简。**
3. 用户明确批准后，源码等文件移动到项目外的 **quarantine 隔离区**，不是永久删除。验证失败会按日志恢复。
4. 只有目标产物通过一次性退出验证，或长驻应用通过 readiness 检查，精简才算成功。
5. 回收区不会自动清空。永久 `purge` 必须由用户另行明确要求。

## 云端验证与本地精简

GitHub 不是唯一条件。只要用户明确表示要把项目保存到某个云端，云端保存完成后才可精简本地。

- 普通目标可使用用户明确确认的 `user-confirmed` 证据。
- 计划内含 `.git` 等 VCS 路径时，必须使用可执行的 `readback` 验证，不能只凭口头确认。
- 上传命令成功、Agent 自称“已经上传”都不算云端验证；验证失败时门禁保持关闭。

## 安装

三种宿主共用这一份代码。Node.js 需要 22 或更高版本，没有第三方运行时依赖。

### Codex

把插件目录放在 marketplace 的 `plugins/` 下，并把示例 market 文件放到 `.agents/plugins/marketplace.json`：

```bash
mkdir -p plugins .agents/plugins
cp -R /path/to/workspace-sentinel plugins/workspace-sentinel
cp plugins/workspace-sentinel/examples/codex-marketplace.json .agents/plugins/marketplace.json
codex plugin marketplace add .
codex plugin add workspace-sentinel@workspace-sentinel-local
codex plugin list
```

`source.path` 必须是相对 marketplace 根目录、以 `./` 开头且不逃逸的目录路径；示例已使用 `./plugins/workspace-sentinel`。安装后重启 Codex。

### Codex Hook 信任

安装或启用插件 **不会自动信任 hooks**。Codex 会把插件 hooks 当作非托管 hooks，在用户查看并信任当前定义前跳过执行。需要检查 `hooks/codex.json`、`src/adapters/codex.js` 和 Node 后端代码后再批准。不要为了省事长期使用 `--dangerously-bypass-hook-trust`。

### Claude Code

```bash
mkdir -p plugins .claude-plugin
cp -R /path/to/workspace-sentinel plugins/workspace-sentinel
cp plugins/workspace-sentinel/examples/claude-marketplace.json .claude-plugin/marketplace.json
claude plugin validate .
claude plugin marketplace add .
claude plugin install workspace-sentinel@workspace-sentinel-local
```

也可以直接加载本地插件目录，不经过 marketplace：

```bash
claude --plugin-dir /path/to/workspace-sentinel
```

### DeepSeek Harness

DSH 目前仍为技术预览，本仓库没有在真实 DSH 运行时验证。安装命令：

```bash
dsh plugin --profile workspace-sentinel add /path/to/workspace-sentinel
dsh --profile workspace-sentinel --dump-config
dsh --profile workspace-sentinel
```

`package.json` 使用 `dsh.bundle.patch` 指向 `cordis.patch.yml`，入口导出 `apply(ctx)`。更完整说明见 `examples/dsh-install.md`。因为没有经过真实宿主验证，`engines.dsh` 故意留空，不声称生产兼容。

## 使用方式

Agent 通过共享 Skill 和 JSON CLI 操作。所有命令 stdout 只输出一个 JSON 对象：

```bash
node "$PLUGIN_ROOT/src/cli.js" start \
  --data-dir "$PLUGIN_DATA" --root "$PWD" --mode artifact
```

宿主明确提供 session ID 时可追加 `--session "<session id>"`。省略时，hooks 只在同一根目录中恰好有一个活动任务时自动关联；多个活动任务共享根目录时保持未关联，文件按 unknown 处理而不误删。

常用命令：`start`、`set-mode`、`status`、`artifact-plan`、`select-final`、`software-plan`、`approve-plan`、`cloud-verified`、`cloud-readback`、`finalize`、`restore`、`purge`。

任务开始后，临时输出应写入返回的 `scratchDir`。不要用 `rm -rf` 或手写脚本绕过清理协议。

## 恢复与清空

```bash
node "$PLUGIN_ROOT/src/cli.js" restore --data-dir "$PLUGIN_DATA" --batch "<batch id>"
node "$PLUGIN_ROOT/src/cli.js" purge --data-dir "$PLUGIN_DATA" --batch "<batch id>"
```

`restore` 只恢复隔离批次并避免覆盖后来重新出现的源文件。`purge` 是单独的永久操作，不能随任务结束自动触发。内容产物的永久删除与软件 quarantine 是两套不同路径，不要混用。

## 数据位置

- Codex：`PLUGIN_ROOT` / `PLUGIN_DATA`，兼容 `CLAUDE_PLUGIN_*`。
- Claude Code：`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`。
- DSH 或直接使用：插件目录 + `$DSH_HOME/workspace-sentinel`，无 `DSH_HOME` 时用 `~/.dsh/workspace-sentinel`。

任务状态、审计 JSONL、scratch 和软件 quarantine 都放在项目外；项目根只保留目标或显式隔离结果。

## 安全边界

- 永久删除只允许 plugin-owned scratch，或本次任务开始后观察到的 Agent 创建文件。
- Bash 快照会把改名或复制后与原有文件指纹相同的新路径标记为 preexisting，避免把用户原文件当作临时产物删除。
- 任务前已有的文件和未观察到的新文件永不永久删除。
- 文件在计划后发生变化会被跳过；符号链接组件、跨文件系统挂载点和状态文件中的越界路径拒绝处理；`.env`、凭据、VCS 和宿主状态受保护。
- 软件 quarantine 可恢复，且不自动清空。
- hooks are not a security sandbox / 钩子不是安全沙箱。它们降低误操作概率，但不能阻止所有 Shell 写入，也不能替代宿主沙箱、权限或用户审查。
- Codex 的 Bash 不解析命令内容，只提供 scratch 指引并依赖前后快照；快照缺失时文件保持 unknown。

## 开发与验证

```bash
node --test
node --check index.js
node --check src/cli.js
npm pack --dry-run
git diff --check
```

真实宿主验证记录在 `VALIDATION.md`，包括已运行的 Codex 隔离市场/安装检查，以及因可执行文件缺失而明确标记为 `not run` 的 Claude 和 DSH 检查。

## 目录

```text
.codex-plugin/plugin.json     Codex 清单
.claude-plugin/plugin.json    Claude Code 清单
hooks/                        两端 hook 配置
skills/workspace-sentinel/    共享 Skill
src/cli.js                    JSON CLI
src/core/                     路径、证据、计划、隔离、验证
src/adapters/                 三端事件适配
index.js                      DSH apply 入口
cordis.patch.yml              DSH bundle 层
examples/                     市场与安装示例
```

License: MIT
