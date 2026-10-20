# 试卷分析工作台接入 · 交接报告

> 本报告只讲**现在在哪、下一步做什么、有什么坑**。
> 不做从 0 到 1 的历史复述 —— 完整演变见 `git log --oneline`。

---

## 项目速览

my-toolbox 网站已上线，此前已接入**课后反馈工作台**、完成**第 7 步 AI 关键词导入**
（959 章 / 4179 知识点 / 8358 关键词），本次接入**试卷分析工作台**。

完整历史：`git log --oneline`

---

## 本次任务（试卷分析接入）做了什么

**工具本体**（不在本次新建，已存在）
`public/tools/paper-analysis/` —— 多文件结构：`index.html` + `css/` + `js/`（10 个）+ `templates/`

**接入方式**
1. **iframe 包装页** `src/app/tools/paper-analysis/page.tsx` → 复用 `ToolPageShell`（`min_plan = free`）
2. **API Route 4 个** `src/app/api/paper-analysis/{mode,parse-file,ai-advice,vision-scores}/route.ts`
3. **tools 表注册** `supabase/migrations/0010_seed_paper_analysis_tool.sql`
   （`sort_order = 6`、`active = true`、`min_plan = free`；dashboard 读表自动出卡片）

**为支持目录型工具扩展的共享函数**
`src/lib/tools-db.ts` 的 `resolveIframeSrc()`：原来只认 `public/tools/<slug>.html`，
现支持两种布局 —— ① 单文件 `<slug>.html`（feedback 等）② 目录 `<slug>/index.html`（本工具）。

**运行模式自动切换**（`public/tools/paper-analysis/js/app.js` 新增 `NEXT_HOST` / `API_BASE`）
挂在 `/tools/paper-analysis` 下走云端接口；`file://` 双击打开仍走本机逻辑；
放在自建 `server.js` 上走老的相对路径接口。11 处接口地址随之改为 `API_BASE` 前缀。

**修了 3 个 bug**

| # | 问题 | 根因 | 处理 |
|---|---|---|---|
| A | `renderScoreTable is not defined` | `adoptPaperText()` 调用了一个不存在的函数名（实际叫 `renderScoreAssignTable`），抛 `ReferenceError` 当场中断函数 | 删除该重复调用（上方 `computeScores()` 已渲染过） |
| B | `diffMapping` 空壳字段 | 全库只有 HTML 一处声明，无任何读写 | 删除该 `div.f` 与 label |
| C | 「解析结果」面板不显示题目清单 | **与 A 是同一个 bug** —— `renderQuestionList()` 排在崩溃点之后，永远执行不到；面板可见性设置了但内容为空 | A 修好后自动恢复 |
| — | 分值表事件处理器内重渲染 | `renderScoreAssignTable()` 的事件处理器里又调用了「重渲染整张表」，会在自身处理器内叠加 change 监听器 | 删除该调用，保留 `#sumCell` 直接更新总分 |

**legacy 脚本处理**
`tests/problem1-textbook.test.mjs`、`tests/problem2-stage.test.mjs` 记录的是
**第 7 步 AI 导入之前**的数据规模（教材 41 / 章节 272 / 关键词 658），导入后已是 219 / 4273 / 9016，
断言本身过期。已从仓库移除，本地保留为 `*.legacy.mjs` 并由 `.gitignore` 忽略。
**不要再修这两个文件。**

---

## 当前状态

| 项目 | 状态 |
|---|---|
| 最新 commit | `bc718e9f89a1d6047fa93c044d4a1bf3bf1b8767` —「试卷分析工作台：解答题分值逐题可编辑」 |
| 上一提交 | `9992a5d`（`fe1a6fa` / `d6a6b3a` / `9992a5d` 在推送前就已在远端，随本次一并包含在历史里） |
| 是否已 push | ✅ 已推送。远端 `main` = `bc718e9f`，与本地 HEAD **SHA 完全相同**（非仅内容一致） |
| 远端文件数 | 130（推送前 127，+3 = 本次新增的 3 个验证脚本） |
| Vercel 部署 | ❓ **未在本机 link**（无 `.vercel` 目录），我也没有执行任何部署。线上是否已自动构建需你确认 |
| 本地 dev 服务器 | 当前**未运行**。需手动启动：`pnpm dev` → http://localhost:3000 |
| 工作区 | 干净 |
| 测试 | `next build` ✅ · `tests/paper-analysis.test.mjs` **56/56** ✅ · `tests/paper-regression.test.mjs` **17/17** ✅ · `tests/paper-score-edit.test.mjs` **59/59** ✅ · `tests/paper-score-ui.test.mjs` **35/35** ✅ · `tests/paper-score-report.test.mjs` **15/15** ✅ |

**推送时的 SHA 对齐有个坑，记录在此**：我的推送脚本读 commit message 时用了 `.trim()`，
去掉了结尾换行符，导致远端对象与本地对象字节不同 → SHA 不同（内容/tree 一致）。
最后用穷举（时区 × 结尾换行 × ±1 秒）解出参数精确复刻，本地 ref 才指到远端 SHA。
**以后改推送脚本不要 trim message。**

---

## 第二批：解答题分值逐题可编辑（已完成）

**要解决的问题**：原来解答题按题型平均分配（77 ÷ 5 = 15.4），真实考卷每题分值不同（如 13/15/15/17/17），程序不该替老师平均。

**改了什么**（只动 2 个文件：`js/app.js` +228/-29、`css/app.css` +46；`index.html` 未改）

| # | 改动 |
|---|---|
| 1 | 分值分配表改「主行 + 可折叠子行」：主行显示题型/题量/`平均 X`，点 `▶` 展开该题型逐题分值输入框（`colspan=4` 子行内 flex 排）；默认全部收起 |
| 2 | **拆掉核心 bug**：删除 `info.spread = Array.from(...)` 那句「改一下就压回平均」的覆写。改完后 `spread` 是唯一权威数据源，`info.total = sum(spread)`、`info.per` 降级为派生值（仅作收起态展示与兜底） |
| 3 | 新增区间批量设置：「第[起]到[止]题，每题[V]分 + 应用」，按**题号**换算成该题型内的 `spread` 下标，只影响该题型 |
| 4 | **事件委托**（第一批踩坑的根治）：`#scoreTable` 上在 `init()` 里只挂一次 `click` + 一次 `change`，靠 `data-*` 分派。改一道题只重建该题型的子行（`syncTypeAfterEdit`），**整表不再重建**，从结构上消灭「在事件处理器里重渲染整表 → change 监听器自我叠加」 |
| 5 | 分值合理性提示：`computeScores()` 里抓 `baselineTotals` 快照，某题型总分与卷面预设不一致时在 `#scoreSumHint` 给温和提示（只提示不阻止，改回一致即消失） |
| 6 | 新增 `ensureSpread()`：`assignScores` 在**非预设分支**不给客观题生成 `spread`（`paper-parser.js:389-394`），渲染前统一补齐，让逐题编辑对客观题也有落点；`seedRecords()` 的下标读取加越界兜底 |

