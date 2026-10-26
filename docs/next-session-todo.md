# 下个会话待办

> **当前状态一句话**（2026-10-26，能力维度雷达 + 列表高度 + 0030 测试隔离）：
> 全站 **57 个套件 / 1833 项断言全绿**（2026-10-26 实测）。
> 2026-10-24 本批：① 管理员刷新进不去后台（`user_roles` 查询失败被缓存成“无角色”30 秒）已修；
> ② 后台看不到老师资料（`user_profiles` RLS 只允许本人读）改用 `0026_admin_list_profiles()`（✅ 已执行）；
> ③ 档案顶部新增「目标分数 / 总课时数」（存 `extra`，不新增列），学情分析自动带入；
> ④ 学情分析三张图：成绩趋势 / 课时消耗 / **能力维度雷达（固定 6 维）**；AI 报告支持 **Markdown 表格**；
> ⑤ **A2 全机构档案总览 + 机构数据大盘**：`0027` / `0028`（✅ 已执行），KPI、饼图、提分折线、校区/月份下钻；
> ⑥ **Phase 1 权限 RLS/代码**：`0029`（表/列）、`0031`（RLS + RPC scope + 建档快照）、
>    `0032`（Owner 个人直读边界）、`0030`（Owner 切换）已执行；测试前置/降级流程见
>    `docs/test-owner-runbook.md`；`region-scope` 17/17，全套 **57 套 / 1833 项**全绿。
> 跨校区**三级完整方案**见 `docs/three-level-permissions-plan.md`；项目总结见
> `docs/project-summary-and-optimization.md`。
> 此前：学情报告六段式、档案折叠/标题/日期、后台高度（2026-10-23）；
> v2 三套 39 项。测试明细见第七节。
> 最近三批上线了 **🗂 学员档案三格（年级/学校/学管师）**、**👤 教师个人资料**（姓名/学科/校区 +
> 注册后引导 + 「修改信息」+ **导入导出都从它取、清掉 13 处写死的作者名**）、
> **🧑💼 管理后台看姓名与校区**（UUID 隐藏）。
> ✅ 迁移 `0021_user_profiles.sql` 与 `0022_seed_plan_generator_tool.sql` **都已执行**
> （资料能保存、目录里已有「辅导方案生成器（全学科）」卡片）。
> 🟢 新功能「**新注册用户自动送 15 天会员**」的迁移 `0023_auto_grant_vip.sql` **已执行并验证通过**
> （用户 2026-10-20 跑了运行期自检，看到「自动获得 15 天会员」；详见 `docs/auto-trial-vip-plan.md`）。
> 此前还有：**📥 档案页补录历史材料**、**🏢 公司模板导出 · 附件3**、
> **🔁 识别失败只重试那一页 + 💸 重复润色先确认 + 🗑 学情报告可删**。
> 公司模板导出的**附件3 已按用户 2026-10 的决定暂停**（见下面 1b 表 b 行）。
>
> 更新时间：**2026-10-20（测试死结修复 + 新注册送 15 天会员）**。本文件只放**还没做的**；
> 已完成的全部在 `docs/project-overview.md` §十「✅ 最近已完成」（有细节、测试数与变异自证结论）。
>
> 配套阅读：`docs/project-overview.md`（现状总入口）、`docs/dsh-work-guide.md`（怎么配合 + 踩过的坑）、
> `docs/perf-notes.md`（性能记录）、`docs/manual-score-plan.md`（第十四批的完整方案与实做记录）、
> `docs/company-export-plan.md`（公司模板导出方案与后台开关）。
> 每条都写了「为什么」和「怎么验」，**不要只照标题做**。

**图例**：🔴 真隐患 / 该优先做 · 🟠 待你实测验收（功能已上线，但**真实效果**还没验过）·
🔵 可选优化 · ⏳ 等触发条件 · 🚫 长期不做

---

## 一、🔴 现在最该做的三件

### 0a. 🟢 **2026-10 线上验收的 4 个问题已修完**（已 push：`ac8b9c9`）

> 用户线上试用后报了 4 件事，都改完了，**384 项测试全绿**（含 2 条新的变异自证）。
> 明细见 `docs/plan-generator-plan.md` §17 与本文档 §0b。

| # | 用户报的 | 改成什么 | 怎么验 |
|---|---|---|---|
| 1 | 补录历史材料时，AI 整理完**还要手动点一下** | **上传文件 / 粘贴文字后自动整理**（不用再点按钮），结果直接填进预览框并自动滚过去；按钮留着当"重新整理" | 随便粘一段老材料进去 —— 预览应**自己**出现 |
| 2 | 存档案后显示「**未填日期**」，学情分析排不了序 | ①补录面板加了**「这条记录是哪天的？」日期框**（默认今天，AI 抽到就自动带过来，**不给日期存不进去**）；②档案详情页每条记录都有**「补日期 / 改日期」**按钮；③记录列表改成**按日期排序** | 补录一条不给日期 → 应报错；给个日期 → 详情页显示该日期 |
| 3 | 生成的课表课时是**小数**（1.5 / 3.1 / 4.6） | 课时改成**一律整数、优先偶数**；总课时是奇数时只有一行是奇数；科目包里的小数课时也全换成了整数 | 生成一次，看课时列是不是都是 2/4/6…（没有 1.5） |
| 4 | 导出件里单位写成「**小时**」（1.1小时） | 公司附件3 与本工具 Word 导出的单位/文案都改成「**课时**」 | 导出后 Word 里搜「小时」应只有 0 处 |

