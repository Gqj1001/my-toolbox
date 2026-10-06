# scripts/ 目录说明

这些脚本用于从 `public/tools/feedback.html` **程序化生成/校验**数据库迁移文件，
避免手工转录 470 个关键词时出错，并在改造 HTML 后校验其内联脚本语法。

## push-via-api.mjs ⚠️（网络被挡时的推送手段）

**什么时候用**：本机对 `github.com:443` 会**反复被重置**（实测：`Connection was reset`，
或连续多次 `Failed to connect to github.com:443 after 21063 ms`），但 **`api.github.com` 一直通**。
这种情况下 `git push` 重试多少次都没用，用这个脚本走 GitHub REST API 把当前分支推上去。

```powershell
node scripts\push-via-api.mjs --dry                  # 先演练（只打印，不写 GitHub）
node scripts\push-via-api.mjs                        # 真推当前分支 → origin 同名分支
node scripts\push-via-api.mjs --branch <名字>        # 指定分支
```

**安全设计**（四道）：
1. token 从本机 git 凭据管理器现取现用，**不硬编码、不打印**；
2. 只做**快进推送**（远端必须是本地祖先），否则中止 —— 不会覆盖别人的提交；
3. **硬闸：构造出的 tree sha 必须与本地 tree sha 一致**，不一致立即中止
   （tree sha 覆盖全部文件内容与权限位，等于「推上去的与本地逐字节一致」）；
4. 推完**自动逐文件核对**远端与本地，报「多/少/不同」。

**已知副作用**：这样推上去的 **commit sha 与本地不同** —— GitHub 的 API 会重新生成
commit 对象，且会把 commit message 结尾的换行去掉、把提交时间写成 UTC。
文件内容不受影响（tree sha 不变）。详见脚本头部注释。

> ⚠️ 本机 **git 不在 PATH 上**，脚本会自己去找 git（`GIT_BIN` 环境变量可覆盖）。

## gen-step7-sql.mjs

生成 `supabase/migrations/0005_stage_subject_textbook.sql`（第 7 步：学段 × 科目 × 教材 × 章节）。

从 `feedback.html` 提取 `MATHEMATICS_BOOKS` / `CATS`，生成：
教材与章节种子、数学高中 6 册 94 章的章节关键词（188 条，课堂内容 + 下节课内容）、
以及需要归档（软删除）的重名词清单。

**改教材/章节清单时改这个脚本里的 `TB` 数组，然后重跑**：

```powershell
node scripts/gen-step7-sql.mjs
node scripts/validate-sql.mjs supabase/migrations/0005_stage_subject_textbook.sql
```

## gen-0006-textbook-version.mjs

生成 `supabase/migrations/0006_textbook_version.sql`（教材改为「版本 + 册次」两级）。

从数据库读出当前教材，按已知版本名拆成 `version`（人教A版/人教版/统编版…）与
`name`（必修第一册/必修一/七年级上册…；`-` 表示该版本无册次之分），
生成**按 id 逐条精确更新**的 SQL——不用字符串猜测，避免误改。

它还会校验拆分后 `(stage, subject, version, name)` 唯一性，有重复就拒绝生成。

```powershell
node scripts/gen-0006-textbook-version.mjs
node scripts/validate-sql.mjs supabase/migrations/0006_textbook_version.sql
```

## extract-keywords.mjs

从 `feedback.html` 中提取 `KW` / `OTHER` / `CATS` / `SUBJECTS` / `DEFAULT_PHRASES`
常量，生成带 `values (...)` 数据块的 SQL 文件。

```powershell
node scripts/extract-keywords.mjs
```

输出：`supabase/migrations/0005_feedback_seed.sql`（生成后把其中的 values 块
合并进 `0004_feedback_tables.sql`，或在 SQL Editor 里单独执行该文件）。

## validate-sql.mjs

校验 SQL 是否语法安全：单引号配对、括号平衡、数据行数、各科目分布。

```powershell
node scripts/validate-sql.mjs                                         # 默认校验 0004
node scripts/validate-sql.mjs supabase/migrations/0005_*.sql          # 指定文件
```

## validate-feedback-js.mjs

校验 `feedback.html` 的**内联脚本语法**（用 `new Function()` 解析，不执行），
并确认几处关键改造仍在位（`NEXT_MODE`、`bootFromApi`、云端只读分支、
第 7 步的 `STAGES` / `loadCloudScoped` / 学段与教材下拉等）。

改完 HTML 后务必跑一次——一个逗号错误就会让整个工具白屏。

```powershell
node scripts/validate-feedback-js.mjs
```

## patch-step7-scope.mjs

第 7 步改造 `feedback.html` 的一次性补丁（学段 → 科目 → 教材/章节）。
它的改动**已经应用**到 HTML 中；保留仅供追溯与重新应用。

脚本用「精确字符串匹配、命中必须唯一」的方式改文件，任何一处对不上就整体放弃写入，
改前会把原文件备份到 `.backup/feedback.html.pre-step7`。

## 何时需要重跑

| 场景 | 需要重跑 |
|---|---|
| 修改了 `feedback.html` 的内联脚本 | `validate-feedback-js.mjs` |
| 修改了 `feedback.html` 里的默认关键词库 | `extract-keywords.mjs` → `validate-sql.mjs` → 重新执行 0004 |
| 改教材/章节清单（第 7 步） | 改 `gen-step7-sql.mjs` 的 `TB` → 重跑它 → `validate-sql.mjs 0005_*.sql` → 执行 0005 |
| 日常增删关键词 / 教材 / 章节 | 都不需要，直接用 `/admin/feedback-keywords` 管理页 |
| `git push` 连不上 github.com | `push-via-api.mjs`（见本页开头） |

`0004_feedback_tables.sql` 与 `0005_stage_subject_textbook.sql` 都是幂等的，可安全重复执行。

> 注：改造 `feedback.html` 时使用的一次性补丁脚本（`patch-*.mjs`、`make-seed-only.mjs`）
> 已归档到 `.backup/scripts/`（该目录被 gitignore）。它们的改动已应用到 HTML 中，
> 保留仅供追溯。

---

# tests/ 目录说明

`tests/` 放端到端回归测试（裸 CDP 脚本，依赖 Edge + 生产构建）。

```powershell
node_modules\next\dist\bin\next build      # 测试跑在 next start 上
node tests\step7-api.test.mjs              # 数据层 / API 维度过滤（39 项）
node tests\step7-ui.test.mjs               # 管理页 + 工具页端到端（34 项）
node tests\problem2-stage.test.mjs         # 学段不串味（21 项）
node tests\problem1-textbook.test.mjs      # 教材版本/册次两级（需先执行 0006）
```

> ⚠️ 测试必须跑在**生产构建**（`next start`）上。dev 模式下 HMR WebSocket 会被拦截，
> 导致客户端 React 不挂载（`renderers.size === 0`），所有交互组件点不动——
> 那是环境问题，不是代码缺陷。

测试账号读自 `.test-users.json`（gitignored）。