**未改**：`assignScores()` 的生成逻辑、`seedRecords()` 的缩放逻辑（`got/full` 比例缩放 + clamp 保留原样）。

**验证**（3 个新脚本，共 109 项全绿）
- `paper-score-edit.test.mjs` 59/59 —— 纯逻辑：分配/改分/批量/缩放 + 结构校验（含「`info.spread =` 全文件只允许出现 1 次」这类防回退断言）
- `paper-score-ui.test.mjs` 35/35 —— 无头 Edge 真点：折叠/展开/改分/批量/提示消失/页面 0 异常
- `paper-score-report.test.mjs` 15/15 —— **把生成的 docx 拆开抽回正文断言**：第 15 题 `13 | 7`、第 19 题 `17 | 12`、解答题总分 77、全文无 `15.4`（证明逐题分值真的进了 Word）
- 原有 `56/56` + `17/17` 改后复跑仍全绿

**验收缺口**：真实报告 docx 未入库，`模板-占位符.docx` 那条链路已覆盖。**待你在线上用真实月考报告实测**（重点看：① 是否命中卷面预设 ② 展开后题号是否与细目表一致）。

---

## 关键文件清单

```
src/app/tools/paper-analysis/page.tsx                 包装页（iframe）
src/app/api/paper-analysis/mode/route.ts              模式探测
src/app/api/paper-analysis/parse-file/route.ts        文件解析（docx/pdf/doc/图片）
src/app/api/paper-analysis/ai-advice/route.ts         AI 建议段（VIP 专属）
src/app/api/paper-analysis/vision-scores/route.ts     答题卡识别（当前未启用）
src/lib/paper-extract.ts                              docx/doc/pdf 文本提取（零依赖）
src/lib/tools-db.ts                                   resolveIframeSrc 支持目录型工具
src/components/tool-page-shell.tsx                    工具页公共外壳（未改，复用）
public/tools/paper-analysis/index.html                工具本体页面
public/tools/paper-analysis/js/app.js                 工具主逻辑（含 NEXT_HOST/API_BASE）
public/tools/paper-analysis/js/core/paper-parser.js    试卷解析（核心；老/新工具共用）
public/tools/paper-analysis/js/core/error-engine.js    归因引擎（核心）
public/tools/paper-analysis/js/core/knowledge-classifier.js  数学考点归类（核心，老工具默认）
public/tools/paper-analysis/js/core/kp-dict.js         数学知识点词典（核心）
public/tools/paper-analysis/js/core/narrator.js        报告叙事（核心）
public/tools/paper-analysis/js/core/subject-engine.js  全学科通用解析/算分/归类（v2 用）
public/tools/paper-analysis-v2/index.html              全学科版界面壳（v2）
public/tools/paper-analysis-v2/js/app.js               v2 主逻辑（调用 core + 科目包）
public/tools/paper-analysis-v2/subjects/*.js           8 份科目包（数/理/英/语 × 初高中）
src/app/api/paper-analysis-v2/ai/route.ts              v2 AI（题干摘要/附件1归因，VIP）
src/app/tools/paper-analysis-v2/page.tsx               v2 包装页
public/tools/paper-analysis/js/report-template.js      模板化 Word 导出
public/tools/paper-analysis/js/template-data.js        模板 base64 内嵌（binary）
public/tools/paper-analysis/js/report-docx.js          Word 导出兜底渲染器
public/tools/paper-analysis/templates/模板-占位符.docx  老师的 Word 模板
public/tools/paper-analysis/templates/build-template.py 模板拆包/内嵌脚本
supabase/migrations/0010_seed_paper_analysis_tool.sql  tools 表注册（幂等）
scripts/patch-paper-next.mjs                           接入补丁（幂等，可重放）
tests/paper-analysis.test.mjs                          功能测试 56 项
tests/paper-regression.test.mjs                        回归测试 17 项
tests/paper-score-edit.test.mjs                        第二批·纯逻辑 59 项
tests/paper-score-ui.test.mjs                          第二批·浏览器端到端 35 项
tests/paper-score-report.test.mjs                      第二批·Word 报告链路 15 项
.backup/paper-analysis/app.js.orig                     改造前原版（不进仓库）
```

---

## 关键约束（新 DSH 必须知道的）

- **前端保留「本机模式」**：`file://` 直接打开时仍走 `localStorage` + 用户自己填的 Key（BYOK），
  不能破坏。判定靠 `NEXT_HOST`（协议 + `/tools/paper-analysis` 路径前缀）。
- **数据已迁到 Supabase（2026-10 阶段3 起）**：云端模式下档案/历史走 `/api/students`
  （合并语义 upsert、导入幂等），**不再只存 localStorage**；本机模式仍然走 localStorage。
  ⚠️ 首次进入会弹窗问用户要不要把本机旧数据传上去（**绝不静默上传**），
  上传后**保留** localStorage 作后悔药。详见 `src/lib/session-freshness.ts` 上方那段注释之外，
  本文件末尾「阶段3」小节。
- **AI 建议段是 VIP 专属**：服务端 `requireVip()` 校验，401 未登录 / 403 非会员或封禁 /
  503 未配 Key / 502 上游失败。`AI_KEY` 只从 `process.env` 读，**绝不下发前端**，
  上游错误原文也不透传。
