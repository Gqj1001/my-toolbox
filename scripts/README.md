# scripts/ 目录说明

这些脚本用于从 `public/tools/feedback.html` **程序化生成/校验**数据库迁移文件，
避免手工转录 470 个关键词时出错，并在改造 HTML 后校验其内联脚本语法。

## extract-keywords.mjs

从 `feedback.html` 中提取 `KW` / `OTHER` / `CATS` / `SUBJECTS` / `DEFAULT_PHRASES`
常量，生成带 `values (...)` 数据块的 SQL 文件。

```powershell
node scripts/extract-keywords.mjs
```

输出：`supabase/migrations/0005_feedback_seed.sql`（生成后把其中的 values 块
合并进 `0004_feedback_tables.sql`，或在 SQL Editor 里单独执行该文件）。

## validate-sql.mjs

校验生成的 SQL 是否语法安全：单引号配对、括号平衡、数据行数、各科目分布。
只需把目标 SQL 路径写在脚本顶部的 `SQL` 常量里。

```powershell
node scripts/validate-sql.mjs
```

## validate-feedback-js.mjs

校验 `feedback.html` 的**内联脚本语法**（用 `new Function()` 解析，不执行），
并确认几处关键改造仍在位（`NEXT_MODE`、`bootFromApi`、云端只读分支等）。

改完 HTML 后务必跑一次——一个逗号错误就会让整个工具白屏。

```powershell
node scripts/validate-feedback-js.mjs
```

## 何时需要重跑

| 场景 | 需要重跑 |
|---|---|
| 修改了 `feedback.html` 的内联脚本 | `validate-feedback-js.mjs` |
| 修改了 `feedback.html` 里的默认关键词库 | `extract-keywords.mjs` → `validate-sql.mjs` → 重新执行 0004 |
| 日常增删关键词 | 都不需要，直接用 `/admin/feedback-keywords` 管理页 |

`0004_feedback_tables.sql` 是幂等的（按 `subject + category + keyword` 去重），
可以安全地重复执行。

> 注：改造 `feedback.html` 时使用的一次性补丁脚本（`patch-*.mjs`、`make-seed-only.mjs`）
> 已归档到 `.backup/scripts/`（该目录被 gitignore）。它们的改动已应用到 HTML 中，
> 保留仅供追溯。
