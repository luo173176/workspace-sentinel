# DeepSeek Harness 安装

## 状态

DSH 仍处于技术预览。本仓库只做了离线 Cordis 接口模拟测试，没有在真实 DSH 运行时加载过，因此没有声明 `engines.dsh`。以下命令来自官方当前文档，实际兼容性需由你的 DSH 版本验证；不要把它视为已验证的生产兼容声明。

## 从本地 checkout 安装

`package.json` 已声明：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`cordis.patch.yml` 按包名插入插件行。先在包含本仓库的上一级目录执行：

```bash
dsh plugin --profile workspace-sentinel add /absolute/path/to/workspace-sentinel
```

首次使用会创建 profile，并把基础组合包放在最前。`dsh plugin` 会把参数转发给 profile 内的 pnpm；如果从 git 或 tarball 安装，安装权限与源码信任由你自行确认。

## 验证配置层

不要启动 Agent，先检查组合配置：

```bash
dsh --profile workspace-sentinel --dump-config
```

输出应出现 `dsh-workspace-sentinel` 对应的 patch 层。若没有该层，检查包是否正确安装，以及当前 DSH 是否识别 `dsh.bundle`。

## 启动

```bash
dsh --profile workspace-sentinel
```

首次会话应加载 `workspace-sentinel` Skill。插件数据目录默认是 `$DSH_HOME/workspace-sentinel`；没有 `DSH_HOME` 时使用 `~/.dsh/workspace-sentinel`。Skill 中的 `DATA` 必须与此一致。

## 使用 tarball

```bash
npm pack
dsh plugin --profile workspace-sentinel add ./dsh-workspace-sentinel-0.1.0.tgz
```

## 移除

```bash
dsh plugin --profile workspace-sentinel remove dsh-workspace-sentinel
```

## DSH 行为边界

- 插件只注册 `tools/pre-execute`、`tools/result`、`session/event` 和 `session/disposed` 这些通用事件。
- 不占用单槽 `fs/*-intent` waterfall，避免与其他文件策略插件冲突。
- 软件项目的 `finalize` 命令会请求宿主审批；若没有已批准计划，直接拒绝。DSH 没有审批通道时，`ask` 会按宿主规则被拒绝。
- 普通内容产物在正常完成的回合结束时可以自动精简已选定的单版本；多候选仍必须由用户选择。
- 若当前 DSH 版本的字段或事件签名不同，请先记录为未通过验证，不要用模拟测试替代真实兼容性结论。
