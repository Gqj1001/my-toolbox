# 交接：全学科通用「辅导方案」工具（新会话开工文档）

> 这份文档是给**新会话**用的：读完它就能开工，不用回溯上个会话的上下文。
> 用户 2026-10 拍板的三件事（**别再问一遍**）：
> 1. **进度表「一行 = 一个模块」**（不是"一行 = 一次课 2h"）；
> 2. **新开一个通用工具**（容纳所有学科 × 初高中），**不要**去给 `math-plan` 打补丁；
> 3. **教学话术由 AI 生成初版、老师就地编辑**。
>
> 前置分析见 `docs/subject-expansion-analysis.md`（物理样例提炼 + 与 math-plan 的逐项对比）。

---

## 0. 一句话任务

做一个**通用「辅导方案生成器」**：老师选**学科 + 学段 + 年级 + 学生情况 + 总课时**，
工具产出「模块级」的辅导方案进度表（一行一模块），**AI 生成每模块的内容与教学目标初稿**，
老师就地改，然后能**导出成公司附件3**、也能**存进学生档案**。

---

## 1. 已经验证过的事实（省得重新试）

| 事实 | 证据 |
|---|---|
| ⭐ **公司附件3 的引擎已经是学科无关的** —— 真实物理内容（23 模块 / 147 课时 / 含 4.5h、7.5h、1.5h 小数）直接喂进去**零改代码全对** | `docs/samples/附件3-物理样例导出（自动生成）.docx`；生成脚本 `.tmp-planning-samples/check-physics-att3.cjs` |
| 附件3 的「按模块合并」正好匹配"一行一模块" | `public/tools/company-template/company-docx.js` 的附件3 分支（第十八批已上线、74 项测试保着） |
| 物理样例的表结构与附件3 **一一对应**（`阶段\|内容\|课时数\|教学目标` ↔ `知识模块\|知识点及目标\|课时数\|效果评估`） | 分析文档 §1.2 |
| **`math-plan` 的导出引擎（占位符替换 / 整行增删 / 统一字体）与学科无关** | `public/tools/math-plan/js/report-template.js`（278 占位符、`{{sN_st}}` 等），本轮实测通过 |
| 学情分析读辅导方案时**认的是 `tool='math-plan'` 与正文标记**（`【课时安排】共 N 课时`） | `src/lib/student-report.ts`（`SOURCE_TOOLS` / `parsePlanHours`） |
| 现有数学的 188 项测试是"数学不能被改坏"的回归网 | `math-plan-template`(82) `math-plan-lessons`(44) `math-plan-export-ui`(18) `math-plan-ai-*`(44) |

---

## 2. 关键技术决策（建议照做，除非有更好的理由）

| # | 决定 | 理由 |
|---|---|---|
| D1 | **新工具用新 slug**（如 `tutor-plan`），放 `public/tools/tutor-plan/**`；`math-plan` **一个字不动** | 数学老师仍每天在用；零风险；将来若要合并再评估 |
| D2 | **存入档案时 `tool` 仍写 `'math-plan'`**，但 `title` / `subject` 按实际学科写（`物理辅导方案` / `subject:'physics'`） | ① `feedback_history.tool` 的 CHECK 只允许 `feedback/paper/math-plan/analysis/manual` —— 新增 `'tutor-plan'` **要迁移**；② 复用已有值 ⇒ **零迁移**，且学情分析（`SOURCE_TOOLS`/`TOOL_LABELS`）**自动认** |
| D3 | 学科 code 统一用**工具现有那套**：`chinese/math/english/physics/chemistry/biology/politics/history/geography/general` | `feedback.html` 的 `SUBJECTS` 与 `user_profiles.subject` 都是这套；别再造一套 |
| D4 | **一行 = 一个模块**；`课时数` 写模块总课时（**保留小数**，如 4.5） | 用户拍板 B；附件3 引擎原生支持 |
| D5 | **教学话术不要写死**：模块库只给「模块名 + 章节 + 适用学期 + 难度」，**内容/目标由 AI 生成初稿** | 用户："话术其实还是根据学生情况和总体课时量老师自行安排" |
| D6 | 初高中**两套科目包**（模块轴不同：初中物理是"声/光/热/电与磁"，高中是"力/电/热/光/原子"） | `docs/other-subjects-plan.md` §E 的结论（2 学段 × N 学科） |
| D7 | **不动** `company-docx.js`（实测已够用）；导出直接调 `CompanyDocx.build('附件3', data)`，`data.rows` 用 `{module, content, goal, hours}` | 已在 `math-plan.html` 的第十八批接线里跑通，照抄即可 |
| D8 | 一键开关沿用 `company_export`（`feature-flags.ts` 的 `tools` 里加新 slug） | 与附件3 同一个开关，**无需新迁移** |

---

## 3. 参考实现（用户要求"参考现有数学程序的文件"）

**直接可抄的部分**（都在 `public/tools/math-plan/` 与 `math-plan.html`）：

