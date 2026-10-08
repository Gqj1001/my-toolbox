# 下个会话待办

> 生成时间：2026-10（本轮收尾时）。
> 配套阅读：`docs/project-overview.md`（现状总入口）、`docs/dsh-work-guide.md`（配合方式）、
> `docs/perf-notes.md`（性能完整记录）。
>
> 每条都写了「为什么」和「怎么验」，**不要只照标题做**。

---

## 1. viewer.ts 改造（半天）—— 优先级最高

**为什么**：A-2（中间件刷新策略）**只完成了一半**。
「每次进网站都要登录」的根因是并发刷新被 Supabase 判成 token 泄露 → 撤销会话；
A-2 把**中间件**那半边的并发刷新压掉了，但**页面侧仍在各自刷新**。

**现状数字**（`tests/middleware-cache.test.mjs` 会打出来）：
- 伪造「剩 3 秒」的会话 + 并发 8 个请求 → `/auth/v1/token` **8–12 次**
- 修复前是 16 次；**目标 1–2 次**

**根因**：`src/lib/viewer.ts` 的 `loadViewer()`（约 96 行）**自己 new 一个 Supabase client**
调 `auth.getUser()`。它读的是**浏览器发来的原始 cookie**（不是中间件改过的那份），
所以 token 快过期时它也会各自去刷新 —— 8 个并发请求就再刷 8 次。

**证据**（本轮已验）：临时把页面侧改成直接打 `/auth/v1/user`（绕开 auth-js 的会话加载），
`/auth/v1/token` **归零**。

### 做法

1. 把 `src/proxy.ts` 里「够新就不刷」的判断抽成一个小模块，例如
   `src/lib/session-freshness.ts`：
   - `readSessionFromCookies(cookieStore)` → `{ accessToken, expiresAt, refreshToken }`
   - `isFresh(expiresAt, marginMs)` → boolean
   - `userFromJwt(accessToken)` → `{ id, email } | null`（**只解码，不验签**）
2. `loadViewer()` 改用它：**够新 → 不调 `getUser`**（cookie 里那份已经是被 Auth 服务
   校验过、且中间件也确认过的）；快过期才调 `getUser`。
3. 中间件侧保持现状（或也改用同一个模块，去掉重复代码）。
4. **不要**给抽出来的模块加 `import "server-only"` ——
   中间件可能跑在 Edge runtime（同类说明见 `src/lib/three-state-cache.ts` 的文件头）。

### 测试

扩 `tests/middleware-cache.test.mjs`：

- 现成 helper 直接用：`tests/_helpers.mjs` 的 `sessionCookieExpiringIn(session, sec, url)`
  （**只改 `expires_at`**，token 仍是真 token，所以刷新是真发生的、也真被计数）
- 新增断言：**并发 8 个「快过期」请求 → `/auth/v1/token` ≤ 2 次**（把现在那条 ≤13 收紧）
- 保留：够新 → 0 次；单请求快过期 → 1 次

### 顺带修的

`tests/middleware-cache.test.mjs` 里那条
`A-2 待办留痕：页面侧 getViewer() 仍会各自刷新` 是**临时的留痕断言**（恒为 true）。
这轮做完后应当**删掉它**，换成上面那条真断言。

---

## 2. vision-scores 启用态测试（半天）

**为什么**：答题卡识别的**路由与前端都完整**（我逐项查过，见下），
但**「启用之后」那条路径从来没有被执行过** —— 现有测试只覆盖两条降级路径。
**你配好 `AI_VISION_MODEL` 打开开关那一刻，是这条路径第一次真正跑起来。**

### 已经查过、**不需要改**的部分

| 项 | 结论 |
|---|---|
| `src/app/api/paper-analysis/vision-scores/route.ts` | 235 行，完整 |
| 入参 / 出参 | `{image:"data:image/...", questions:[...], model?}` → `{ok:true, scores:[{no,got}]}` |
| thinking 护栏 | ✅ **只有模型名含 `deepseek` 才带** `thinking:{type:"disabled"}`；另有 `AI_VISION_SUPPORTS_THINKING=0` 紧急开关 |
| 错误处理 | 401 / 403(非会员) / 403(封禁) / 503(未配模型，给明确提示) / 413 / 400 / 502 / 超时；思考吃光预算会重试一次 |
| 图片位置 | ✅ 只放 **user** 消息（官方要求：放 system/assistant 会 400）—— 我核对过官方文档 |
| 前端 `photoRun()` | ✅ `public/tools/paper-analysis/js/app.js` 约 860 行；按钮 `index.html:129`；API 路径正确 |
| `mode` 路由暴露 `visionModel` | ✅ `src/app/api/paper-analysis/mode/route.ts:41`（**这是启用的关键依赖，通的**） |