- ✅ **视觉识别（答题卡识别）线上已启用**（2026-10 实查线上 `/api/paper-analysis/mode`：
  `config.visionModel = "deepseek-flash"`、`hasKey: true`）。DeepSeek 的 `deepseek-flash`
  **支持图片输入**，所以不需要第三方多模态模型；配好 `AI_VISION_MODEL`（+ `AI_KEY`）即自动可用，
  **不需要改代码**。
  > ⚠️ 本文档旧版写「视觉识别未启用（deepseek-chat 不支持图片）」——**那句已过期**：
  > ① `deepseek-chat` 确实不支持图片，但线上用的是 `deepseek-flash`（官方文档明确支持）；
  > ② 用户已实机自测「符合预期」，并在 Vercel 配好了 `AI_VISION_MODEL`。
  > 防回归测试见 `tests/vision-scores.test.mjs`（本地桩上游 + 分两阶段起服务，
  > 专门钉「模型名不含 deepseek 就不能带 thinking」这条护栏）。
  > ⚠️ 提醒：识别结果**必须人工核对**；模型看不清的题会**直接省略**，
  > 所以「识别出 15 道题」≠「其余 5 道是 0 分」。
- **legacy 脚本已忽略，不要再修**：`tests/*.legacy.mjs` 断言基于过期数据。
- **不要碰 feedback 的任何文件**（`public/tools/feedback.html`、`src/app/admin/feedback-*` 等）。
- **不要动 membership 系统**（`src/lib/membership*`、`user_roles`、升级/封禁逻辑）。
- 工具本体是 `public/` 下的静态资源，**改动后不需要重新构建页面**，刷新即可。
- **分值表的两条铁律**（第二批立下，别破坏）：① `scoreAssign.perType[t].spread` 是逐题分值的**唯一权威源**，
  不要再写任何「整体覆写 spread」的代码（全文件只允许 `ensureSpread()` 一处）；
  ② 事件一律走 `#scoreTable` 上的**委托**（`init()` 里只挂一次），**不要**在事件处理器里调用
  `renderScoreAssignTable()` 重渲染整表 —— 那正是第一批「change 监听器自我叠加」的成因。
  > ⚠️ 2026-10 补充：`ensureSpread()` 现在只是**幂等兜底** —— `assignScores()` 在所有分支
  > （含"常见单题分值估算"）都会自己给全 `spread` 了。以前那条分支不给，是真 bug。
- `.backup/`、`templates/parts/`、`*.legacy.mjs` 均已 gitignore，**不要提交**。

---

## 阶段3 + 卷面结构（2026-10）

### 1. 数据接入统一学生 API（阶段3）

- 新增 `CLOUD_STORE`（`loadAll / saveStudent / deleteStudent / deleteHistory / importHistory`），
  只在**云端模式**（`NEXT_HOST`）启用。
- 四种写入集中到 `persistStudent / removeStudent / persistHistory / removeHistory`
  四个入口；**调用点不要自己 fetch**（避免"同一件事两个来源"）。
- 字段映射：本工具的 `cls` ↔ 表的 `class_name`，并同时写进 `extra.cls`；
  历史 `tool='paper'` / `title=examName` / `score` / `full_score=full`。
  > ⚠️ **2026-10 第二批（重要）**：这里的 `saveStudent()` **只发 `extra:{cls}`、不读旧值** ——
  > 在「服务端按键合并」之前，这会**抹掉别的工具存在同一行的 `extra` 键**
  > （典型：math-plan 的 `phase/book/exam`）。**现在服务端已经按键合并**，所以它这样写是安全的、
  > **不需要**改成本地先读旧值。别再"顺手"给它加读旧值的逻辑（那会变成两个来源）。
- 接口补齐：`DELETE /api/students?id=<historyId>`（原来只有 `/api/feedback/data` 支持删单条）。
- 日期：`src/lib/date-input.ts` 的 `parseDisplayDate()` 新增「年月日」分支
  （`2026年10月7日` → `2026-10-07`，用它自己的年份）。这是**有意改行为**，
  `tests/date-input.test.mjs` 里那份老实现副本保持原样，另有一组「有意分歧」断言。
- 测试：`tests/paper-analysis-students.test.mjs`（27 项）。

### 2. 导入后停在试卷页（不再自动跳去录入成绩）

`adoptPaperText()` 末尾原来是硬编码的 `switchStep('cScore')`，导入完就把人踢到录入页；
而「卷面总分 / 卷面结构下拉 / 分值分配表」**全在试卷页上**，老师必须再点回来才能改分值。
现在停在试卷页 + 一句提示。测试：`paper-score-ui` 加了可见性护栏
（以前它是**空过**的：面板藏着，尺寸断言必然通过）。

### 3. 错因列 AI 润色（★ 2026-10 第五批）

**为什么做**：报告里【错题分析】表的最后一列「失分情况及原因分析」是程序按规则生成的
**原始诊断口气**（`error-engine.js` 的措辞 + `narrator.js` 的 `WEAK_PHRASE`），
会冒出「知识体系尚未建立」「能力严重不足」这类**重话** —— 这份表是给**家长**看的。
用户 2026-10 的要求：**不只是改通顺，还要把口吻改对**（面向家长、措辞温和、**不下定论**）。

**接口**：复用 `POST /api/paper-analysis/ai-advice`，加 `section:"attribution"`：

```
请求 { section:"attribution", paragraphs: string[], context?: { subject, examName } }
响应 { ok:true, section:"attribution", lines: string[] }   // lines.length 必须 === paragraphs.length
```

- **不新开路由**：VIP 校验、thinking 护栏、错误口径、日志只有一份实现。
- **老路径（建议段）一字未改**：不带 `section` 的请求仍返回 `{ok:true, text}`。
- **段数是硬契约**：返回段数与输入不一致 → **502 拒绝**（否则前端会把文案贴到错误的题上）。
- 提示词 `ATTRIBUTION_PROMPT` 里有**禁止清单**（点名"能力严重缺失/知识体系尚未建立/态度有问题"这类
  贴标签说法），并要求保留全部事实、不写分数与题号、每段 40–90 字。
- temperature **0.3**、max_tokens **4000**（同义改写，要稳不要发挥）。
- 上限 **60 段**（与前端 `wrongItems.slice(0, 60)` 对齐），超了 413 而不是静默截断。

**工具侧**（`public/tools/paper-analysis/`）：

| 位置 | 说明 |
|---|---|
| `index.html` | 「🧠 AI 润色（建议段 / 错因列）」面板里新增 `#btnAIPolishAttr` |
| `app.js` `pickAttrReasons()` | 只在**【错题分析】段内、表头之后**找行；按 ` \| ` 切开，取第 7 列作原因；**写「无」的（全对）跳过** |
| `app.js` `aiPolishAttribution()` | 逐行替换：**前 6 列原样拼回、只换最后一格**；段数不符/任何异常 → 只 toast，**报告保持原样** |
| `app.js` `LOCAL_ATTR_SYS` | 本机模式（BYOK）用的同一口径提示词，⚠️ **必须与服务端的 `ATTRIBUTION_PROMPT` 保持同口径**（改一处就要改另一处） |
| `app.js` `callAI(userContent, opts)` | 新增可选 `{system, temperature, maxTokens}`，**默认值 = 老行为**（建议段那条调用一字未变） |