| 要抄什么 | 从哪抄 |
|---|---|
| Word 导出（读模板替换占位符、整行增删、统一五号宋体） | `math-plan/js/report-template.js` + `js/docx-builder.js` + `template-data.js` |
| 公司附件3 导出的取数与按钮接线（含 `collectCompany3Data` / `exportCompany3` / 一键开关 / `?nocompanyexport=1`） | `math-plan.html` 第十八批那段（搜索「公司模板导出（附件3）」） |
| 存入档案（`op:'import'` → `/api/students`，含 `tool/title/subject/score` 字段） | `math-plan.html` 的 `savePlan` 一段（搜索 `tool: "math-plan"`） |
| 从档案带出学生信息（姓名/年级/校区/学管师/学科） | `math-plan.html` 的 `bootCloud()` 与 `/api/students?withHistory=1` |
| AI 分段改写（把某段发给模型、按行数契约校验收回） | `src/app/api/math-plan/ai-sections/route.ts`（**注意**：它的提示词是"高中数学"，要**参数化学科**） |
| 一键开关 + 面板 + 预览可编辑 的写法 | `public/tools/paper-analysis/js/app.js` 的 company 面板；`src/components/backfill-panel.tsx`（AI 生成 → 预览可编辑 → 确认入库） |
| 学生资料（老师姓名/学科/校区 ⇒ 落款、导出抬头） | `GET /api/profile`（返回 `{teacherName, subject, subjectName, campus, signature}`） |
| 测试写法（纯函数 + python-docx 独立核验 + 真浏览器 + 变异自证） | `tests/company-export.test.mjs`、`tests/math-plan-template.test.mjs`、`tests/profile.test.mjs` |

**模块库的字段设计**（建议；`math-plan` 的 `MODULES` 是数学专用，别照抄字段名）：

```js
// public/tools/tutor-plan/subjects/physics-senior.js
{
  key:'physics', stage:'senior', name:'物理', fullScore:100,
  // 档位线：替代 math-plan 里写死的 fmtScore()（那是 150 分制：120/90/60）
  bands:[{min:85,key:3,name:'冲高分'},{min:60,key:2,name:'提中档'},{min:0,key:1,name:'补基础'}],
  modules:[
    // ⚠️ 不写"话术"，只给客观信息；内容/目标由 AI 生成初稿
    {id:'p01', name:'运动的描述', chapters:['1.1质点 参考系','1.2时间 位移','1.3速度','1.4加速度'],
     term:'必修一', lv:1, hoursHint:3, tags:['力学','基础'], must:false},
    {id:'p02', name:'匀变速直线运动的研究', chapters:[...], term:'必修一', lv:2, hoursHint:6, tags:['力学','高频']},
    // … 23–25 个（可参考 docs/subject-expansion-analysis.md §1.3 的真实样例课时）
  ],
  // 编排轴：物理按"复习轮次/册次"，不是数学的"高一上/下"
  order:{ '高三':['p01',...], '新高二':['p08','p09','p05','p06','p16','p17'] },
  // 复习阶段（附件3 的"阶段（章节/单元/模块）"那一列在样例里是 一轮/二轮）
  stages:[{key:'r1',name:'一轮专题复习'},{key:'r2',name:'二轮大专题'}],
}
```

---

## 4. 新工具怎么注册（**完整清单，别漏**）

| # | 做什么 | 文件 / 命令 | 备注 |
|---|---|---|---|
| 1 | 工具页本体 | `public/tools/tutor-plan/index.html` + `js/**` + `subjects/**` | `resolveIframeSrc()` 认 `public/tools/<slug>.html` **或** `public/tools/<slug>/index.html` |
| 2 | 路由壳 | `src/app/tools/tutor-plan/page.tsx`（照 `src/app/tools/math-plan/page.tsx`：`<ToolPageShell route="/tools/tutor-plan" />`） | 3 行 |
| 3 | **数据库登记** | 新迁移 `supabase/migrations/00XX_seed_tutor_plan_tool.sql`，照 `0010_seed_paper_analysis_tool.sql` 的写法往 `public.tools` 插一行（`route='/tools/tutor-plan'`、`min_plan`、`sort_order`） | ⚠️ **要用户在 Supabase 执行**；不跑的话工具卡片不出现 |
| 4 | 一键开关 | `src/lib/feature-flags.ts` 的 `company_export.tools` 加上 `"tutor-plan"` | 无需新迁移 |
| 5 | （若导出形态要独立开关） | 可再加一条 `FeatureFlagSpec` + 一条种子迁移 | 可选 |
| 6 | 学情分析认它 | **不用改**（D2：仍写 `tool='math-plan'`） | 若将来要独立 `tool` 值，则要迁移 + 改 `src/lib/student-report.ts` 的 `TOOL_LABELS`/`SOURCE_TOOLS` |
| 7 | 文档 | `docs/project-overview.md`（加一行"最近已完成"）、`docs/next-session-todo.md`（回归清单/待办） | 项目规矩 |

---

## 5. AI 生成初版（D5 的落地建议）

**两步走，都让老师看得见、改得动**：