> ⚠️ **一个刻意没做的事**：`math-plan`（数学专用版）的附件3 导出**仍写「小时」**。
> 原因是用户交代过"math-plan 一个字不动"，而单位是写在同一份公司引擎里的。
> 引擎已加可选参数 `hoursUnit`（默认仍「小时」），**要让数学版也改成「课时」，改一行即可**，等用户点头。

### 0b. 🟢 **通用「辅导方案生成器」收尾两件**（代码已完成；`0022` 已执行）

> 工具代码、测试、文档都做完了（**384 项**测试全绿）。
> ✅ 迁移 `0022` 已执行：`/tools` 里已有「辅导方案生成器（全学科）」卡片。
> 剩下两件**必须由你来做**：

| # | 做什么 | 怎么验 |
|---|---|---|
| 1 | **用 Word 打开两份导出件目测排版**：`.tmp-planning-samples\plangen-ui-out\ui-word.docx`（本工具模板）与 `ui-company3.docx`（公司附件3） | ⚠️ 本机**没有 LibreOffice**，所以我只能验"结构完好 + 格式零件等价"，**排版效果只有你能看**。看：表格线/行高/长文本换行/字号 |
| 2 | **拿物理老师的模块名单反馈**（`docs/physics-module-list-draft.md` 可直接转发） | 老师改完只动 `subjects/physics-senior.js` / `physics-junior.js`（**代码不动**），改完我这边跑科目包测试即可 |

> ⚠️ **`plan-generator` 与 `math-plan` 是两个独立工具**：`math-plan` 本轮**一个字节都没动**（已核 `git diff` 为空）。
> ⚠️ **将来要办的一件事**（已记在 `docs/plan-generator-plan.md` §6）：新工具存档案时 `tool` 仍写 `'math-plan'`（零迁移口径）；
> 等通用工具正式上线后，若要"物理方案与数学方案在学情分析里能分开"，要跑一条迁移放开 CHECK 并加 `tool='plan-generator'`。

### 0c. 🟠 **全学科试卷分析 v2：待真实素材验收 + 下一期接档案**

> 2026-10-21 已上线 `/tools/paper-analysis-v2`（四学科 × 初高中、三档导出、AI 题干摘要/归因）。
> 代码与测试都绿；**真实效果只有老师能验**。

| 要试的 | 看什么 | 发现不对时改哪 |
|---|---|---|
| 数学/物理/英语/语文各一份真实卷（学科网报告或整卷拍照） | 题型是否认对、题号（14(3)）是否保留、考点是否合理、作文分项是否好用 | 科目包 `subjects/*.js`（题型/模块/词典）；`core/subject-engine.js`（解析/算分） |
| 三档导出（附件1 / 附件2 / 两份一起）用 Word 打开 | 抬头、错题行、六段归因/措施、签字栏留空 | `company-template/company-docx.js` 或 `buildCompanyData` |
| AI 题干摘要 / 附件1 归因（会员） | 摘要是否像老师写的、归因是否按数据且不贴标签 | `src/app/api/paper-analysis-v2/ai/route.ts` 的提示词 |
| 英语听力 | 题号/分值在、难度不估 | 科目包 `noDifficulty` |

> **下一期（明确没做）**：v2 暂不写学员档案；要像老工具一样「存入档案/进学情分析」，
> 需要把 v2 的 paper/records 接到 `/api/students`（先问用户口径）。

### 1. 🟠 拿**真实素材**验收 AI 识别类功能（半天）

**为什么排第一**：这几轮新上线的 AI 功能，测试验的都是**管道**
（文件 → 渲染 → 识别 → 预览 → 生成结构/报告，桩上游返回固定 JSON），
**没验过真实模型的识别质量**。我这边无法替你验，只有真素材能说明问题。

| 要试的 | 看什么 | 发现不对时我调的旋钮 |
|---|---|---|
| 🧩 **通用辅导方案生成器**（新，`/tools/plan-generator`，`0022` 已执行） | 生成出来的模块表是否合用；**AI 写的教学目标像不像物理老师说的话**（这是用户最关心的一条）；导出附件3 与 Word 模板的排版 | 提示词在 `src/app/api/plan-generator/ai/prompts.ts`（措辞规则 / 真实样例 few-shot / 量化指标表）；模块名单在 `subjects/physics-*.js`（**改数据不改代码**） |
| 🏢 **公司模板导出**（附件1/2，试卷分析「③ 生成报告」页下面） | 用 **Word 打开导出的 docx**：格式与公司模板是否一致（表格线/合并格/字号）、抬头数据对不对、**该留空的（三段措施、签字栏）是不是真留空**、语文样例有没有漏出来 | 引擎按标签定位，格式走形或样例漏出都是 bug |
| 🏫 **学校卷子**：空白卷照片、批改卷照片、扫描版 PDF 各一份 | 题型判得准不准（多选 vs 单选最容易错）、知识点写得对不对、**批改卷的红笔得分读不读得出** | 提示词；渲染分辨率 `VISION_MAX_SIDE` 1600 → 2200（更清楚，更慢更贵） |
| 📷 **学科网报告**：截图 / 扫描版 PDF | 抄录是否**逐字忠实**（有没有自己改写、漏行）、表格有没有串行 | 同上 |
| ✨ **合并润色**：点一次报告头那个按钮 | 建议段 + 错因列是否**都**变、等待时间能否接受（2 次调用，通常十几秒） | 提示词语气；是否需要把两步拆回去 |
| 📋 **学情分析**（档案详情页） | 统计是否与你的记录一致、AI 报告是否合用 | `src/lib/student-report.ts` 的抽取规则 |