**防护**：`tests/paper-attribution-polish.test.mjs`（23 项，桩上游 4589 + 真浏览器 9491）：
段数契约、提示词口径、非会员 403 **且不白花一次上游调用**、上游 5xx 不透传、
**老路径回归**、以及**真点击后逐字比对前 6 列未变 + 写「无」的行没被动 + 结构异常时原文一字不改**。
已用**变异测试**自证（把"只换最后一列"改成少拼一列 → 22/23，红的那条直接显示知识点列被吞）。

### 4. 选卷面结构 → 逐题分值自动分好 ⭐

`PaperParser.TYPE_PRESETS` 现在带**逐题常用值**（顶层 `per`，按题型给数组）：

| 卷面结构 | 解答题逐题常用值 | 合计 |
|---|---|---|
| 北京卷 / 北京卷（19题） | `13,15,15,15,14,13` | 85 |
| 新高考 I/II 卷 | `13,15,15,17,17` | 77 |
| 全国甲/乙卷 | `10,12,12,12,12,12` | 70 |
| 天津卷 | `14,15,15,15,16` | 75 |
| 上海卷 | `14,14,15,15,15` | 73 |

**两条行为规则（别改回去）**：
1. **题量与预设不等也照样按预设铺**（多出来的用该题型平均分补齐），
   并提示「题量与预设不同，请核对下方逐题分值」。
   老实现要求题型+题量**完全相等**，否则把整个预设丢掉、退回估算 ——
   实测就是"老师选了下拉，分值一点没变"。
2. 卷面总分不是 150 时才按比例缩放；**块总分与预设一致时就用预设写明的值**，
   不要用"逐题之和"（`14.17 × 6 = 85.02 ≠ 85` 这种浮点尾差会触发无谓的全卷缩放，
   把干净的分值改写成 3.99）。

> ⚠️ **一个很容易写错的坑（本轮踩过）**：`per` 必须挂在预设对象的**顶层**，
> **不能**写进 `dist` 里面。写进去 `preset.per` 永远是 `undefined`，
> 逐题常用值**静默失效且不报错**，看起来完全正常。
> `tests/paper-preset.test.mjs` 第 0 组专门钉住这一点。

**测试**：`tests/paper-preset.test.mjs`（18 项，纯函数、不需要服务器/数据库）。

### 5. 图片 / 截图识别（★ 2026-10 第六批）

**干什么**：老师手上常常只有**截图或拍照**（学科网报告的截图、扫描件），而本地解析只能处理
docx / doc / 有文字层的 PDF。这一批补上那半边：把图交给视觉模型**逐字抄录**，
拿回文本后**先给老师核对（可编辑）**，再一键填进导入框走原有解析流程。

**路由**：`POST /api/paper-analysis/vision-paper`（新增）

```
请求 { image: "data:image/..." }
响应 { ok:true, text, chars, empty, uncertain, retried }
```

| 项 | 说明 |
|---|---|
| **鉴权** | ⚠️ **只校验「登录 + 未封禁」——本功能是免费的**（用户 2026-10 明确定）。**不要**改成 `requireVip()`；它是全站**唯一**免费的 AI 功能 |
| 模型 | `AI_VISION_MODEL`（线上 = `deepseek-flash`）；base 走 `AI_VISION_BASE_URL ?? AI_BASE_URL`；未配 → **503** + 明确提示 |
| 提示词 | 逐字抄录、保留结构与表格（`A \| B \| C`）、**翻译/总结/改写/补全一律禁止**、看不清写成 **`[看不清]`**、手写批注用方括号标出 |
| 出参语义 | `empty`：一个字都没认出来（**仍是 200**，图不行 ≠ 系统坏了）；`uncertain`：文本里含 `[看不清]` |
| 护栏 | 图片只放 **user** 消息；只有模型名含 `deepseek` 才带 `thinking`（+ `AI_VISION_SUPPORTS_THINKING=0` 紧急开关）；上游错误不透传；请求体 ≤ 4MB |
| 与答题卡识别的区别 | `vision-scores` 要的是**每题得分数字**（JSON），这条要的是**全部文字**（纯文本）。两者共用视觉模型配置与护栏，**提示词与出参完全不同，别合并** |

**工具侧**（`public/tools/paper-analysis/`）：

| 位置 | 说明 |
|---|---|
| `index.html` | 新增按钮 `#btnVision`（📷 上传图片 / 截图识别）+ 多选 `#visionInput` + 预览容器 `#visionPreview` |
| `app.js` `compressImageFile()` | 长边压到 **1600**、JPEG **0.82**（>2.6MB 再降到 0.6）；解不开就原样发，交给服务端判断 |
| `app.js` `visionRun(files)` | **一页一张、逐张识别**；识别中显示「第 i/N 张」；本机模式明确提示要用服务器 |
| `app.js` `renderVisionPreview()` | 预览面板：每张一个**可编辑文本域** + 状态（⚠️ 含 `[看不清]` / ⚠️ 没认出文字）+ 「✅ 确认填进导入框 / 取消」 |
| `app.js` `adoptVisionText()` | 取**老师改过**的文本合并（多张之间插 `--- 第 N 张 ---`）→ `adoptPaperText()`；**解析失败不丢文本**（把识别原文摊开给老师复制） |
| `parse-file` 的 image 分支 | 以前回「当前云端版未启用视觉模型」（**已过期**），现在改成指引用「上传图片 / 截图识别」按钮 |

**★ 扫描版 PDF 也支持了（同一批的后续）**：`parse-file` 抽不到文字（或不足 120 字）时，
前端**在浏览器里用 pdf.js 逐页渲成图**，再走上面这条**同一条**识别管线
（`runVisionSources()`）—— 不再让老师自己截图。

