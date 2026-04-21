# BenedictKing Skills

[English](./README.md) | 简体中文

BenedictKing 发布的 Agent Skills 合集仓库。

## 包含的技能

- `context7-auto-research` — 通过 Context7 获取最新库/框架文档
- `exa-search` — 基于 Exa 的语义搜索、相似内容发现与结构化研究
- `firecrawl-scraper` — 基于 Firecrawl 的网页抓取、结构化提取、截图与 PDF 解析
- `tavily-web` — 基于 Tavily 的网页搜索、提取、爬取、站点映射与研究任务
- `codex-review` — 基于 Codex 的代码审核工作流

## 仓库结构

```text
.claude-plugin/plugin.json
skills/
  context7-auto-research/
  exa-search/
  firecrawl-scraper/
  tavily-web/
  codex-review/
```

每个技能都遵循标准 Agent Skills 结构：
- `SKILL.md`
- 可选 `scripts/`
- 可选 `references/`
- 可选 `.env.example`

## 安装

安装整个合集：

```bash
gh skill install BenedictKing/benedictking-skills
```

安装单个技能：

```bash
gh skill install BenedictKing/benedictking-skills exa-search
```

固定版本安装：

```bash
gh skill install BenedictKing/benedictking-skills exa-search --pin v1.0.0
```

## 验证

验证整个合集：

```bash
gh skill publish . --dry-run
```

验证单个脚本入口：

```bash
node skills/exa-search/scripts/exa-api.cjs --help
```

## 发布流程 Checklist

### 发布前

- [ ] 检查 `skills/<name>/SKILL.md` 的 `name` 与目录名一致
- [ ] 检查 frontmatter 包含 `name` 与 `description`
- [ ] 如有脚本，确认放在 `skills/<name>/scripts/`
- [ ] 如有参考文档，确认放在 `skills/<name>/references/`
- [ ] 运行 `gh skill publish . --dry-run`

### 正式发布

```bash
gh skill publish . --tag v1.0.0
```

### 发布后

- [ ] 打开 release 页面检查内容
- [ ] 抽查 `gh skill install` 安装命令
- [ ] 如有必要，更新 README 中的版本示例

## 许可证

MIT