**反馈方式最省事**：截图 + 一句话（如"多选题认成单选了"/"知识点全是其他"）。

### 1b. ✅ 已拍板 / ⏳ 等触发的事

> 🔴 **需要你在 Supabase 做一次（下面逐条；已完成的不再算）**：
> 1. ~~**执行 `supabase/migrations/0018_feature_flags.sql`**~~ —— ✅ **用户 2026-10 已执行**
>    （实测：`admin-feature-flags` 已走**分支 B**，18/18 全绿，真测"关掉/打开"生效）。
> 2. ~~**执行 `supabase/migrations/0019_history_tool_allow_manual.sql`**~~ —— ✅ **用户 2026-10 已执行**
>    （实测：`manual-score` 已走**分支 B**，**45/45 全绿**，含"保存 → 读回 → 进趋势 → 删除"
>    与真浏览器整条链路）。
> 3. **还没做：Authentication → URL Configuration → Redirect URLs 里加两条**（**第十五批**，忘记密码要用）：
>    `https://010034.xyz/auth/confirm` 与 `http://localhost:3000/auth/confirm`。
>    **不加的话重置邮件发不出去**（Supabase 拒绝跳到白名单外的地址）。
>    另外**上线后请自己点一遍**"修改密码"和"忘记密码"各一次 —— 自动测试**故意没有真改密码**
>    （怕把共享测试账号留在未知密码上，导致后续所有套件一起红）。详见 `docs/password-reset-plan.md`。
>
> 🟢 **`supabase/migrations/0021_user_profiles.sql` 已执行**（**第二十批**）
> —— 教师**个人资料**表（姓名/学科/校区/落款）已建好（2026-10-20 实测：保存资料能成功、能读回）。
> 注册后的引导页、首页「修改信息」、落款自动带出、后台用户列表显示姓名/校区 都已生效。
>
> ✅ **`supabase/migrations/0023_auto_grant_vip.sql` 已执行并验证通过**（**2026-10-20 新功能**）
> —— 新注册用户**自动送 15 天会员**（数据库触发器，注册即生效，不依赖前端）。
> 用户已跑运行期自检，看到「自动获得 15 天会员」。
> ⚠️ 它**不回溯**给已注册的老用户，只对“执行这条 SQL 之后新注册的人”生效。
>
> 🟢 **2026-10-21：全学科试卷分析 v2 已上线**（`/tools/paper-analysis-v2`）：
> 老数学版**未改动**（纯逻辑抽到 `paper-analysis/js/core/`）；新工具是界面壳；
> 一期四学科 × 初高中（8 份科目包）；三档导出 + AI 题干摘要/附件1归因。
> 迁移 `0024`（tools）/ `0025`（feature flag）已执行。
>
> 🟢 **可选：执行 `supabase/migrations/0020_feature_flag_backfill.sql`**（**第十八批**）
> —— 给「补录历史材料」补一条**功能开关**种子（新 key `backfill_materials`）。
> **不跑也安全**：功能照常可用（读不到开关时一律当"开启"），只是后台「功能开关」区看不到那一行、
> 也就没法一键关掉。**跑完**之后 `tests/admin-feature-flags.test.mjs` 会多测两条
> （后台点关掉 → `/dashboard` 面板消失 → 再点开恢复）。
> ⚠️ 为什么不是改 `0018`：它的 seed 用 `on conflict (key) do nothing`，**重跑不会补出新 key**。

| # | 事项 | 状态 |
|---|---|---|
| a | **附件2「题目」列要不要改成读题干** | ✅ **用户 2026-10 已定：先不做（列为"等触发"）**。理由：**学科网报告里根本没有题干**（只有题号/知识点/难度/细目表）⇒ 对主力路径**零收益**；而"抄错题干"会把错的原文写进**要交公司**的表，风险高于"题目列与考点列重复"。<br>**触发条件**（满足再谈）：出现明确的"拍整张卷子导入"使用场景，或用户主动提出。成本约 **+0.003–0.006 元/页**（每题多 30–60 字输出）。完整评估见 `docs/company-export-plan.md` §6 |
| b | **公司模板导出 · 附件3 的接线** | 🅿️ **2026-10 第十四批：用户改口"先不做附件三了"**（原定"下一批做"）。方案已写好并留档：`docs/company-attachment3-plan.md`（逐格数据来源 + 两个待拍板项 + 验收口径）。**恢复条件**：用户主动说要，或他先用 Word 核对完附件1/2 的排版后再说 |
| c | **附件1 要不要一期就上** | ✅ **用户 2026-10 已拍板：一期就上**（即当前行为：格式框架 + 抬头已填，**六段归因/措施由老师手写**）。二期若要省手写，再考虑 AI 出草稿（属新功能，另开） |
| d | **过程列二期怎么做**（三次课后/阶段总结/效果评估） | ⏳ 结论已记进文档：这几段**跟着"这一份方案"走、不跟学生走** ⇒ 二期记录要**挂在那份方案的 history 记录上**（入口：档案详情页「辅导方案记录」旁），**不是存在学生身上**；**届时需要动表结构 ⇒ 先问用户，别自己跑 SQL** |