| 项 | 说明 |
|---|---|
| 库 | **`pdfjs-dist@3.11.174`** 的 UMD 构建，放在 `public/tools/paper-analysis/vendor/`：`pdf.min.js`（320KB）+ `pdf.worker.min.js`（1.09MB），Apache-2.0。⚠️ **不放 CDN**：本工具坚持"双击 HTML 就能离线用" |
| 升级 | 整包替换那两个文件即可（`pdfjs-dist/build/pdf.min.js` 与 `build/pdf.worker.min.js`）；`app.js` 里只有两个常量指向它们 |
| 加载 | **懒加载**：只有真的要渲染 PDF 时才注入 `<script>`（320KB 不影响平时打开速度）；路径用**相对**的，服务器与本机 `file://` 都能用 |
| 渲染 | 每页按「长边约 1600」的缩放画到 canvas → JPEG 0.82 → 与图片识别完全同一条路 |
| 上限 | 一次最多 **10 页**（`PDF_MAX_PAGES`）；超了**明确 toast 提示**"共 N 页，只识别前 10 页"，不静默截断 |
| 失败 | 渲不出页面 → 明确报错；识别失败 → 预览区给错误，**不丢已识别的其它页** |

**⚠️ 一个必须留意的门槛**：`handleFile()` 里判定"这是扫描版"用的是
**服务器抽到的文本 < 120 字**（真扫描版是 0 字；个别 PDF 只嵌了页眉几个字也算）。
改这个阈值前先想清楚：调太大 → 有文字层的 PDF 也会被送去花 AI 钱；调太小 → 扫描版漏判。

**测试**：`tests/vision-paper.test.mjs`（**31 项**，两阶段起服务 + 桩上游 4590 + 真浏览器 9492）：
未登录 401 / 未配模型 503 / **免费用户也能识别**（口径）/ 提示词与护栏 / `uncertain` / `empty` /
上游 502 不透传 / 入参 400·413 / **真浏览器：把 File 塞进 `<input>` 派发 change →
预览面板 → 改文本 → 确认 → 「✅ 解析成功（来源：图片识别）：共 23 道题」**；
**扫描版 PDF：测试自己造一份"真的没有文字层"的最小 PDF → 断言服务器抽不到文字 →
浏览器真的加载了本地 pdf.js → 逐页渲染 → 预览按「第 1 页」标注 → 确认后照样解析成功**；
**懒加载三条**（打开页面不加载 / 做过图片识别后仍不加载 / 只有扫描版 PDF 才加载）。
已用**变异测试**自证两次（让客户端忽略老师的修改 → 23/24；摘掉扫描版 PDF 回退 → 25/29）。

### 6. 🏫 学校卷子识别（★ 2026-10 第七批的后半，**这才是"卷子→结构"**）

**为什么单独有一条路**（用户 2026-10 实测反馈）：**学校卷子**（空白卷 / 批改卷）**没有**学科网那份
「整体难度／试卷题型／细目表分析」报告。把它的照片交给上面那条"抄文字"的路，最终喂给
`PaperParser` 只会得到 **「没有解析到题目」**（实测：试卷信息面板不展开、逐题区 0 行）。
所以这条路不是"抄文字"，而是**让 AI 看懂卷子并直接产出结构**。

**路由**：`POST /api/paper-analysis/vision-paper-structure`（两种模式，同一个路由）

```
① 结构识别（默认）：{ image, page, totalPages }
   → { ok, page, empty, structure:{ title, totalScore, blocks[], questions[], uncertainNotes[], page } }
② 估难度（★ 用户点了按钮才走）：{ mode:"difficulty", questions:[{no,type,knowledge}] }
   → { ok, mode:"difficulty", difficulties:[{no, level}] }
```

| 项 | 说明 |
|---|---|
| **鉴权** | ⚠️ **免费口径**（只校验登录 + 未封禁）。**两个视觉路由共用 `src/lib/vision-call.ts`** —— 口径只有一份，别在调用方改成 `requireVip()` |
| 出参语义 | `questions[].score`：**卷面印了才填**，没印 → `null`（提示词里**禁止猜**；前端按题型惯例补并标待核对）<br>`questions[].got`：**批改卷**的每题得分（没批改 → null）→ 前端**预填**到逐题得分表<br>`questions[].knowledge`：AI **自由写**（用户口径）→ 前端用**已有的** `KnowledgeClassifier.classifyName()` 归类到模块<br>`uncertain` / `uncertainNotes`：看不清、被裁切的地方 |
| 题型白名单 | ⚠️ **type 必须**是 单选/多选/填空/判断/解答（+其他）。提示词写死，服务端再兜一层别名（选择题→单选题），前端最后还是过 `PaperParser.normType` —— **三层都归一**，因为题型错了会连带分值分配与报告统计一起错 |
| 非 JSON 返回 | 200 + `empty:true` + `raw`（把原文摊开给老师复制）—— **报 5xx 会让老师以为白花了这次调用** |
| 估难度 | 纯文本任务（**不发图**）；`level` 只接受 **较易/中等/较难/难**（与 `paper-parser.js` 的 `DIFF_LEVELS` 同词），坏值丢弃；**默认不估**，结果标 🤖 + 报告里带"仅供参考" |

**前端**（`public/tools/paper-analysis/`）：

| 位置 | 说明 |
|---|---|
| `index.html` | 与「从学科网导入试卷」**彻底分开**的独立面板：「🏫 识别学校卷子」+ `#schoolInput`（`image/*` + `.pdf`，可多选）+ `#schoolPreview` |
| `schoolRun()` | 图片 → `compressImageFile`；**PDF 一律逐页渲染**（`pdfToPageSources(f, onProgress, 20)`）→ **分批推进**（每批 ≤10 页，批内**逐页调用**）→ 合并 |
| 页数口径 | **上限 20 页**（用户 2026-10 定）：1–10 页一个批次，11–20 页自动分批（用户无感），**>20 页明确拒绝**"请分两次上传"（不静默截断） |
| 为什么不是"一批一次调用" | 10 页塞进一次请求，输出的 JSON 会有 200+ 题、**必然超过输出上限被截断**（一断整批就废），图片加起来也可能撞 4MB 请求体。批次只影响**推进与进度显示**；**合并只有一份实现** |
| `mergeStructures(parts)` | **唯一**的合并实现：同题号→合并知识点、取第一个非空的分值/得分、按题号升序、blocks 按题型累计、uncertainNotes 去重 |
| `renderSchoolPreview()` | 结构化预览（**可改**）：题号 / 题型（下拉，限定 5 类）/ 分值 / 知识点 / **归类模块** / 得分 / **难度（可手打）** / ⚠🤖 标记；顶部显示题型分块与**"有 N 道题没能归类到模块"**；按钮：生成题目结构 / 🤖 让 AI 估每题难度 / 取消 |
| `buildSchoolPaper()` | 预览 → `paper`（形状与 `PaperParser.parse` 产出**完全一致**，下游**一行都没改**）：<br>· 题型分块按题目实际数量算 · 逐题分值走**现成的** `applyTypeCell()`（spread 是唯一权威源）<br>· 批改卷得分预填 `records[no].got`（与"拍照识别答题卡"同一套数据模型）<br>· ⚠️ **刻意不清空 `#paperPaste`**（这一路不是粘贴报告来的，留空更诚实） |
| `schoolEstimateDifficulty()` | 点了才走；**先读回你改过的表格**再估，避免冲掉你的修改；结果标 `aiDifficulty` → 预览显 🤖、`paper.warnings` 带一条"仅供参考" |

