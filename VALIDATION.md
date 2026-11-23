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

> 更新（2026-11-23）：已在真实 DSH 运行时完成验证，见文末「真实 DSH 验证（2026-11-23）」；以下为历史记录。

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

## 真实 DSH 验证（2026-11-23）

本次在真实 DeepSeek Harness 运行时（非模拟）中验证 workspace-sentinel 插件。宿主版本 `0.2.2-rc.5`；CLI：`D:\Users\luo17\AppData\Local\Programs\resources\runtime\cli\bin\dsh.cmd`；平台 Windows / Node v22.19.0。原始完整输出与日志存于 `projects\ws-sandbox\_evidence\`。

### 1. 安装与配置加载
```text
dsh plugin --profile workspace-sentinel add <repo>
dsh --profile workspace-sentinel --dump-config
```
结果：`initialized profile workspace-sentinel at C:\Users\luo17\.dsh\profiles\workspace-sentinel`；`dsh-workspace-sentinel 0.1.0 <- E:\...\repo`（pnpm v11.28.5，exit 0）。`--dump-config` 中出现插件 patch 层：
```text
# == dsh-workspace-sentinel
- id: workspace-sentinel
  name: dsh-workspace-sentinel
```
（原始 dump：`_evidence\dsh-validation\dump-config.txt`）

为执行真实一次性回合另建 headless 档案：
```text
dsh --profile ws-hl --from-default-profile headless --dump-config
dsh plugin --profile ws-hl add <repo>
```
`ws-hl` 含 `headless-startup` / `headless-runner` 行，`dsh --profile ws-hl "<task>"` 可跑真实单回合并加载插件（插件以 `link:` 指向仓库，改动即时生效）。

### 2. apply(ctx) 与事件真实行为
四个事件在真实宿主中均被触发（tools/pre-execute、tools/result、session/event、session/disposed）。发现并修复的不兼容点：
1. `ToolExecution.agent` 在真实运行时只有 `{ id: SessionId }`，没有 `.session`。原适配层 `sessionOf(exec)` 读 `exec.agent.session` 恒为 null，导致会话解析失败、全部前置校验失效。改为经 `ctx.sessions.get(agent.id)` 解析 Session（`index.js` 注入 resolver，`dsh.js` 保留旧 `.session` 回退以兼容既有单元测试）。
2. DSH 的 shell 工具名是 `pwsh`（Windows），不是 `bash`。已加入适配层 `SHELL_TOOLS`，否则 shell 型 finalize 探测与 shell 证据采集不触发。
3. turn/end 自动 finalize 在真实宿主中确实触发：artifact 任务处于 ready-to-finalize 时，一个普通回复回合会静默删除未选文件。已改为必须显式 finalize 意图，`autoFinalizeOnTurnEnd` 默认 false（前后对比见第 4 节）。
4. 已批准 software finalize 在本适配层返回 `ask`；headless 档案无审批应答者。真实“批准后 finalize”改用插件自带 CLI 执行（非通过 `ask` 通道）；宿主侧 `ask` 审批链路未在真实会话中走通（见“未运行项”）。

### 3. 端到端场景（真实沙箱）
沙箱目录仅限 `projects\ws-sandbox\` 下自建目录，未触碰外部用户文件。
- 场景 A（artifact）：真实模型回合先 `write candidate-a.txt`（成功）、`write tmp/leak.log`（被前置拒绝：`Direct writes to temporary or scratch paths are disabled...`）、`write notes.md`（成功）。`tmp/leak.log` 未落盘；任务 evidence 记录 `candidate-a.txt`/`notes.md` 为 `agent-created`（含 toolCallId 与 sha256）。随后 `artifact-plan`→`select-final --by user`→`finalize`，结果 `deleted:[candidate-a.txt,notes.md] kept:[candidate-b.txt]`，任务开始前已存在的 `keep.txt` 保留。PASS。
- 场景 B（software）：未批准时真实回合尝试 `node src/cli.js finalize` 被拒（`Software finalization requires an explicitly approved plan and cloud gate...`）；CLI 直接 finalize 返回 `{ok:false,code:'PLAN_APPROVAL_INVALID'}`。`approve-plan` 后 `finalize` 返回 `{quarantined:['src'],kept:['run.js','package.json'],verification:'passed',batchId:...}`；`src` 进入 quarantine、`node run.js` 输出 `runtime ok`；`restore --batch` 后 `src/app.js`、`src/util.js` 原样恢复。PASS。

### 4. turn/end 自动 finalize 风险 前后对比
- 修复前（caseB）：artifact 任务 ready-to-finalize，普通回合回复 DONE → 适配器自动 finalize，candidate-x 与 notes2.md 被删、candidate-y 保留、状态 `finalized`，无任何显式 finalize。
- 修复后（caseC，同序列）：普通 DONE 回合 → 状态保持 `ready-to-finalize`，candidate-x/candidate-y/keep.txt/notes2.md 全部保留。
证明默认为显式 finalize；`autoFinalizeOnTurnEnd:true` 可恢复旧行为（有其单元测试）。

### 5. 工程修复与实测
证据快照性能（`evidence.js`：fingerprintFile 改流式哈希；snapshotTree 默认忽略 `.git`/`node_modules`，可配置）。测试目录：5242 个文件 + 1 个 200MB 大文件，`createTask` 快照实测：

| 指标 | 修复前（HEAD 原实现） | 修复后 |
|---|---|---|
| 参与哈希文件数 | 5242（node_modules/.git 全量） | 41（忽略 2 个目录） |
| 耗时（冷启动） | 12631 ms | 325 ms |
| 耗时（热缓存） | 1567 ms | 341 ms |
| 峰值内存 maxRSS | 256 MB | 79 MB |

未忽略文件指纹一致性：修复后快照全部 41 个文件与修复前逐一比对 sha256/size/mode，**mismatches=0**（`_evidence\verify-fingerprints.mjs`）。

根锁死锁（`task-store.js`：带 pid+时间戳锁，回收已死亡进程的陈旧锁；活进程锁仍拒绝并发 finalize）：新增单测 `withRootLock reclaims a stale lock left by a dead process` 与 `withRootLock refuses a lock held by a live process`，先红后绿通过。

### 6. 全量测试
`node --test --test-timeout=30000 --test-force-exit`：**tests 115 / pass 102 / fail 9 / skipped 4**（日志 `_evidence\full-test-run.txt`）。9 个失败均为 Windows 环境/测试夹具问题，非本次改动回归（修改前基线 108 项中同样存在这 9 类失败）：
- Windows 无法创建符号链接 EPERM：6,30,68,82,114
- `tests/cli.test.js:96` 断言 `/tmp` 前缀（Windows 临时路径与 `/tmp` 不符）
- `tests/cli.test.js:129` Windows 反斜杠注入后 `JSON.parse` 坏转义
- `tests/manifests.test.js` SKILL.md 为 CRLF，frontmatter 正则 `^---\n` 不匹配
- `tests/process-verify.test.js:46` Windows `EBUSY rmdir`
4 个 skip 为 mount/进程组 Unix-only 用例。

### 7. 未运行项（明确 not run）
- 宿主侧 `ask` 审批应答链路：not run —— headless 档案无应答者，未在真实会话中走通“批准后经 ask 通道 finalize”；真实批准后 finalize 用 CLI 完成。
- 交互式档案（web/tui）多回合长会话：not run —— 仅用 headless 一次性回合验证真实宿主行为。
- Linux/macOS 上的 DSH 真实运行：not run —— 本机为 Windows。
- Windows 符号链接类用例：not run —— 当前账户无创建符号链接权限（EPERM）。