### 2. 🔴 `public/tools/*.html` 里"本机模式"的默认模型名还是已停用的 `deepseek-chat`（小，但会咬人）

- **现状**：服务端 5 个 AI 路由第四批已改成 `deepseek-flash`（待办 B），
  但**工具页本机模式（双击 HTML / 自己带 Key）**的默认值没改，还有 **7 处**：
  `public/tools/feedback.html`（4 处）、`public/tools/paper-analysis/js/app.js`（2 处）、
  `public/tools/paper-analysis/index.html`（1 处 placeholder）。
- **为什么没动**：这些文件是**工具会话的地盘**（上一轮明确"破例授权"才改的），
  我只在明确授权时动它们。
- **风险**：`deepseek-chat` 官方 2026-07-24 已停用（实测仍被兼容路由兜着，所以能跑），
  但老师在本机模式下不手填模型名时会走这个兜底值。
- **怎么验**：改完在本机模式（双击 HTML）点一次 AI 润色，看请求体的 `model` 是不是 `deepseek-flash`。

### 3. 🟠 观察「AI 自由写知识点」的归类质量（跟着第 1 条一起看）

- **口径**：用户 2026-10 定的 —— 知识点**由 AI 自由写**，再用**已有的**
  `KnowledgeClassifier` 归类到模块（预览里会显示每题归到哪个模块，并在顶部提示
  「有 N 道题没能归类到模块」）。
- **风险**：AI 写的措辞若不在词典/规则里，会落到「其他」桶 → 报告里的**模块失分统计**会退化。
- **怎么判**：如果实测时"其他"占比明显（比如 > 20%），告诉我，我给 `kp-dict.js` 加词，
  或把口径改成"限定在词典内挑"。

---

## 二、🔵 可选优化（都不阻塞，按兴趣挑）

| # | 项 | 说明 / 触发条件 |
|---|---|---|
| 1 | feedback「离线模式」入口 | 现在云端拉不到就是空页面，这是**有意**的（防止拿旧数据生成反馈）。要做需先想清楚"离线时能用哪些功能" |
| 2 | few-shot 效果评估 | 触发条件：累计用 AI 润色 **20–30 次**后，看真实产出再决定要不要加示例 |
| 3 | 深度调优 AI 润色（温度 / prompt） | 需要真实产出的对比样本，与第 1 条一起做最省事 |
| 4 | 逐年分值预设（自定义） | 各卷面结构只带一套「常用」逐题值，逐年会变；让老师把自己那年的分值存成预设 |
| 5 | 关掉导航预取 | 省 11 条后台预取，代价是首次进入略慢（用户此前决定先不做） |
| 6 | ~~识别失败**只重试那一页**~~ | ✅ **2026-10 第十七批已做**（两条管线：`vision-paper` 与 `vision-paper-structure`；详见 `docs/import-retry-plan.md`） |
| 7 | ~~重复点润色时提示"已润过一遍"~~ | ✅ **2026-10 第十七批已做**（建议段 / 错因列 / 合并按钮三处口径一致，取消后不调用 AI） |
| 8 | 学员档案页加"生成学情分析"入口 | 现在入口在档案详情页；用户当时只要求"能做出来" |
| 9 | **学情报告的删除** | ✅ **2026-10 第十七批已做**（详情页的 analysis 记录也能删，只删那一条、档案不动） |

---

## 三、⏳ 等触发条件

**全学科扩展（先物理试水）**：跑通后把「科目配置」抽出来，再横向复制。
详细清单见 `docs/other-subjects-plan.md`。
**触发条件**：有物理老师主动要，或数学用稳 2–3 周。**依赖**：每科要 10–15 份学科网报告。

---

## 四、🚫 长期不做（别自作主张开工）

自动支付 · 会员使用统计 · 全站数据导出 · 多老师团队模式 · 更换服务器架构（国内备案）·
**引第三方 OCR**（视觉模型已够用，实测过：`/api/paper-analysis/mode` 线上已启用 `deepseek-flash`）。

---

## 五、📌 已知问题（记录用，修不修都行）

1. **`tools` 表的建表语句不在仓库里**（只有种子数据），会员那三列（`plan`/`status`/`expires_at`）
   的加列语句也不在。**不要试图用仓库的 SQL 重建数据库。**
2. **换工具权限 / 下线工具没有后台界面** —— 只能去 Supabase SQL Editor 手跑（照 `0012` 的写法）。
   改完最多 30 秒全站生效（`tools` 表有 30 秒进程内缓存）。
3. **学校卷子那条路不写 `K_PAPER`** ⇒ **刷新后要重新识别**（刻意为之：那个键的形状是
   `{text, meta}`，`text` 是恢复时的唯一来源，存空 text 会抹掉上一份报告的文字）。
   要改成可恢复需要先设计"没有纯文本来源时怎么存"，属于新需求。