### 要补的测试

起一个**桩上游**（本地小 HTTP server 冒充 `{baseUrl}/chat/completions`），
用 `AI_VISION_BASE_URL` 指向它（**这个环境变量已存在，不需要改产品代码**）。断言：

1. 请求体里 `content` 是**数组**、`image_url` 块在 **user** 消息里（system 只有文本）；
2. 模型名含 `deepseek` → 请求体**带** `thinking`；
   模型名不含 deepseek（如 `glm-4v-flash`）→ **不带** `thinking`
   （防止将来有人改成无条件带，那会直接 400）；
3. 桩返回 `{"scores":[{"no":1,"got":5}]}` → 响应 `ok:true` 且 `scores` 正确；
4. 桩返回**非 JSON** → `ok:true` 但 `scores:[]` 且带 `raw`（**不 500**）；
5. 未配 `AI_VISION_MODEL` → 仍返回 503（现有断言，保留）。

> ⚠️ 提醒用户：识别结果**必须人工核对**；模型会把看不清的题**直接省略**
> （prompt 明确要求「看不清不要猜」），所以「识别出 15 道题」≠「其余 5 道是 0 分」。

---

## 3. 阶段 3：paper-analysis 接入统一学生 API（1 天）

**背景**：`0014` 迁移已执行、`/api/students` 已上线（阶段 2 第 3 步完成）。
现在要把 paper-analysis 从 localStorage 搬上来。

### 现状（诊断已完成）

- `public/tools/paper-analysis/js/app.js`：
  - `K_STU = 'paper_analysis_students_v1'`、`K_HIST = 'paper_analysis_history_v1'`
  - 档案：`{gender, grade, subject, teacher, manager, cls, attitude, updated}`
  - 历史：`{text, date, examName, score, full, saved}`（**带分数**，feedback 的历史没有）
- **math-plan 没有任何存储**（刷新即丢），它的情况见第 4 条。

### 要做

1. 学生 CRUD 走 `/api/students`（**用合并语义的 upsert**，POST 只发变化的字段）。
2. 历史走 `/api/students` 的 `op:"import"`（幂等：重复跑 `inserted:0/skipped:N`）。
3. **首次迁移必须弹窗确认，不静默上传**（真实学生姓名，用户要知道自己在做什么）。
   给三个选项：上传 / 暂不 / 以后再说；上传后**保留** localStorage 作后悔药。
4. ⚠️ **`date` 归一化（必须先做，否则日期静默变空）**：
   paper 的 `examDate` 默认填 **「2026年10月7日」**，而
   `src/lib/date-input.ts` 的 `parseDisplayDate()` **解析不了带「年」的格式**（正则里没有）→ 返回 `null`。
   已在 `tests/date-input.test.mjs` 与 `students-unified.test.mjs` 留痕（`dateUnparsed` 会数出来）。
   **三个选择（需用户拍板）**：
   - (a) 扩展解析器支持「年月日」← **推荐**
   - (b) 迁移前在前端归一化成「10月7日」
   - (c) 两者都做 ← 也推荐
   ⚠️ (a) 是**行为变更**，会让 `tests/date-input.test.mjs` 里那份「老实现逐字副本」
   明确变红 —— **那正是它存在的意义**（提醒你这次是故意改行为），
   改的时候要同步更新那个文件并说明原因。
5. **边界**：本轮只改 `public/tools/paper-analysis/js/app.js` 的**数据读写部分**，
   不动 UI 结构、样式、业务逻辑（用户明确约束）。

### 测试

新增 `tests/paper-analysis-students.test.mjs`：档案往返、历史导入幂等、
跨账号隔离、**日期解析失败的条数被如实报告**。

---

## 4. 阶段 4：math-plan 接入统一学生 API（半天，纯新增）

**注意**：**math-plan 没有 localStorage 要迁** —— 它现在什么都不存（刷新即丢）。
所以这是**纯新功能**，没有历史数据、没有新旧冲突，比阶段 3 简单。

### 要做

1. 「**选学生带出信息**」：从 `/api/students` 拉档案列表，选一个自动填
   `f-name / f-grade / f-teach / f-campus` 等。
2. 「**保存档案到服务器**」：把「学生是谁」的那几个字段存进 `/api/students`。
   - ⚠️ 只存**学生身份字段**（name/grade/campus/teacher + `extra` 里的
     `phase/book/exam`）；**不要**把「这一次方案的参数」（分数、目标分、课时、
     薄弱模块、已完成模块）塞进档案 —— 那些属于「方案」不属于「学生」。
   - 工具专属字段进 `extra`（0014 的设计），**不要改表结构**。
