---
name: codex-runner
version: 1.2.0
author: BenedictKing
description: Independent subtask for executing Lint and codex review with difficulty-based model selection and fallback (internal use)
allowed-tools:
  - Bash
context: fork
---

# Codex Runner Sub-skill

> **Note**: This is an internal sub-skill, invoked by the `codex-review` main skill through the Task tool.

## Purpose

Independently execute Lint and `codex review` commands, using `context: fork` to avoid carrying main conversation context and reduce token consumption.

## Received Parameters

Receives complete command chain through Task tool's prompt parameter:

1. **Lint command**: Auto-selected based on project type (go fmt, npm run lint:fix, black, etc.)
2. **Review mode**: `--uncommitted` or `--commit HEAD` or `--base <branch>`
3. **Model config**: `model` and `model_reasoning_effort` dynamically determined by the main skill via `select-review-model.mjs`
4. **Fallback chain**: Ordered array of `{model, effort}` candidates returned by the script; retry each on explicit availability failure
5. **Timeout**: Controlled through Task tool's timeout parameter (typically 10 min normal, 15 min difficult, 40 min critical)

## Command Examples

```bash
# Build: <lint command> && codex review <mode> --config model=<model> --config model_reasoning_effort=<effort>
#
# Lint command by project type:
#   Go:     go fmt ./... && go vet ./...
#   Node:   npm run lint:fix
#   Python: black . && ruff check --fix .
#
# Model and effort are dynamically selected by the main skill; examples below show typical outputs:
#   Normal              -> gpt-5.6-terra + high  (Pareto-frontier, IQ threshold 70 on the 0-150 scale)
#   Difficult           -> gpt-5.6-sol   + high  (higher IQ, threshold 88)
#   Critical            -> gpt-5.6-sol   + max   (highest IQ, cost-tiebroken within 1.5 IQ)
#
# Fallback order after an explicit model or reasoning-effort availability failure:
#   Use the fallback array provided in the Task prompt, ordered by descending IQ.
#   Each candidate is from a different model family than the primary, since a same-family
#   effort swap cannot work around a model-unavailable failure.
#   Example fallback chain for normal difficulty:
#     gpt-5.5 + high -> gpt-5.6-sol + low -> gpt-5.6-luna + xhigh

# Example: Go project, Normal task (dynamic selection returned terra+high)
go fmt ./... && go vet ./... && codex review --uncommitted --config model=gpt-5.6-terra --config model_reasoning_effort=high

# Review mode varies by working directory state. The model/effort come from select-review-model.mjs:
codex review --uncommitted --config model=<model> --config model_reasoning_effort=<effort>   # normal uncommitted changes
codex review --commit HEAD --config model=<model> --config model_reasoning_effort=<effort>   # normal clean dir, last commit
codex review --base main   --config model=<model> --config model_reasoning_effort=<effort>   # normal branch review
```

## Execution Flow

1. **Lint First**: Execute static analysis tools to fix formatting issues first
2. **Codex Review**: Execute the primary model only after lint succeeds
3. **Fallback**: On an explicit model or reasoning-effort availability failure, retry only the review command with the next candidate; do not rerun lint

## Flag Discipline

Run the command exactly as given in the prompt. `codex review` accepts only `-c/--config`,
`--strict-config`, `--enable`, `--disable`, `--uncommitted`, `--base`, `--commit`, and `--title`.

Never add `--full-auto`, `-s`/`--sandbox`, `--dangerously-bypass-approvals-and-sandbox`, or
`--dangerously-bypass-hook-trust`. Those belong to `codex exec`; on `codex review` they fail with
`error: unexpected argument`, and adding one is an unrequested approval/sandbox bypass that a host
permission layer will deny.

If a flag is rejected, run `codex review -h` to see what this codex version accepts, drop the
unsupported flag, and retry. Do not swap in a different bypass flag.

## Output Format

Returns complete output directly, including:

- Lint tool fix results
- Code review summary
- List of issues found
- Improvement suggestions

## Important Notes

- Must be executed in git repository directory
- Ensure codex command is properly configured and logged in
- Timeout is controlled by the caller through the Task timeout parameter
- Commands are chained with `&&`, so lint failure will stop the subsequent codex review
- Do not fall back for review findings, lint failures, authentication or network failures, timeouts, or metadata warnings when the review starts successfully