4. **`student-analysis` 的项数取决于数据库状态**（`0017` 未执行 = 19 项，已执行 = **21 项**）。
   用户 2026-10 已执行 ⇒ 现在是 21 项；两条分支都留在码里，**别删**。
5. **`tests/step7-ui.test.mjs` 隔离弱点**：按关键词查全表，会被上次运行的遗留数据污染。
6. **Edge 调试端口会被「幽灵监听者」占住**（2026-10 踩过一次）：`Get-NetTCPConnection`
   列得出端口在监听、PID 却是个不存在的进程 → 真浏览器套件统一报"无法连接 Edge 调试端口"。
   **重启机器**即可（换端口也行），不是代码问题。
7. **功能开关的「白名单」护栏没有自动断言**（2026-10 第十三批，用户已知情并同意先这样）：
   只允许改 `FEATURE_FLAG_REGISTRY` 里登记过的 key，但 **Server Action 不好从测试里伪造调用** ⇒
   靠代码 + 人工 review（`src/app/admin/feature-actions.ts` 里有注释说明）。
   真要补，建议**抽出纯函数单测**（比伪造 action 调用实在）。
8. **`0018_feature_flags.sql` 要用户自己执行**（什么时候跑由用户定）：
   迁移文件**已在仓库里**（`supabase/migrations/0018_feature_flags.sql`，远端也存在），
   **不执行也安全** —— 所有功能保持开启，后台只显示"表还没建 + 要跑这个迁移"。
   跑完 `tests/admin-feature-flags.test.mjs` 会自动从"分支 A"切到"分支 B"。
   ⚠️ 跑它**只建这一张新表**，不动现有数据；但**别顺势用仓库迁移重建整个库**（见 `project-overview.md` §三 隐患 1）。

### ⚠️ 测试环境的两个大坑（每次跑回归前看一遍）

- **一次只跑一个 runner**：两个 runner 同时用 3000 会**假红**——曾经 `ai-thinking-mode` 直接变
  **0/11**（请求被别人的服务回答了，回来 503「未配置 AI Key」），代码其实是好的。
  看到端口类失败（503 / 连不上 / 一半 PASS 一半怪错误），**先怀疑端口被抢，再怀疑代码**。
- **这些套件会自己起 `next start` 并杀掉 3000 端口**，别和其它真服务套件并行：
  `feedback-data-cache`、`feedback-client-cache`、`students-unified`、`admin-grant90`、
  `middleware-cache`、`math-plan-students`、`date-input`、`paper-analysis-students`、
  `archive-students`、`vision-scores`（起两次服务）、`student-analysis`（桩 4588）、
  `paper-attribution-polish`（桩 4589 + Edge 9491）、`vision-paper`（起两次服务，桩 4590 + Edge 9492）、
  `school-paper`（桩 4591 + Edge 9494）、**`company-export`（起服务 + Edge 9495；自带 python 校验）**、**`admin-feature-flags`（起服务 + Edge 9496）**、
  **`manual-score`（起服务 + Edge 9497；第十四批新增，会自动适配迁移 0019 跑没跑）**、
  **`password-flows`（起服务 + Edge 9498；第十五批新增：忘记密码/修改密码）**。
  （`student-report` **不需要服务**：纯函数 + 直接 import `.ts`，秒级跑完。）
- 需要外部服务的 6 套 + 自带服务的 1 套已固化成脚本（会先等 3000 空出来）：
  ```powershell
  & "<bundled node>" tests\_run-ui-suites.mjs
  ```

---

## 六、✅ 已结案（**不要再做**；细节见 `project-overview.md` §十「最近已完成」）