3. 边界同上：只改数据读写，不动 UI 结构。

### 测试

扩 `tests/students-unified.test.mjs` 的合并语义组，补一条
「math-plan 写进 `extra` 的字段，被 feedback 保存一次后仍在」（那条已经有类似的，扩一下即可）。

---

## 5. 待办清单里还没做的（原清单的其余项）

按用户自己的《my-toolbox 项目待办清单》，以下仍未做：

| # | 项 | 备注 |
|---|---|---|
| 1 | **`/tools` 改个人中心 + `/dashboard` 改 redirect** | 两页 99% 重复（都渲染同一个 tool-grid）。半天 |
| 4 | **全学科扩展** | 依赖：每科要 10–15 份学科网报告。推荐从**物理**试水。触发条件：有物理老师主动要，或数学用稳 2–3 周 |
| 7 | 空壳工具清理 | `json-formatter` / `password-generator` 已下线（`0012`），但代码文件还在 `public/tools/` 里。触发条件：确认不再需要 |
| 8 | few-shot 效果评估 | 触发条件：累计用 AI 润色 20–30 次后 |
| 9 | 深度优化 AI 润色（调温度/prompt） | 可选 |
| 11 | feedback 离线模式入口 | 可选（现在云端拉不到就是空页面，是**有意**的） |
| 12 | `DEFAULT_MODEL = "deepseek-chat"` 改 `deepseek-flash` | 已用 Vercel 的 `AI_MODEL` 覆盖，属技术债清理 |

**长期（现在不做）**：自动支付、会员使用统计、全站数据导出、多老师团队模式、更换服务器架构（国内备案）。

---

## 6. 已知问题（记录，修不修都行）

1. **非法 ISO 日期会被原样写库 → 500**（`2026-13-45` 这种）。
   详见 `docs/perf-notes.md`「七、已知问题」。本轮**按用户要求未修**。
   修的时候 `tests/date-input.test.mjs` 的老实现副本会红 —— 那是预期的。
2. **`tools` 表的建表语句不在仓库里**（只有种子数据），
   会员那三列（`plan`/`status`/`expires_at`）的加列语句也不在。
   **不要试图用仓库的 SQL 重建数据库。**
3. **换工具权限 / 下线工具没有后台界面** —— 只能去 Supabase SQL Editor 手工跑
   （照 `0012` 的写法）。改完最多 30 秒全站生效（`tools` 表有 30 秒进程内缓存）。
4. **`tests/feedback-data-cache.test.mjs` 与 `tests/math-plan-ai-vip-path.test.mjs`
   会杀 3000 端口**，别和其它真服务套件并行跑。
5. **`tests/step7-ui.test.mjs` 隔离弱点**：按关键词查全表，会被上次运行遗留数据污染。

---

## 7. 环境备忘（新会话不用再问用户）

| 项 | 值 |
|---|---|
| 仓库 | `D:\my-website\my-toolbox`（注意：工作目录可能是 `D:\my-website`，**仓库在子目录里**） |
| git | `D:\my-website\.tools\git\cmd\git.exe`（**不在 PATH**） |
| 线上 | `https://010034.xyz` |
| 测试账号 | `roleb`=VIP（`userEmail`）、`rolea`=免费/管理员（`adminEmail`） |
| 跑测试 | `C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe tests\<套件>`；**先 `next build`** |
| 推送 | 先 `git push origin main`；若 `github.com:443` 不通，用 `node scripts\push-via-api.mjs` |
| 三份交接文档 | `docs/project-overview.md`、`docs/dsh-work-guide.md`、`docs/perf-notes.md` |
| 本文件 | `docs/next-session-todo.md` |

**全套回归现状（21 个套件全绿）**：

```
math-plan-template 82/82   math-plan-lessons 44/44   ai-thinking-mode 11/11
math-plan-ai-apply 20/20   middleware-cache 13/13    verify-checklist 18/18
step7-api 39/39            step7-ui 36/36            paper-analysis 56/56
paper-regression 18/18     paper-score-edit 59/59    paper-score-report 15/15
feedback-data-cache 26/26  feedback-client-cache 51/51
students-unified 54/54     date-input 9/9            admin-grant90 18/18
math-plan-ai-sections 26/26  math-plan-ai-vip-path 17/17
math-plan-export-ui 18/18  paper-score-ui 35/35
```