**测试**：`tests/school-paper.test.mjs`（**43 项**，桩上游 4591 + 真浏览器 9494）：
401 / 400 / 413 / **免费用户可用（口径）** / 提示词（只输出 JSON、题型五选一、**分值没印就 null 不许猜**、got、uncertain）/
题型别名归一化 / 分值字符串→数字与 null / 批改得分 / blocks / 非法 JSON → 200+raw / 上游 502 不透传 /
估难度只收四档坏值丢弃 + 纯文本不发图 / **真浏览器：两页一起传 → 结构化预览（5 行、题号并集升序）→ 点 AI 估难度 → 改分值/知识点/难度/得分 → 生成题目结构 →
逐题得分区 5 行、「满分 7」生效、批改得分预填、卷子标题与总分进表单 → **两个面板跟着展开** → **容易题满分按钮生效** → 21 页被明确拒绝**。
**变异自证**：第八批 3 处一起破（忽略老师改的分值 / 多页只合并第一页 / 去掉题型别名兜底）→ **28/36**；
第九批 2 处一起破（漏掉 `#qPanel` 展开 / 难度不落成数字系数 + 去掉文字档位兜底）→ **40/43**，
红点正好落在这两处防护上。

### 6b. ✨ 报告头那个「AI 润色」：**一次点击润两部分**（★ 2026-10 第十批）

**用户需求**：报告右上角的「✨ AI 润色」原来只管「建议段」，「错因列」是面板里另一个按钮 ——
老师希望**点一次，两部分都润**，不用点两下。**面板里那两个单独按钮保留**（想只润一个就点它）。

| 项 | 实现 |
|---|---|
| 入口 | `#btnPolishAll`（报告头）→ 新的 `polishAll()`；`#btnAIAdvice` / `#btnAIPolishAttr` 各自单独润，**不动** |
| 顺序 | ⚠️ **必须串行**：`aiAdvice()` 与 `aiPolishAttribution()` 都是"**读整篇报告 → 改自己那部分 → 整篇写回**"，**并行会互相覆盖**（后写回的用自己读到的旧文本盖掉前者的成果） |
| 失败策略（用户选的） | 失败的那一步**自动重试一次**；仍失败 → **保留另一步的成果**并如实说明；**绝不整篇回滚**（回滚等于白花已经付钱的那次调用） |
| 非会员 | 第一步就被 403（「AI 建议为会员专属功能」）→ **不重试、也不再打第二步**，第二步在汇总里标「未执行」（省一次一定失败的调用） |
| 按钮状态 | 「⏳ ① 润色建议段 1/2…」→「⏳ ② 润色错因列 2/2…」（失败时显示"（重试一次）"）；结束后若有一步没成就把文案变成「✨ AI 润色（有一步没成，可再点）」，`title` 里记着上次结果 |
| 两个老函数 | 改成 `aiAdvice({btn, silent})` / `aiPolishAttribution({btn, silent})`：**返回 `{ok, error}`**（不再只靠 toast），`btn` 决定"点谁谁转圈"，`silent` 让调用方给一条汇总。单独按钮的行为**一字未变** |

⚠️ **为什么不能图快并行**（有实验证据）：变异测试里把 `polishAll()` 改成并行 →
断言立刻红成 `建议段是AI: false, 润色行数: 3`，也就是**建议段的成果被错因列那次写回覆盖了**。
真要并行，必须先把两个函数改成"各自**返回片段**、由调用方合并"，不能各自整篇写回。

**测试**：`tests/paper-attribution-polish.test.mjs` **23 → 35 项**（新增 12 条，桩上游 4589 + 真浏览器 9491/9494）：
点一次 → 上游被调 **2 次** / 两部分都润色（建议段换 AI 文本 + **有原因的那 3 道错题**最后一列换成润色文案）/
**失败自动重试一次后成功（错因列被调 2 次、总调用 3 次）** /
**只成功一半时保留建议段成果、错因列一行都没动** + 按钮文案与 title 如实说明 /
**非会员：上游一次都没被调、报告一字未改、错因列标「未执行」**。
**变异自证**：去掉重试 + 改成并行 → **33/35**，红点正是"两部分都润色"和"重试后成功"这两条。

---

### 7. 🏢 公司模板导出（★ 2026-10 第十二批，**新增模块**）

**背景**：公司发下新模板（三个附件），要求各学科最终都按这个格式交。
方案见 [`docs/company-export-plan.md`](company-export-plan.md)，模板分析见
[`docs/company-template-analysis.md`](company-template-analysis.md)。

⚠️ **红线**：**不动现有生成逻辑**（`paper-parser` / `narrator` / `error-engine` /
`report-template` / `report-docx` 一行没改）。导出是**读现有数据、输出 docx**。

| 件 | 说明 |
|---|---|
| `docs/company-template/公司模板-原件.docx` | 公司原件（格式的最终依据） |
| `docs/company-template/附件{1,2,3}.docx` | **切分好的三个模板**（`scripts/split-company-template.py` 生成；只删不属于该附件的块，styles/theme/sectPr 原样保留） |
| `public/tools/company-template/template-data.js` | 模板零件（base64 内嵌，**自动生成勿手改**；`scripts/build-company-template.py` 重新生成） |
| `public/tools/company-template/company-docx.js` | **填充引擎**：`CompanyDocx.build('附件2', data)` → Uint8Array |
| `public/tools/paper-analysis/index.html` + `js/app.js` | 面板「🏢 公司模板导出」+ `collectCompanyData()` / `exportCompany()`（③ 生成报告页） |