| 事项 | 结论 |
|---|---|
| **Phase 1 权限 RLS/代码（2026-10-24）** | ✅ **已完成并上线**：`0029`（regions/campuses/加列）、`0031`（`is_owner`/`is_region_admin`/`can_read_student`、学生/历史 RLS、RPC scope、建档快照触发器）、`0032`（Owner 个人直读边界）已执行；`0030` 已于 2026-10-26 执行（owner_count=1 / other_admin=0 / pending=0）；`viewer`/`requireOwner`/后台入口升级为 `admin_scope`；大区管理员只读、老师本人范围、Owner 全量已测。测试 `region-scope` 17/17；全套 **57 套 / 1833 项**全绿。测试库 rolea 已设 Test Owner；生产库只保留真实 Owner。 |
| **学情图表 2.0 + 机构数据大盘（2026-10-24）** | ✅ **已完成**：① 模块薄弱改**雷达图**，先提核心知识点（优先匹配试卷/方案模块，去掉解释词/泛化短语）；② AI 报告支持 **Markdown 表格**，前端解析成规整 `<table>`；③ `/admin/archives` 加四张 KPI（总学员/本月新增/本月估算课时/进行中方案）、各校区饼图、整体提分折线，点击下钻校区/月份；④ `0028` 已执行。测试 `markdown-tables` 7 / `student-analysis` 25 / `admin-archives` 23；全套 **55 套 / 1811 项**全绿。 |
| **A2 全机构档案总览（2026-10-24）** | ✅ **已完成并上线**：`0027_admin_archives_a2.sql`（`admin_list_all_students()` 只读搜索/筛选 + `admin_set_student_campus()` 归属标签纠正，SECURITY DEFINER + `is_admin()`）；后台 `/admin/archives` 从 `/admin` 进入。口径：老板只看、校区=机构校区、历史默认按老师当前校区、推错可手动纠正；**未动现有 RLS/老师端/表结构**。测试 `admin-archives` 18/18；全套 **54 套 / 1798 项**全绿。校区分级（校区管理员）未做，见 `docs/cross-campus-permissions-plan.md`。 |
| **后台 Bug 修复 + 档案目标/课时 + 图表（2026-10-24）** | ✅ **已完成**：① 管理员刷新进不去后台（`user_roles` 查询失败被缓存成“无角色”30 秒）→ `readRoleRow()` 失败必抛、重试一次、不缓存失败；② 后台看不到老师资料（`user_profiles` RLS 只允许本人读）→ `0026_admin_list_profiles()`（✅ 已执行）+ `admin-profiles` 6/6；③ 档案顶部「目标分数 / 总课时数」存 `extra`，学情分析自动带入；④ 学情分析三张 Chart.js 图（成绩趋势 / 课时消耗 / 模块薄弱）。测试 `role-read` 7 / `admin-profiles` 6 / `student-report` 57 / `archive-students` 46 / `admin-feature-flags` 27；全套 **53 套 / 1780 项**全绿。跨校区权限**只出方案**：`docs/cross-campus-permissions-plan.md`，未动代码/表。 |
| **学情分析 AI 升级 + 档案体验（2026-10-23）** | ✅ **已完成并上线**：学情报告改六段式（整体学情 / **学习进度** / **分数目标对比** / 优势 / 薄弱与原因 / **针对性提升方案**），提示词要求“像老教师一样推理、每个判断带依据”；免费统计新增「学习进度」「分数目标对比」两节。档案列表去掉补录日期、课后反馈默认折叠 3 条；补录 AI 从正文抽日期；后台用户列表外层容器加高。测试 `student-report` 54 / `student-analysis` 24 / `archive-students` 43 / `backfill` 45 / `admin-feature-flags` 26，全套 **51 套 / 1760 项**全绿。详见 `docs/project-overview.md` §十「最近已完成」与 `docs/analysis-product-brief.md`。 |
| 第一批 | 空壳工具口径对齐（**没有代码可删**，只改文档）· 非法日期导致 500 已修 · `vision-scores` 防回归测试 |
| 第二批 | `extra` 改成**服务端按键合并**（修掉 paper 覆盖 math-plan 字段的真 bug） |
| 第三批 | **学情分析**（统计免费 + AI 报告会员专属，落库成 `tool='analysis'`）+ 迁移 `0017` |
| 第四批（待办 A+B） | **写档案的读失败不再静默降级**（503 + 一个字都不改）· **默认模型名** 5 个 AI 路由 → `deepseek-flash` |
| 第五批 | **错因列 AI 润色**（会员专属，段数硬契约，只动最后一列） |
| 第六～七批 | **图片/截图识别** + **扫描版 PDF**（本地 pdf.js 懒加载，一次最多 10 页）· ⚠️ **免费口径**（全站唯一免费 AI 功能） |
| 第八～九批 | **🏫 学校卷子识别**（空白卷/批改卷 → 题目结构，上限 20 页）· 修掉上线后实测的两个 bug（面板不出现 / 容易题满分不生效） |
| 第十批 | **「✨ AI 润色」一次点完建议段 + 错因列**（串行；失败重试一次；保留成功部分） |
| 第十二批 | **🏢 公司模板导出（附件1/2）** —— 以公司 docx 为底、按标签替换文字；引擎 + 三个切分模板 + 面板；测试 42 项、变异自证 38/42。⚠️ **红线：现有生成逻辑一行没改**（见 `docs/company-export-plan.md`） |
| `/tools` 改个人中心 + 百宝箱改「学员档案管理」 | 已上线（含"勾了才提交""删除连带记录"） |
| 阶段 3 / 阶段 4：两个工具接入统一学生 API | 已上线（`/api/students`，合并语义 + `extra` jsonb）· 迁移 `0016` 已执行 |
| `feedback.html`「下载 10 秒」 | **根因是用户电脑上的代理软件（狮子云 `127.0.0.1:7890`）把流量绕出去了**，不是服务端问题（服务器只用 411ms）。✅ 用户**已把 `010034.xyz` 加进直连名单** ⇒ **已彻底结案，不必再提**。判断口径以后照用：凡是"某文件下载慢但服务端首字节很快"，先看 HAR 里 `serverIPAddress` 是不是 `127.0.0.1`。分析脚本：`tests/_analyze-har.mjs` |
| 测试死结（2026-10-20） | `profile` 用「`profile=null`」推断「表没建」→ 误走提交分支、把假资料写回，清一次只能好一轮；`admin-grant90` 在提示出现前就读（提示 0.8 秒后才出现、5 秒后消失）。**已修**：直接探测表 + 表在时不写；提示改短轮询。详见 `docs/dsh-work-guide.md` 坑 23。 |

