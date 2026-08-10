---
name: codex-review
description: Use this skill when users ask for code review, review pending changes, or inspect the latest commit with Codex-based review workflows. It prepares context, runs project linting, and reviews the result.
license: MIT
compatibility: Designed for Claude Code; requires git and codex CLI; may also need project-specific lint or format tools available in PATH.
metadata:
  author: BenedictKing
  version: "2.5.0"
  user-invocable: "true"
allowed-tools: Bash Read Glob Write Edit
---

# Codex Code Review Skill

## Trigger Conditions

Triggered when user input contains:

- "代码审核", "代码审查", "审查代码", "审核代码"
- "review", "code review", "review code", "codex 审核"
- "帮我审核", "检查代码", "审一下", "看看代码"

## Core Concept: Intention vs Implementation

Running `codex review --uncommitted` alone only shows AI "what was done (Implementation)".
Recording intention first tells AI "what you wanted to do (Intention)".

**"Code changes + intention description" as combined input is the most effective way to improve AI code review quality.**

## Skill Architecture

This skill operates in two phases:

1. **Preparation Phase** (current context): Check working directory, update CHANGELOG
2. **Review Phase** (isolated context): Invoke Task tool to execute Lint + codex review (using context: fork to reduce context waste)

## Execution Steps

### 0. [First] Check Working Directory Status

```bash
git diff --name-only && git status --short
```

**Decide review mode based on output:**

- **Has uncommitted changes** → Continue with steps 1-4 (normal flow)
- **Clean working directory** → Assess `HEAD` with the same difficulty criteria, then invoke `codex review --commit HEAD` with the matching model configuration

### 1. [Mandatory] Check if CHANGELOG is Updated

**Before any review, must check if CHANGELOG.md contains description of current changes.**

```bash
# Check if CHANGELOG.md is in uncommitted changes
git diff --name-only | grep -E "(CHANGELOG|changelog)"
```