**引擎的三条红线**（都写进代码注释了，改动前必读）：
1. **不新建文档拼表格** —— 只改 `word/document.xml` 的文字，其余零件原样带回 ⇒ 格式零走形；
2. **样例不许漏出去** —— 模板里的语文样例必须被替换或清空。附件3 是"**整表只留标签**"，
   不能"按标签清那一行"（学情分析/措施/预期效果这三块的**子行首格是纵向合并的延续格**，
   按标签只会命中每组第一行，其余行的语文样例会漏进导出件 —— 实测踩过）；
3. **不按写死的行号/列号填** —— 一律**按标签定位**，定位不到**抛错**；
   附件2 错题行的列位从**表头行现算**（表头首格是纵向合并的标签列、数据行首格是它的**延续格**，
   写死 0/1/2/3 会把题号写进延续格、错因留在原位 —— 实测踩过）。

**另外两个坑**：
- **`replaceCells` 只许删 `<w:tc>`**，行里其余 XML（尤其 `<w:tblPrEx>`，Word 把行级边框放这儿）
  必须原样保留 —— 丢掉它表格线就没了（第一次实现就丢了，是测试的"格式指纹"断言抓住的）；
- python 在 Windows 下默认按 GBK 写 stdout，Node 按 UTF-8 读会乱码 ⇒ 测试里跑 python 必须带
  `PYTHONIOENCODING=utf-8`（否则所有中文断言假红）。

**口径**（用户 2026-10 七条）：附件2「题目」列 = **知识点顶替**（工具里没有题干）；
考试类型 = **下拉**；排名 / 已学课时 / 学校 = **手填**；**过程列与签字栏一律留空**。

**测试**：`tests/company-export.test.mjs`（**42 项**）：三个附件逐格核对（**用 python-docx
独立解析导出件**，不拿自己的解析器自证）+ 固定文字按附件逐条核对 + **语文样例泄漏扫描** +
**格式指纹**（tblBorders / tblPrEx / gridSpan / vMerge / tcBorders / 页面边距）+ 取值合成边界 +
浏览器接线。**变异自证 38/42**（① 丢 `w:tblPrEx`、② 错题列号写死、③ 附件3 只清前 5 行
⇒ 分别红了格式、逐格、泄漏断言）。

**尚未做**：附件3 的 UI（数据源在 math-plan，下一批）· 题干字段（**用户已定：先不做，等触发**）·
过程记录（二期，**挂在方案那条 history 上**、不是学生身上；届时先问用户再动表结构）。

**⭐ 一键关掉 / 如何彻底撤销**（完整清单见 `docs/company-export-plan.md` §8）：
- **能撤，且是纯新增**：**没动数据库**（无迁移/新字段）、**没动接口**、**没动其它工具**、
  现有生成逻辑**一行没改**；旧导出（`ReportDocx` 路径）与本模块互不相干。
- **一键关掉**（面板消失、按钮点不动，其它照常）：① `app.js` 里 `COMPANY_EXPORT_ENABLED` 改 `false`；
  ② 网址加 `?nocompanyexport=1`（**父页或工具页直链都认**）；③ 控制台
  `localStorage.setItem('pa_nocompanyexport','1')`。**三种关法都有测试钉住。**
- **彻底删**：按 §8.3 清单删文件 + `index.html` 两处 + `app.js` 两处（都有
  `⭐⭐⭐ 公司模板导出 · 开始/结束` 标记）；⚠️ **不要 `git revert` 整笔回退**（那一笔可能夹着别的修复）。
  接线写成"取不到元素就跳过"，所以**只删一半也不会把页面弄崩**。

---

### 6c. ★ 第九批：学校卷子识别上线后修的两个**实测 bug**

用户试完反馈"整体满意，但有两个问题"，都是真 bug：

**Bug 1 · 生成结构后「试卷信息」「解析结果」两个面板不出现**（看起来"缺了一块"）

- **根因**：`buildSchoolPaper()` 漏了 `adoptPaperText()`（学科网那条路）的**收尾步骤**：
  `$('#paperPanel').style.display=''`、`$('#qPanel').style.display=''` + `renderQuestionList()`、
  `$('#paperHint').textContent=...`。这两个面板在 HTML 里默认 `display:none`，
  所以结构生成了、数据都对了，**屏幕上却看不到**。
- **修法**：补齐这几步，并把顺序与 `adoptPaperText()` 对齐（两处都留了注释互相指向）。
- ⚠️ **教训（已写进 `dsh-work-guide.md`）**：新增一条"平行入口"时，必须**逐条对照老入口做的事**，
  否则会漏掉"看不见但必需"的收尾步骤。测试现在钉住"两个面板都出现 + 逐题列表已填充 + 提示文字更新"。
- ⚠️ 顺带确认的**已知限制**：学校卷子这条路**不写 `K_PAPER`**（那个键的形状是 `{text, meta}`，
  `text` 是恢复时的唯一来源），所以**刷新后要重新识别**。刻意不写，避免存空 text 把老师上一份报告的文字抹掉。

**Bug 2 ·「容易题满分·其余留空」按钮在 AI 估难度后不生效**（用户标为最高优先级）

- **根因**：`fillAll('easy')` 判的是 `q.grade === 'easy'`，而 `grade` **只在**解析器里由
  **数字系数 `coeff`** 派生（`coeffToGrade`）。学校卷子这条路建 `paper` 时写的是
  `coeff: null, grade: ''`，AI 估的难度只落到 `difficulty`（文字标签）→ 条件永远不成立。
- **结论（重要设计口径）**：**工具里"难度"的唯一权威是数字系数 `coeff`**，
  `difficulty`（标签）与 `grade`（档位）都是它的派生展示。**只写标签 = 所有按系数判断的功能静默失效**
  （不只是这个按钮：难度分布、系数列、学科网对照都会一起废）。