> **本轮（2026-10-23）实做记录**：学情分析的「学习进度」是按材料对照的启发式——
> 从最近一次反馈的【课堂内容】/【下节课内容】去匹配方案【逐次课表】；匹配不上会明说
> “方案可能已调整”，**不会硬说按计划**。以后真实素材若发现维度不理想，先改
> `src/lib/student-report.ts` 的 `parseFeedbackProgress` / `parsePlanLessons` / target 计算，
> 再改 `src/app/api/students/analysis/route.ts` 的 `SYSTEM_PROMPT`（提示词第 6–9 条）。

---

## 七、环境备忘（新会话不用再问用户）
| 项 | 值 |
|---|---|
| 仓库 | `D:\my-website\my-toolbox`（注意：工作目录可能是 `D:\my-website`，**仓库在子目录里**） |
| git | `D:\my-website\.tools\git\cmd\git.exe`（**不在 PATH**） |
| 线上 | `https://010034.xyz` |
| 测试账号 | `roleb`=VIP（`userEmail`）、`rolea`=免费/管理员（`adminEmail`） |
| 跑测试 | `C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe tests\<套件>`；**先 `next build`** |
| 推送 | 先 `git push origin main`；若 `github.com:443` 不通（会超时 300 秒），用 `node scripts\push-via-api.mjs`（它会打印 `git update-ref` 对齐命令） |
| 四份文档 | `project-overview.md`（总入口）· `dsh-work-guide.md`（怎么配合 + 踩坑）· `perf-notes.md`（性能）· 本文件（待办） |
| ⚠️ 测试环境坑（2026-10 已修） | **`profile` 的两条假红不是环境问题，是套件的「测试死结」**：旧版用 `/api/profile` 有没有资料来判断「`user_profiles` 表建没建」，而「表没建」与「表建了但没填」都返回 `null`。清理账号后套件误判没建 → 提交表单 → 把「测试老师」写回去 → 下次跑又红。**2026-10 已修**：直接探测表（200/PGRST205），表在但没资料时**不写**。详见 `tests/profile.test.mjs` 顶部与 `docs/test-data-cleanup.md`。 |
| ⚠️ 回归怎么跑（2026-10 新增） | **一次只跑一个 runner**。`paper-analysis` 等套件**需要外面先起好服务**，单独跑会干等 ⇒ 别用"一把梭"的批量 runner 跑全套，按 `tests/_run-ui-suites.mjs` 的名单分两批（需要外部服务的 / 自己起服务的）。`plan-generator-ui` 与 `plan-generator-ai` 已登记进那个 runner。 |

**全套回归现状（2026-10-26 实测：56 个 `*.test.mjs` + `verify-checklist.mjs` = 57 套，全绿）**：

- **57 套全部串行亲跑过**（一次一个 runner，不并行）；下面是**实测值**，合计 **1833 项断言**。
- 任务一修复前 **1690/1692**；两条红都是**测试自身的死结**（`profile` 31/32、`admin-grant90` 17/18），
  已修。修完后 **1691/1691**（`profile` 正常态 **31/31**、`admin-grant90` 18/18）。
- 2026-10-21 v2 三套 **39 项**；2026-10-23 学情/档案净增 **18 项**；2026-10-24 新增 5 套 **60 项**
  （A2/大盘/图表/权限）、旧套件净增 **8 项**；2026-10-26 新增 `test-owner-preflight` **3 项**
  ⇒ **57 套 / 1833 项**。

```
math-plan-template 82/82   math-plan-lessons 44/44   math-plan-students 37/37
math-plan-ai-apply 20/20   math-plan-ai-sections 26/26  math-plan-ai-vip-path 18/18
math-plan-export-ui 18/18  middleware-cache 13/13     verify-checklist 18/18
step7-api 39/39            step7-ui 36/36             ai-thinking-mode 11/11
paper-analysis 56/56       paper-regression 23/23     paper-score-edit 59/59
paper-score-report 15/15   paper-score-ui 36/36       paper-preset 18/18
paper-analysis-students 27/27
paper-attribution-polish 42/42
vision-paper 41/41
school-paper 43/43
feedback-data-cache 26/26  feedback-client-cache 51/51
students-unified 91/91     date-input 15/15           admin-grant90 18/18
archive-students 46/46     vision-scores 15/15
manual-score 45/45         student-report 57/57       password-flows 42/42
student-analysis 25/25     company-export 77/77       backfill 45/45
admin-feature-flags 27/27  profile 31/31
role-read 7/7              admin-profiles 6/6        admin-archives 23/23
markdown-tables 7/7            region-scope 17/17         test-owner-preflight 3/3
plan-generator-engine 45/45   plan-generator-subjects 68/68   plan-generator-subjects-new 56/56
plan-generator-docx 20/20     plan-generator-template 22/22   plan-generator-company 29/29
plan-generator-archive 40/40  plan-generator-ai-client 36/36  plan-generator-ui 27/27
plan-generator-ai 41/41
signup-trial-vip 12/12（2026-10-20 任务二新增：0023 触发器静态契约）
paper-analysis-v2-core 17/17   paper-analysis-v2-ai 10/10   paper-analysis-v2-ui 12/12
```

> ⚠️ **两条红都修在测试侧，产品代码一行没改**：
> · `profile`：不再用「profile=null」推断「表没建」，改为直接探测表；表在但没资料时**不写**。
> · `admin-grant90`：数据库先变、提示后出现（约 0.8 秒）、5 秒后自动消失 ⇒ 改成**短轮询**。
> 详见 `docs/dsh-work-guide.md` **坑 23**。