**If CHANGELOG is not updated, you must automatically perform the following (don't ask user to do it manually):**

1. **Analyze changes**: Run `git diff --stat` and `git diff` to get complete changes
2. **Auto-generate CHANGELOG entry**: Generate compliant entry based on code changes
3. **Write to CHANGELOG.md**: Use Edit tool to insert entry at top of `[Unreleased]` section
4. **Continue review flow**: Immediately proceed to next steps after CHANGELOG update

**Auto-generated CHANGELOG entry format:**

```markdown
## [Unreleased]

### Added / Changed / Fixed

- Feature description: what problem was solved or what functionality was implemented
- Affected files: main modified files/modules
```

**Example - Auto-generation Flow:**

```
1. Detected CHANGELOG not updated
2. Run git diff --stat, found handlers/responses.go modified (+88 lines)
3. Run git diff to analyze details: added CompactHandler function
4. Auto-generate entry:
   ### Added
   - Added `/v1/responses/compact` endpoint for conversation context compression
   - Supports multi-channel failover and request body size limits
5. Use Edit tool to write to CHANGELOG.md
6. Continue with lint and codex review
```

### 2. [Critical] Stage All New Files

**Before invoking codex review, must add all new files (untracked files) to git staging area, otherwise codex will report P1 error.**

```bash
# Check for new files
git status --short | grep "^??"
```

**If there are new files, automatically execute:**

```bash
# Safely stage all new files (handles empty list and special filenames)
git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do git add -- "$f"; done
```

**Explanation:**

- `-z` uses null character to separate filenames, correctly handles filenames with spaces/newlines
- `while IFS= read -r -d ''` reads filenames one by one
- `git add -- "$f"` uses `--` separator, correctly handles filenames starting with `-`
- When no new files exist, loop body doesn't execute, safely skipped
- This won't stage modified files, only handles new files
- codex needs files to be tracked by git for proper review

### 3. Evaluate Task Difficulty and Invoke codex-runner

**Count change scale:**

```bash
# Get summary line for ALL changes (staged + unstaged)
# IMPORTANT: Must use 'HEAD' as base to include both staged and unstaged changes
git diff --stat HEAD | tail -1
```

For a clean working directory, assess the latest commit instead:

```bash
git show --stat --format= HEAD | tail -1
```

**Why use `git diff --stat HEAD`:**
- `git diff --stat` only shows unstaged changes
- `git diff --cached --stat` only shows staged changes
- `git diff --stat HEAD` shows BOTH staged and unstaged changes combined
- The last line (`tail -1`) is the summary line with total file count and line changes

**Difficulty Assessment Criteria:**

**Model + Reasoning Effort Combinations:**

选型由 `scripts/select-review-model.mjs` 根据实时 codexradar 智商/成本/耗时数据驱动决定：
1. 先判定难度等级（Normal / Difficult / Critical）
2. 调用脚本获取该难度下的推荐 model + effort（以及按实测耗时推导的 timeout）

脚本指标与 codexradar 站点「综合成本 × 智力」图表同量纲：

- `iq = p / n * 150`（0-150 刻度）
- `price = mean(actual_cost_usd)`；`minutes = mean(duration_sec) / 60`

选型主约束是**实测平均耗时**（时间预算），每档一个目标函数，在全部 model × effort 组合上全局比较：

- **普通** = 平均耗时 ≤ 18min 且 IQ ≥ 70 的组合里**最便宜**者（日常审查省钱优先）
- **困难** = 平均耗时 ≤ 28min 的组合里 **IQ 最高**者；IQ 并列容差（<1.5）内取更便宜者
- **关键** = 同困难，但时间预算放宽到 45min

两条规则合起来天然落在成本-智力 Pareto 前沿上：

- 时间预算排除慢档（避免选到平均耗时远超预期的"高 effort 慢档"）。
- IQ 并列容差避免为噪声级 IQ 差付数倍成本，也让"贵而不智"的档（如 `sol max` 比 `sol xhigh` 贵还弱）不会中选。

**超时不再写死**：`timeout = ceil(实测平均分钟 × 2)`，随选中档位走，由脚本输出的 `timeoutMinutes` / `timeoutMs` 给出。fallback 候选也各带自己的 timeout，重试时用它自己的时限。

脚本内置 1 小时 TTL 缓存（`~/.cache/codex-review/radar.json`），网络与缓存都不可用时回退到保守默认值：

| Difficulty | Built-in Default | 推导 Timeout |
|------------|------------------|---------|
| Normal | `model=gpt-5.6-luna effort=high` | 35 min |
| Difficult | `model=gpt-5.6-sol effort=xhigh` | 53 min |
| Critical | `model=gpt-5.6-sol effort=xhigh` | 53 min |

时间预算与 IQ 下限可用 `--max-minutes` / `--iq-floor` 覆盖（分钟 / 0-150 刻度）。若时间预算内无组合达标，脚本退化为取全局最高 IQ，不会无解。

**Model Fallback Policy:**

- Determine availability from the actual `codex review` result. Do not use `codex debug models` as a preflight gate.
- Treat only explicit model or reasoning-effort availability failures as a fallback trigger, such as a model not found, unavailable model access, or an unsupported reasoning effort.
- Do not fall back for review findings, lint failures, authentication or network failures, timeouts, or a model-metadata warning when the review has started.
- **Dynamic fallback chain**: use the `fallback` array returned by `select-review-model.mjs`, ordered by descending IQ. Each entry is from a **different model family** than the primary, because a same-family effort swap cannot work around a model-unavailable failure. Retry each candidate in order after an explicit availability failure.
- **Per-candidate timeout**: each fallback entry includes its own `timeoutMs` (derived from that candidate's measured minutes). Use it when retrying, not the primary's timeout.
- If the script itself fails or returns no fallback, use the built-in defaults as the final fallback.
- Run lint only once. On an availability failure, retry only `codex review` with the next candidate. Stop after exhausting the fallback chain and report the error.

**Critical Tasks** (meets any condition, use data-driven selection):

- Modified files ≥ 30
- Total code changes (insertions + deletions) ≥ 2000 lines
- Involves core architecture/algorithm changes (user explicitly mentioned)
- **Config**: Run `node <skill-dir>/scripts/select-review-model.mjs --difficulty critical`; use the returned primary `model`/`effort` and the returned `timeoutMs` as the Task timeout
- If the script is unavailable, fallback to built-in default: `model=gpt-5.6-sol effort=xhigh`, timeout 53 minutes

**Difficult Tasks** (meets any condition):

- Modified files ≥ 10
- Total code changes (insertions + deletions) ≥ 500 lines
- Single metric: insertions ≥ 300 lines OR deletions ≥ 300 lines
- Cross-module refactoring
- **Config**: Run `node <skill-dir>/scripts/select-review-model.mjs --difficulty difficult`; use the returned primary `model`/`effort` and `timeoutMs`
- If the script is unavailable, fallback to built-in default: `model=gpt-5.6-sol effort=xhigh`, timeout 53 minutes

**Normal Tasks** (other cases):

- **Config**: Run `node <skill-dir>/scripts/select-review-model.mjs --difficulty normal`; use the returned primary `model`/`effort` and `timeoutMs`
- If the script is unavailable, fallback to built-in default: `model=gpt-5.6-luna effort=high`, timeout 35 minutes

**Evaluation Method:**

You MUST parse the `git diff --stat HEAD` output correctly to determine difficulty:

```bash
# Get the summary line (last line of git diff --stat HEAD)
git diff --stat HEAD | tail -1
# Example outputs:
# "20 files changed, 342 insertions(+), 985 deletions(-)"
# "1 file changed, 50 insertions(+)"  # No deletions
# "3 files changed, 120 deletions(-)"  # No insertions
```

**Critical: Why the summary line matters:**
- Each file shows individual stats: `file.go | 171 ++++++++++++++++++++-`
- Only the LAST line has the total: `6 files changed, 1341 insertions(+), 18 deletions(-)`
- You must extract the last line with `tail -1` to get accurate totals

**Parsing Rules:**
1. Extract file count from "X file(s) changed" (handle both "1 file" and "N files")
2. Extract insertions from "Y insertion(s)(+)" if present (handle both "1 insertion" and "N insertions"), otherwise 0
3. Extract deletions from "Z deletion(s)(-)" if present (handle both "1 deletion" and "N deletions"), otherwise 0
4. Calculate total changes = insertions + deletions

**Important Edge Cases:**
- Single file: `"1 file changed"` (singular form)
- No insertions: Git omits `"insertions(+)"` entirely → treat as 0
- No deletions: Git omits `"deletions(-)"` entirely → treat as 0
- Pure rename: May show `"0 insertions(+), 0 deletions(-)"` or omit both

**Decision Logic (check in order, first match wins):**
- IF file_count >= 30 OR total_changes >= 2000 → **Critical** (run script `--difficulty critical`)
- IF file_count >= 10 → **Difficult** (run script `--difficulty difficult`)
- IF total_changes >= 500 → **Difficult** (run script `--difficulty difficult`)
- IF insertions >= 300 OR deletions >= 300 → **Difficult** (run script `--difficulty difficult`)
- ELSE → **Normal** (run script `--difficulty normal`)

**Example Cases:**
- ⭐ "50 files changed, 2000 insertions(+), 1500 deletions(-)" → **Critical task**, run script `--difficulty critical` → use returned primary (currently `gpt-5.6-sol effort=xhigh`), use returned `timeoutMs`
- ✅ "20 files changed, 342 insertions(+), 985 deletions(-)" → **Difficult task**, run script `--difficulty difficult` → use returned primary (currently `gpt-5.6-sol effort=xhigh`), use returned `timeoutMs`
- ✅ "5 files changed, 600 insertions(+), 50 deletions(-)" → **Difficult task**, run script `--difficulty difficult` → use returned primary (currently `gpt-5.6-sol effort=xhigh`), use returned `timeoutMs`
- ❌ "3 files changed, 150 insertions(+), 80 deletions(-)" → **Normal task**, run script `--difficulty normal` → use returned primary (currently `gpt-5.6-luna effort=high`), use returned `timeoutMs`
- ❌ "1 file changed, 50 insertions(+)" → **Normal task**, run script `--difficulty normal` → use returned primary (currently `gpt-5.6-luna effort=high`), use returned `timeoutMs`

普通任务落在 `gpt-5.6-luna effort=high` 是符合预期的：它同时满足"耗时 ≤ 18min 且 IQ ≥ 70"，且全表最便宜（约 $0.2 / 17min / IQ 74.6）。在 Pareto 前沿上再往上，`terra max` 仅多 2.7 IQ 却要近 8 倍成本，`sol max` 比 `sol xhigh` 贵还弱——这类坏拐点都被选型规则跳过。困难/关键档当前都落在 `sol xhigh`：它是高价区性价比拐点（IQ 103.6 / $6.26 / 26min），比顶点 `sol ultra`（106.7 / $20.95 / 54min）只低 3 IQ，成本却只有 1/3。

**Dynamic Model Selection Flow:**

After determining the difficulty level, obtain the recommended model and effort dynamically:

```bash
# Resolve the skill directory path (adjust if your skill installation path differs)
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)/scripts" 2>/dev/null || SKILL_DIR="$HOME/.claude/skills/codex-review/scripts"
MODEL_JSON=$(node "$SKILL_DIR/select-review-model.mjs" --difficulty <normal|difficult|critical>)
PRIMARY_MODEL=$(echo "$MODEL_JSON" | jq -r '.primary.model')
PRIMARY_EFFORT=$(echo "$MODEL_JSON" | jq -r '.primary.effort')
PRIMARY_TIMEOUT_MS=$(echo "$MODEL_JSON" | jq -r '.primary.timeoutMs')   # timeout derived from measured minutes
```

Use the extracted `PRIMARY_MODEL` and `PRIMARY_EFFORT` to build the review command, and `PRIMARY_TIMEOUT_MS` as the Task timeout.

**Invoke codex-runner Subtask:**

Use Task tool to invoke codex-runner, passing complete command (including Lint + codex review):

```
Task parameters:
- subagent_type: Bash
- description: "Execute Lint and codex review"
- timeout: <timeoutMs from the selection script>   (derived from the chosen model's measured minutes)
- prompt: Choose corresponding command based on project type and difficulty

Build the prompt as:
  <lint command> && codex review <mode> --config model=<primary-model> --config model_reasoning_effort=<primary-effort>

Pass exactly these flags and nothing else. Do not add --full-auto, -s/--sandbox, or any
--dangerously-* flag: `codex review` does not accept them (see "CLI Compatibility and Flag
Discipline"), and adding one is an unrequested safety-gate bypass.

After lint succeeds, apply the dynamic fallback policy. Retry only `codex review <mode>` with the next candidate from the fallback array after an explicit model or reasoning-effort availability failure. Use that candidate's own timeoutMs for the retry.

Lint command (by project type):
  Go:     go fmt ./... && go vet ./...
  Node:   npm run lint:fix
  Python: black . && ruff check --fix .

Model + timeout (by difficulty, both from the selection script):
  Critical:  run script --difficulty critical  → use returned primary model/effort/timeoutMs
  Difficult: run script --difficulty difficult  → use returned primary model/effort/timeoutMs
  Normal:    run script --difficulty normal     → use returned primary model/effort/timeoutMs

Example (Go, Normal, after script returns luna+high):
  go fmt ./... && go vet ./... && codex review --uncommitted --config model=gpt-5.6-luna --config model_reasoning_effort=high

Clean working directory (review last commit, no lint):
  codex review --commit HEAD --config model=<primary-model> --config model_reasoning_effort=<primary-effort>
  (model/effort/timeout obtained from select-review-model.mjs)
```

### 4. Self-Correction and Severity-Driven Fixes

If Codex finds Changelog description inconsistent with code logic:

- **Code error** → Fix code
- **Description inaccurate** → Update Changelog

If Codex reports **P0 / P1 / P2** issues, you must **proactively fix them immediately** instead of stopping at reporting.

**Required behavior:**

1. **P0 / P1 / P2 present** → directly modify code or related files to fix the issue
2. **After fixing** → rerun the necessary lint / validation / review command to confirm the issue is resolved
3. **If rerun still reports any P0 / P1 / P2** → continue fixing and rerunning review in a loop
4. **Only report completion after the rerun review reports no P0 / P1 / P2 issues**
5. **Clearly state what was fixed and what verification passed**
6. **P3 or lower / suggestion only** → may report without automatic modification unless the user explicitly asks for further cleanup

**Review loop rule:**
- The workflow is not successful while any P0 / P1 / P2 issue remains
- After each round of fixes, rerun the appropriate lint / validation / codex review steps
- Repeat until Codex no longer reports P0 / P1 / P2 issues
- Only then treat the review as passed and return the final result

**Final pass reporting rule:**
- After the final rerun passes, explicitly report that the final review is complete and passed
- The final result should include:
  - Codex final conclusion (for example: no functional errors, obvious regressions, or merge-blocking defects found)
  - Test results that actually ran in this round
  - Lint / formatting / validation results that actually ran in this round
- Do not claim checks that were not actually executed
- Prefer a concise final format similar to:

```text
⏺ Final review complete. Passed.

Result:
- Codex final conclusion: No defects were found that would cause functional errors, obvious regressions, or block merge
- Tests passed: <actual test command(s) executed>
- Lint / validation passed: <actual lint, fmt, vet, or other validation command(s) executed>
```

**Fix priority:**
- **P0**: Blocker, security, data loss, correctness failure → must fix first
- **P1**: High-impact functional or logic bug → must fix
- **P2**: Important maintainability / correctness issue with clear fix → should proactively fix in the same run

**Constraints:**
- Keep fixes minimal and directly related to the reported issue
- Do not expand scope into unrelated refactors
- Preserve existing style and architecture unless the issue requires structural adjustment

## Complete Review Protocol

1. **[GATE] Check CHANGELOG** - Auto-generate and write if not updated (leverage current context to understand change intention)
2. **[PREPARE] Stage Untracked Files** - Add all new files to git staging area (avoid codex P1 error)
3. **[EXEC] Task → Lint + codex review** - Invoke Task tool to execute Lint and codex (isolated context, reduce waste)
4. **[FIX LOOP] Severity-Driven Self-Correction** - Fix code or update description when intention ≠ implementation; if any P0/P1/P2 appears, keep fixing and rerunning checks until none remain

## Codex Review Command Reference

### Basic Syntax

```bash
codex review [OPTIONS] [PROMPT]
```

**Note**: `[PROMPT]` parameter cannot be used with `--uncommitted`, `--base`, or `--commit`.

### Common Options

| Option                     | Description                                                      | Example                                                      |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `--uncommitted`            | Review all uncommitted changes in working directory (staged + unstaged + untracked) | `codex review --uncommitted`                                 |
| `--base <BRANCH>`          | Review changes relative to specified base branch                 | `codex review --base main`                                   |
| `--commit <SHA>`           | Review changes introduced by specified commit                    | `codex review --commit HEAD`                                 |
| `--title <TITLE>`          | Optional commit title, displayed in review summary               | `codex review --uncommitted --title "feat: add JSON parser"` |
| `-c, --config <key=value>` | Override configuration values                                    | `codex review --uncommitted -c model="gpt-5.6-terra"`      |

### Usage Examples

```bash
# 1. Review all uncommitted changes (most common)
codex review --uncommitted

# 2. Review latest commit
codex review --commit HEAD

# 3. Review specific commit
codex review --commit abc1234

# 4. Review all changes in current branch relative to main
codex review --base main

# 5. Review changes in current branch relative to develop
codex review --base develop

# 6. Review with title (title shown in review summary)
codex review --uncommitted --title "fix: resolve JSON parsing errors"

# 7. Review using dynamically selected model and effort (as determined by select-review-model.mjs)
codex review --uncommitted -c model="<primary-model>" -c model_reasoning_effort="<primary-effort>"
```

### Important Limitations

- `--uncommitted`, `--base`, `--commit` are mutually exclusive, cannot be used together
- `[PROMPT]` parameter is mutually exclusive with the above three options
- Must be executed in a git repository directory

### CLI Compatibility and Flag Discipline

**Check the CLI version first when a flag is rejected:**

```bash
codex --version   # e.g. codex-cli 0.145.0
codex review -h   # authoritative list of accepted flags for THIS version
```

`codex review` accepts only these options (verified on codex-cli 0.145.0):

`-c/--config`, `--strict-config`, `--enable`, `--disable`, `--uncommitted`, `--base`, `--commit`, `--title`, `-h/--help`

**Never add approval or sandbox flags to `codex review`.** The following belong to `codex exec`, not `codex review`, and passing them makes the command fail with `error: unexpected argument`:

- `--full-auto`
- `-s` / `--sandbox <read-only|workspace-write|danger-full-access>`
- `--dangerously-bypass-approvals-and-sandbox`
- `--dangerously-bypass-hook-trust`

`codex review` is already non-interactive and read-only; it needs no approval bypass. Beyond breaking the command, adding such a flag is an unrequested safety-gate bypass that a host permission layer (for example the Claude Code auto mode classifier) will deny.

**Rules when a codex invocation fails:**

1. `error: unexpected argument '--x'` → the flag does not exist on this subcommand. Run `codex review -h`, remove the flag, retry. Do not substitute a different bypass flag.
2. A denied command is a decision, not a transient error. Do not re-run it verbatim and do not reach for a stronger flag to get past it. Report the blocker instead.
3. Only ever add flags from the verified list above. Model and effort go through `-c/--config`, never through invented CLI flags.

## Important Notes

- Ensure execution in git repository directory
- **Verify CLI surface before improvising flags**: run `codex --version` and `codex review -h`. Only the flags that `-h` lists are valid on this version. Never add `--full-auto`, `-s/--sandbox`, or `--dangerously-*` to `codex review`.
- **Timeout derived from the chosen model**: the script returns `timeoutMs` = `ceil(measuredMinutes × 2)` per candidate (roughly 35 / 53 min under current data). Use the selected candidate's `timeoutMs` as the Task timeout, not a fixed per-difficulty constant.
- codex command must be properly configured and logged in
- codex automatically processes in batches for large changes
- **CHANGELOG.md must be in uncommitted changes, otherwise Codex cannot see intention description**

## Design Rationale

**Why separate contexts?**

1. **CHANGELOG update needs current context**: Understanding user's previous conversation and task intention to generate accurate change description
2. **Codex review doesn't need conversation history**: Only needs code changes and CHANGELOG, more efficient to run independently
3. **Reduce token consumption**: codex review as independent subtask, doesn't carry irrelevant conversation context