1. **整份方案生成**：输入「学科 + 学段 + 年级 + 总课时 + 学生情况（薄弱模块多选 + 分数档 + 已复习过的模块）」
   → 服务端按科目包算出**模块取舍与课时分配**（这部分是**确定性规则**，不要交给模型：
   参考 `pickModules()` 的评分骨架，学科无关，改读科目包的 `tags`/`lv` 即可）
   → 再让模型只做**文字活**：把每个模块写成「内容（含小节编号） + 教学目标」两句。
2. **单模块重生成**：老师对某一行不满意 → 那一行旁边一个「AI 重写」按钮，只重写这一行。

**服务端**：新路由 `src/app/api/tutor-plan/ai/route.ts`，**照抄** `src/app/api/math-plan/ai-sections/route.ts`
的护栏（`requireVip` / `AI_KEY` 缺失 503 / 关 thinking / `truncatedByReasoning` 重试 /
**行数契约**（返回行数必须等于请求行数，否则拒绝——防止错位）/ 上游错误不透传），
但把提示词**按学科参数化**（"你是一位有十几年经验的**高中物理**教师…"）。

**护栏（务必保留，都是踩过的坑）**：
- 模型只能写**该学科真实存在**的内容，**不许编造**章节或考点（照 `src/lib/backfill.ts` 的写法：留空 > 编造）；
- 行数契约 + "只返回正文、不要编号"（`stripLeadingNumbers` 那类处理）；
- 生成结果**必须落在可编辑的输入框/表格里**，**不能**直接写库。

---

## 6. 验收口径（做完给用户的证据）

1. **导出件逐格核验**：python-docx **独立解析**导出的附件3，断言
   「行数 = 模块数」「课时数逐行相等（含 4.5/7.5）」「合计 = 各模块之和」「**模板自带的语文样例一处都不许有**」；
   （现成参考：`tests/company-export.test.mjs` 的附件3 组 + `.tmp-planning-samples/verify-physics-att3.py`）
2. **真浏览器**：填参数 → 生成 → AI 初稿落进表格 → 改一行 → 导出 → 拿真实字节 → 再交 python-docx 复核；
3. **存入档案**：`tool='math-plan'` + 正确 `subject` → 学情分析能读到它（`parsePlanHours` 认 `【课时安排】共 N 课时`）；
   建议在方案正文里带这一句，否则"课时累计"统计不到；
4. **一键开关**：`?nocompanyexport=1` / 后台开关 / localStorage 三种关法都让按钮与面板消失；
5. **变异自证**（项目规矩：真 bug 必须证明"退回去就会红"）：至少 2 条
   （如"课时数抹掉小数"、"导出时把模块行按 2h 拆开"）；
6. **全套回归**（**一次只跑一个 runner** —— 并行跑会让 `step7-ui`/`password-flows`/`admin-grant90` 假红，
   这是本项目反复踩到的坑）+ 更新文档 + **停在 push 前**等用户验收。

---

## 7. 环境与命令（照抄即可）

```
仓库        : D:\my-website\my-toolbox
node        : C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
pnpm        : C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
python      : C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
              （自带 python-docx 1.2.0）
git         : D:\my-website\.tools\git\cmd\git.exe（不在 PATH 上）
构建        : <node> <pnpm> build
单套测试    : <node> tests\<name>.test.mjs
全套回归    : <node> tests\_run-ui-suites.mjs  然后逐一跑自带服务的套件（见 docs/next-session-todo.md §八）
推不上去时  : <node> scripts\push-via-api.mjs（先 --dry；直连 github 经常被 reset）
```

⚠️ **红线**（项目规矩，别破）：
- **改表结构 / 跑 SQL ⇒ 停下问用户**；
- 真 bug 必须补测试 + 变异自证；
- 全套回归后再 commit；**停在 push 前**等用户验收；
- `git add` 只点名文件，**绝不 `git add -A`**；
- 不碰 `public/tools/math-viz.html`、`src/app/tools/math-viz/`、`supabase/migrations/0013_seed_math_viz_tool.sql`、
  `进度与待办-阶段4后.md`（这四个是别人的未跟踪文件）；
- 一次只跑一个 runner。

---

## 8. 素材与参考

- **物理样例**（真实文件，只读）：`other-subjects/{senior,junior}/physics/辅导计划/*`
  - 高中全年（最全，23 模块/213h）、高中阶段（28h）、高三班组（210h）、初中全托（166.5h）、初中个体（28h）
  - ⚠️ `senior/physics/辅导计划/袁恒瑞暑假辅导方案（新初二物理）.doc` **文件头损坏**，转不出来（需用户重新导出）
- **已经转换好的副本**（我上轮转的，临时目录）：`.tmp-planning-samples/subject-samples/*.docx`
- **实测导出件**：`docs/samples/附件3-物理样例导出（自动生成）.docx`（可直接 Word 打开看排版）
- **物理模块与课时清单**：`docs/subject-expansion-analysis.md` §1.3（可直接当科目包的初稿来源）
- **语文样例先不要看**（用户明确要求：物理跑通再说）
