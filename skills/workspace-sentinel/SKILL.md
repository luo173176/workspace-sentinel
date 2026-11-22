---
name: workspace-sentinel
description: Use when starting, editing, or finalizing a software project or a content artifact such as a PPT, document, image, table, PDF, or HTML page. Prevents workspace clutter and applies user-confirmed cleanup rules.
---

# Workspace Sentinel

Manage the current task workspace with deterministic CLI commands. Hooks normally record created files automatically; this Skill decides the task mode, registers final artifacts, and runs the approved finalization protocol.

## Resolve Paths

Resolve the plugin root in this order:

1. `CLAUDE_PLUGIN_ROOT` for Claude Code.
2. `PLUGIN_ROOT` for Codex.
3. The directory two levels above this Skill file for direct or DSH use.

Resolve the plugin data directory in this order:

1. `CLAUDE_PLUGIN_DATA` for Claude Code.
2. `PLUGIN_DATA` for Codex.
3. `${DSH_HOME:-$HOME/.dsh}/workspace-sentinel` for DSH or direct use.

Set these conceptual values for every command:

```bash
ROOT=<resolved plugin root>
DATA=<resolved plugin data directory>
CLI="$ROOT/src/cli.js"
```

Never use `rm`, `rm -rf`, `del`, manual glob deletion, or a shell pipeline as a substitute for the CLI. Every command prints one JSON object. Stop and report the error code when `ok` is false.

## Start the Task Early

Call once, before generating the bulk of the work:

```bash
node "$CLI" start --data-dir "$DATA" --root "<task root>" --mode <software|artifact|audit>
```

- `software`: a runnable application, service, CLI, library, or buildable project.
- `artifact`: PPT, document, image, table, PDF, HTML, or similar content deliverable.
- `audit`: unclear task or missing hook support. It may inspect but never delete or quarantine workspace files.

If the host explicitly exposes a session ID, append `--session "<session id>"`. When it does not, omit the flag: hooks associate a single active task in the same root automatically. If multiple active tasks share one root, hooks stay unattached and files remain unknown rather than being attributed to the wrong task.

Use the returned `scratchDir` for extraction, previews, temporary renders, intermediate scripts, and working copies. Do not write these in the task root.

If the task already started and files exist before `start`, they become baseline files and are never permanent-deletion candidates.

## Artifact Workflow

1. Register candidates and the exact intermediate-delete list:

```bash
node "$CLI" artifact-plan --data-dir "$DATA" --task "<task id>" --file "<plan.json>"
```

`plan.json`:

```json
{
  "candidates": [
    { "path": "/absolute/final-a.pptx", "support": ["/absolute/required-theme.dat"] },
    { "path": "/absolute/final-b.pptx", "support": [] }
  ],
  "intermediates": ["/absolute/draft.tmp"]
}
```

2. One candidate is selected by Agent automatically. With multiple candidates, ask the user which version to keep and wait. Never choose for them. Then record their choice:

```bash
node "$CLI" select-final --data-dir "$DATA" --task "<task id>" --path "<chosen absolute path>" --by user
```

3. Finalize before the final response when the choice is resolved:

```bash
node "$CLI" finalize --data-dir "$DATA" --task "<task id>"
```

Only observed current-task creations or plugin scratch can be permanently deleted. Files that are preexisting, unknown, changed after planning, protected, or linked remain and appear under `skipped`. Report both deletion and skipped counts without hiding the irreversible nature.

## Software Workflow

Do not finalize merely because a reply ends. Wait until the user explicitly says the project is complete and asks to minimize the workspace or equivalent.

1. Build a plan JSON in the scratch area. Include:

- `description`
- `keep`: exact runtime files/directories
- `quarantine`: exact source, test, documentation, or VCS paths to recoverably move
- `verification`: either `{ "kind": "exit", "command": ... }` or `{ "kind": "long-running", "start": ..., "ready": ... }`
- `cloud`: `{ "intent": "none" }` or `{ "intent": "required", "destination": "...", "readback": ... }`

Every command uses an argv array, an explicit `cwd`, and a finite `timeoutMs`. Never provide a shell string.

2. Create the plan:

```bash
node "$CLI" software-plan --data-dir "$DATA" --task "<task id>" --file "<plan.json>"
```

3. Present the plan to the user: keep list, quarantine list, start/readiness behavior, cloud destination, and `plan.digest`. Explain that quarantine is recoverable but purge is permanent. Only after the user explicitly approves the exact plan call:

```bash
node "$CLI" approve-plan --data-dir "$DATA" --task "<task id>" --plan "<plan id>" --digest "<plan digest>"
```

If the plan changes, its digest changes and the old approval becomes invalid. Never fabricate approval.

4. If `cloud.intent` is `required`, upload only through the tool and destination the user authorized. Then either run the readback command already embedded in the approved plan:

```bash
node "$CLI" cloud-readback --data-dir "$DATA" --task "<task id>" --plan "<plan id>" --digest "<digest>"
```

or, when no programmatic readback exists and the user explicitly confirms the cloud copy is complete:

```bash
node "$CLI" cloud-verified --data-dir "$DATA" --task "<task id>" --plan "<plan id>" --digest "<digest>" --reference "<user-confirmed destination>"
```

A successful upload command or Agent claim is not enough. `.git` quarantine requires readback.

5. Finalize and report the run result:

```bash
node "$CLI" finalize --data-dir "$DATA" --task "<task id>"
```

If verification fails, the CLI restores quarantine. Report the error instead of retrying destructive cleanup. On success, report `quarantineSkipped` separately: those entries changed after planning and remain in place, so never claim that all planned source files were isolated.

## Recovery

```bash
node "$CLI" restore --data-dir "$DATA" --batch "<batch id>"
node "$CLI" purge --data-dir "$DATA" --batch "<batch id>"
```

`purge` is independently destructive and requires an explicit user request. Never purge merely because a task ended.

## Completion Report

Report:

- task mode and final artifact or runtime target;
- files kept;
- files quarantined and batch ID;
- files permanently deleted;
- files skipped and the safety reason;
- verification result and any cloud evidence method.

Hooks are workflow guardrails, not a security sandbox. If a host cannot observe a file's creation, treat it as unknown and leave it untouched.