- **修法（用户问的 a/b/c，采用 c 但以 a 为主）**：
  1. **a 为主**：新增 `SCHOOL_LEVEL_COEFF`，把 AI 的档位（较易/中等/较难/难）映射成代表系数
     （**0.85 / 0.65 / 0.40 / 0.20**，与 `paper-parser.js` 的 `DIFF_LEVELS` 阈值对齐，
     保证 `coeffToLabel(映射值)` 能还原原档位 —— 有断言钉住），
     再用**现成的** `PaperParser.coeffToLabel/coeffToGrade` 派生标签与档位。
     老师在预览里**手打的档位或直接写的数字/百分数**（`coeffOfLabel()`）走同一套换算。
  2. **b 作为一行兜底**：`fillAll()` 里改成 `q.grade || PaperParser.labelToGrade(q.difficulty)` ——
     万一将来又有"只写文字不写系数"的来源，按钮不会再静默失效。
  - **为什么不干脆让 AI 直接输出数字（纯 a 的另一种做法）**：模型给"较易/中等"这类**人类档位**更稳、
    更好核对；把"档位→系数"的换算放在**本地**（确定性、可测、可解释），
    也比让模型编一个 0.83 这种假精度更诚实。报告里仍标 🤖 并注明"逐题难度由 AI 估计，仅供参考"。
- **测试**：钉住"AI 估难度 → 生成结构 → 全部清零 → 点容易题满分 → **较易那题回到满分、其余仍为 0**"，
  以及"解析结果面板里那题显示 0.85 / 较易"（系数→档位→标签一路对上）。

---

## 已知遗留问题

1. ✅ **视觉识别（答题卡识别）已启用**（2026-10 实查线上 `config.visionModel = "deepseek-flash"`）——
   本文件旧版写「未启用、返回降级提示」已过期。现补了防回归套件 `tests/vision-scores.test.mjs`。
2. ✅ **「上传截图 / 扫描版 PDF」那条路已经做完**，见上方「### 5. 图片 / 截图识别」。
   旧版这里写「还没做、而且提示语过期」——**已解决**：`parse-file` 的 image 分支不再说
   「未启用视觉模型」；图片走 `/api/paper-analysis/vision-paper`；
   **扫描版 PDF 由前端用本地 pdf.js 逐页渲图后走同一条识别管线**（不再让老师自己截图）。
3. ✅ **学校卷子（空白卷/批改卷）也能直接识别**，见「### 6. 🏫 学校卷子识别」。
   ⚠️ 与第 2 条**别搞混**：`vision-paper` 是"把图抄成文字"（给学科网报告用）；
   `vision-paper-structure` 是"把卷子理解成题目结构"。
4. **九大学科未做** —— 试卷分析的学科适配目前以数学为主（模板、词典、归因规则）。
5. **逐题常用值是"常用的一套"，不是某一年的真题** —— 北京卷等逐年会变，
   老师按当年卷子改一两道即可（改完合计会提示"与预设不一致"，是温和提示不是阻止）。
   若以后要更准，可以让老师把某年的分值存成自定义预设。

其他两个历史遗留（非本次引入，记录备查）：

- `feedback_keywords.chapter_name` 语义不统一：旧数据（人教A版 188 条）存知识点名，
  本次 AI 导入的 8358 条存章名。**功能无影响**（渲染走 `chapter_id`），
  但若以后要按 `chapter_name` 查询统计，需先统一。
- 35 本 `name='-'` 的占位教材仍在（`feedback_textbooks`），0008 只清了两者的关联章节。
  可选清理语句在 `0008_cleanup_placeholder_chapters.sql` 末尾（注释状态）。

---

## 下一步计划

**用户 2026-10 排的两件 —— 都已交付**：

1. ✅ **错因列 AI 润色** —— 已完成，见「### 3.」。
2. ✅ **上传 PDF / 照片 → AI 解析卷子内容** —— 已完成，见「### 5.」与「### 6.」：
   · 学科网**报告**截图/扫描件 → 逐字抄文字 → 现有报告解析器；
   · **学校卷子**（空白卷/批改卷）→ **AI 看懂卷子 → 题型分块 + 逐题知识点/分值/得分** → 预览可改 → 生成结构；
   · 有文字层的 PDF 走本地抽取，扫描版 PDF 用本地 pdf.js 逐页渲染；
   · 识别结果一律**先预览核对再填进导入框**；⚠️ **口径：免费**（全站唯一免费 AI 功能）。
   ⚠️ **下一步就该拿真实学校卷子实测**：我的测试验的是**管道**
   （文件 → 渲染 → 识别 → 预览 → 生成结构），桩上游返回的是固定 JSON，
   **真实卷子的识别质量（题型判得准不准、知识点写得对不对、红笔得分读不读得出）还没被验证**。
   若发现题型判错或知识点大量落到"其他"，回来调提示词或渲染分辨率（把 `VISION_MAX_SIDE` 从 1600 提到 2200）。

**其余待办**：线上用真实月考报告实测一遍（真实报告 docx 未入库，`模板-占位符.docx` 那条链路已覆盖）。

后续可做方向（未排期，按需选）：
- ~~**视觉识别启用**~~ —— ✅ **已在线上启用**（`AI_VISION_MODEL=deepseek-flash`，2026-10 实查）。
  剩下的是「识别结果必须人工核对」这条使用口径，已在界面上与文档里写明。
- **九大学科适配** —— 目前模板、词典、归因规则都以数学为主。
- **（可选）逐年分值预设** —— 现在各卷面结构只带一套「常用」逐题值，逐年会变；
  若老师希望把某年的分值存下来复用，需要给预设加"自定义"能力（目前没有）。

---

## 参考资料

- 设计文档《试卷分析工作台 · 问题全景与设计方向》 —— **不在本仓库内**（工作区未搜到），
  请从你本地文档目录取。
- `public/tools/paper-analysis/使用说明.md` ✅ 存在
- `public/tools/paper-analysis/server/部署说明.md` —— **不存在**（`server/` 目录未纳入本仓库；
  原 `server.js` 在 `M:\学生文件\00_试卷分析工作台\server\server.js`）
- `docs/ai-keywords-import-plan.md`（第 7 步 AI 导入的设计与确认记录）

---

## 环境备忘

| 项 | 值 |
|---|---|
| Supabase project ref | `jmyofgunulqxewwmmmrxn` |
| GitHub 仓库 | https://github.com/Gqj1001/my-toolbox |
| Vercel 需配环境变量 | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`AI_KEY`（无 `NEXT_PUBLIC_` 前缀）、`AI_BASE_URL`、`AI_MODEL`；可选 `AI_VISION_MODEL`、`AI_VISION_BASE_URL` |
| 本地测试依赖 | `.test-users.json`（仓库根，已 gitignore，含测试账号与密码） |
| 浏览器测试注意 | 沙箱 **dev 模式 hydration 有问题**，浏览器端测试必须跑 `next build` + `next start` |
| 读表注意 | PostgREST 单次最多返回 1000 行，**读全表必须自己分页**（已两次踩坑） |