> ⚠️ **一个反复踩到的坑（本轮踩了两次）**：`password-flows` 与 `admin-grant90` 在**与别的 runner 并行**
> 时会假红（都是"计时/提示文案"类断言）。**它们的数字以单独跑为准**（上面已是单独跑的实测值 42/42、18/18）。
> ⚠️ 另一个：`company-export` 的断言详情里会出现 `附件2: 0/0`（单元格级边框数），
> 用 `Select-String "0/0"` 之类粗筛会**误判成某套件"0 项通过"**。判断结果请认 `=== SUMMARY ===` 后面那行或 exit code。

> ⚠️ **本轮的两个新认识（都写进实际文档了）**：
> 1. **`student-report` 实际是 48 项**（旧文档写 45，是"加断言时忘了改"的漂移）——
>    这正是坑 1 说的那类问题：**以实跑为准，别照抄旧表**；同理
>    `archive-students` 37、`company-export` 77、`plan-generator-engine` 45、
>    `plan-generator-ui` 27、`plan-generator-ai` 41 也都更新了；
> 2. **`_run-ui-suites.mjs` 的清单仍然落后**：它只列了需要外部服务的几套，
>    而"自己起服务"的套件早就有 30 套。**要跑全套就得按那串名单一套一套来**，
>    别以为跑完那个脚本就等于全套回归；`plan-generator` 那 **10 套**（engine / subjects /
>    subjects-new / docx / template / company / archive / ai-client / ui / ai）也必须算进去。

> ⚠️ **以「刚跑完的那一次」为准，别照抄旧值**。第一批实测时就发现旧表有几处**过期或漏项**：> `math-plan-students` 实际是 **37**（旧表写 29）、`students-unified` 曾经写 62 而实际 64，
> 而且**整个 `archive-students`（17 项）被漏掉了**。这正是 `dsh-work-guide.md` 坑 1 说的那类问题。
>
> 变化说明（最近三批，更早的见 `project-overview.md` §十）：
> · **第十七批（三件小优化）**：**识别失败只重试那一页**（两条管线：`vision-paper` 与
>   `vision-paper-structure`）→ `vision-paper` 31 → **41 项**；
>   **重复润色先确认**（建议段/错因列/合并按钮三处口径一致，取消后不调用 AI）→
>   `paper-attribution-polish` 35 → **42 项**；
>   **学情报告可删**（详情页 `analysis` 记录也开删除按钮）→ `archive-students` 21 → **28 项**。
>   ⚠️ 新增的 `window.confirm` 会**阻塞无头浏览器**，所以相关套件必须用 CDP 的
>   `Page.javascriptDialogOpening` + `handleJavaScriptDialog` 自动应答（本轮踩到并记在文档里）。
> · **第十六批（用户实测报的 bug）**：**邮件重置链接落到登录页** —— 根因是
>   Supabase 把会话放在跳转地址的 **`#` 片段**里，而 `#` **不发给服务器**，
>   原来那个服务端路由 `/auth/confirm` 只能读 `?token_hash=` ⇒ 永远读不到会话。
>   已改成**客户端回调页**（`page.tsx` + `auth-confirm-client.tsx`，
>   解析在纯函数 `lib/auth-callback.ts`，旧 `route.ts` 已删）。
>   `password-flows` 32 → **42 项**：新增一条**真浏览器**断言
>   （真会话放进片段 → 必须跳到 `/reset-password` 且表单可用）。
>   顺带 `admin-feature-flags` 从 10 → **18 项**（0018 已执行，走分支 B：真测"关掉/打开"）。
> · **第十五批**：新增 `password-flows`（**42 项**：纯函数 + 静态契约 + 真 HTTP + 真浏览器）；
>   `manual-score` 32 → **45 项**（✅ 用户跑完迁移 `0019` 后**分支 B 实测 45/45**；
>   顺手修掉两条**假红断言**：趋势那行原来用"页面里有没有 `105/150` 字符串"来判，
>   而页面渲染是 `105` 与 ` / 150` 两段 ⇒ 改成从 HTML 里**抠表格行**核对）；
>   `student-report` → **45**。
> · **第十四批**：新增 `manual-score`（**32 项**，迁移 0019 跑过后 37）；
>   `student-report` 37 → **45**（「手动补录」组 + 契约；**旧值 37 本身就是漂移**）。
>   ⚠️ 那一轮跑了**全套**：回归中途我曾误起带服务的套件杀了 3000，把 `students-unified` 弄红一次
>   —— 重跑 81/81 干净；教训见 `dsh-work-guide.md` 坑 16。
> · **第九批**：`school-paper` 36 → **43**（用户实测报的两个 bug 的防回归：两个面板要展开、
>   AI 估难度后「容易题满分」要把较易的题置回满分；外加"难度必须落成数字系数 0.85"的根因断言）。
> ⚠️ `paper-attribution-polish` 那条合并**必须串行**——两个函数都是"读整篇→改自己→整篇写回"，
> 并行会互相覆盖（变异测试验过：改并行 → 33/35，红的正是"两部分都润色"）。
> 第二～十五批都用**变异测试**自证过断言真会红。
