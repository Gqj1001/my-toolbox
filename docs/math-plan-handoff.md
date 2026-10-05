# 高中数学辅导方案生成器 · 交接报告

> 本报告只讲**现在在哪、下一步做什么、有什么坑**。完整演变见 `git log --oneline`。
> 工具本体：`public/tools/math-plan.html`（**单文件 HTML** + 外挂 js/资源）

---

## 一、当前状态

| 项目 | 状态 |
|---|---|
| 已推送的最新提交 | 见下方「本轮提交」 |
| 本轮提交 | 「辅导方案 Word 模板化导出（新模板）+ 字体统一 + m41 位置 + 校区/教师拆分」 |
| 线上 `tools` 表 | ⚠️ `/tools/math-plan` 的 `min_plan` **仍是 vip**，需执行 `0011_fix_math_plan_min_plan.sql`（我无 service_role key，改不了线上） |
| 页面可访问性 | 非会员访问 `/tools/math-plan` 会被重定向到 `/upgrade`（因为线上还是 vip） |
| 模板文件 | `模板-占位符.docx`（185,749 字节，**新版**，由 `make-new-template.py` 从桌面那份重建）；旧版备份 `模板-占位符.old.docx`（185,564 字节，**已废弃**） |
| 用户桌面模板 | `C:\Users\郭庆杰\Desktop\模板-辅导方案.docx`（232,207 字节）—— **只读基准，全程未改动** |
| DEMO 产物 | `D:\my-website\.tmp-planning-samples\demo-out\`（v1..v5，最新 **v5** 已通过 Word 验收） |

---

## 二、工具的运行链路（先看这个，再改代码）

```
public/tools/math-plan.html                      主页面（单文件；HTML + CSS + 主脚本）
  ├─ ./math-plan/template-data.js                由 build-template.py 生成，278 占位符 + 22 零件 base64
  ├─ ./math-plan/js/docx-builder.js              通用 ZIP/OOXML 打包器（从试卷分析逐字节复制，独立不耦合）
  └─ ./math-plan/js/report-template.js           模板化导出核心：替换 / 动态增删行 / 三轮叙述
       └─ 读 docs/math-plan-template/模板-占位符.docx（拆包产物在 public/tools/math-plan/template-parts/，已 gitignore）
```

**⚠️ 路径坑（踩过）**：页面是 `/tools/math-plan.html`（**文件**，不是目录），
同级目录是 `/tools/`，所以外挂资源必须写 `./math-plan/xxx.js`。
写成 `./xxx.js` 会 404，而且**纯逻辑测试发现不了**，只有真跑浏览器才暴露。

---

## 三、模板规格（278 个占位符）

**⚠️ 模板已经换过一次（2026-10 重做）**，这一节是**新版**的口径。

来源：以**用户桌面那份** `模板-辅导方案.docx`（232,207 字节，标签齐全、无占位符）为基准重建。
仓库里的 `docs/math-plan-template/模板-占位符.docx`（185,749 字节）由脚本生成；
旧那份保留为 `模板-占位符.old.docx`（185,564 字节，**已废弃，别再拿它当基准**）。

**旧模板的病根（务必理解，否则会重犯）**：旧模板把「年级」「学科」「咨询师」「校区」四个
**标签格换成了占位符格**，导致导出后"只剩值、标签不见了"、值也错位。
**标签与占位符必须落在不同的格里。**

### 新版逐格映射（0-based 格号；注意 R1/R2 共 9 格、12 个网格列）

```
R1:  0=基本信 息 | 1=学员 | 2={{name}} | 3=年级 | 4={{grade}} | 5=学科 | 6={{subj}} | 7=教材版本 | 8={{book}}
R2:  0=（竖排续）| 1=学管师 | 2={{mgr}} | 3=咨询师 | 4={{cons}} | 5=校区 | 6={{camp}} | 7=教师 | 8={{tchr}}
R3:  0=教学方 法 | 1={{method}}
R4:  0=辅导时间：{{period}}        ← 单格；标签由模板自带，程序**只填时间值**
R5:  表头（阶段/内容/课时数/教学目标），固定文字，不打占位符
R6..R72: 0/1/2/3 = {{sN_st}}/{{sN_ct}}/{{sN_hr}}/{{sN_ob}}，N=1..67
```

- **`{{name}}/{{grade}}/{{subj}}/{{book}}` 与 `{{mgr}}/{{cons}}/{{camp}}/{{tchr}}` 都在偶数格（2/4/6/8）**，
  标签在它们左边紧邻的奇数格（1/3/5/7）。**写在奇数格上就会把标签覆盖掉。**
- `{{cons}}`（咨询师）程序**固定传空**（真实方案里没有咨询师）
- 老师手填区（表外「学生监护人：　　日期：」、左侧竖排标签、标题）**一律不碰**
- 模板里**没有三轮阶段表** → 三轮信息按 `{{method}}` 末尾的连续叙述表达（已确认方案 B）

### 重建模板的方法（改模板后必须重跑）

```powershell
# 1) 从桌面那份重新生成带占位符的模板（脚本在仓库外 .tmp-planning-samples/make-new-template.py）
# 2) 再重新生成 template-data.js
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" `
  "D:\my-website\my-toolbox\public\tools\math-plan\build-template.py"
```

### ⚠️ python-docx 的坑（重建模板时必踩）

**`row.cells[i]` 与 XML 的 `<w:tc>` 不是一一对应的** —— 横向合并的单元格会被**重复返回**。
本项目 R1/R2 的 `row.cells` 返回 **12 个**，而 XML 里只有 **9 个 `<w:tc>`**。
所以 `row.cells[4]` 其实指向"年级"标签格，而不是它右边的空格。

→ **重建模板时必须直接操作 `row._tr.findall(qn('w:tc'))`**，不能信 `row.cells`。
（第一版就是这么把「年级/学科/咨询师/校区」四个标签覆盖掉的。）

---

## 四、程序填入内容的统一字体规格（本轮刚做）

新版模板里占位符所在 run **本来就是宋体**（`w:ascii="宋体"` + `hint=eastAsia`，`szCs=21`）；
旧模板才是微软雅黑 9pt/10.5pt/11pt 混着。无论模板怎样，程序一律**强制覆盖**为五号宋体：

```js
const UNIFORM_RPR =
  '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
  + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>';
```

- 中文 → 宋体；英文/数字 → Times New Roman；字号 → 10.5pt（`w:sz=21`）
- **只作用于被替换的 run**；固定标签（学员/学管师/表头/辅导时间：/学生监护人/日期：）保持模板原样（宋体，继承默认字号）
- 实现是**外科式两遍替换**：① 占位符完整落在一个 run 里 → 只改那个 run；
  ② 占位符被 Word 拆散 → 退化为整段重写。
  **为什么要以外科式为主**：`辅导时间：` 与 `{{period}}` 同段但是**两个 run**，
  若整段重写会把它们**合并成一个 run**（早期版本就是这么错的，run 总数会少 1）。

### ⚠️ `buildMap` 里 `period` 不能再拼标签（已修的 bug）

模板 R4 那一格**自带**「辅导时间：」，所以 `buildMap` 里**只填时间值**：

```js
d.period = p.period || '';        // 正确
// d.period = '辅导时间：' + p.period;   ← 错误：会导出成「辅导时间：辅导时间：春季」
```

这个 bug 在 v2–v4 里一直存在（被前面几个更明显的错位问题盖住了），v5 才修掉，
并加了 2 条防重复断言（`R4 里「辅导时间：」只出现 1 次`）。

---

## 四之二、基本信息字段与界面（校区/教师已拆开）

| 字段 | 界面元素 | 模板占位符 | 说明 |
|---|---|---|---|
| `o.name` | `#f-name` | `{{name}}` | 学员姓名 |
| `o.grade` | `#f-grade` | `{{grade}}` | 年级 |
| `o.book` | `#f-book` | `{{book}}` | 教材版本 |
| `o.campus` | **`#f-campus`** | `{{camp}}` | **校区**（placeholder「如 燕郊中学校区」） |
| `o.teacher` | **`#f-teach`** | `{{tchr}}` | **教师**（placeholder「如 郭庆杰」，**默认值郭庆杰**） |
| `o.mgr` / `o.cons` | 无输入框 | `{{mgr}}` / `{{cons}}` | 程序固定传空（学管师/咨询师由老师手填） |

**本轮变更**：原先「校区 / 教师」是**一个**输入框（`#f-teacher`），只喂给了 `o.campus`，
`o.teacher` 一直是 `undefined` → 导出的 `{{tchr}}` 永远是空。现在拆成两个：

- HTML：`#f-teacher` 删除，改为 `#f-campus` + `#f-teach`（`#f-teach` 带 `value="郭庆杰"`）
- `readForm()`：`campus: $("#f-campus")…`、新增 `teacher: $("#f-teach")…`
- 屏幕基本信息表：「校区/教师」一格 → `校区`/值 + `教师`/值 两对
- 顶部 meta 行：**只显示校区**（按需求，不显示教师）
- payload（`exportWordTemplate` 与 `MathPlanHooks.buildPayload`）已是 `camp: o.campus` / `tchr: o.teacher`，无需改

---

## 五、动态行算法（fitLessonRows）

模板预置 **67 个样板行**（表第 6–72 行，每行 4 个占位符，列宽 `2590/3968/851/2412`）。

- 行数 **< 67**：截掉多余样板行
- 行数 **> 67**：深拷贝最后一行样板追加（字符串复制即深拷贝，列宽/边距随 XML 一起走）
- 然后把 `sN` 编号**重排为 1..count**
- 软上限 `MAX_ROWS = 200`，超出截断并给 warning

**不变式**（已写成断言）：单元格宽度序列必须逐项一致，多/少的部分只能整行出现在末尾。

---

## 六、排课相关的重要口径（阶段① 立的）

| 概念 | 规则 | 位置 |
|---|---|---|
| 必开模块 | `m43 高考真题精讲`(lv2)、`m44 错题清零`(lv1)、`m45 综合模拟`(lv2)，均 `must:true` | `MODULES` 末尾 |
| 三大压轴专项 | `m34/m37/m38` 也 `must:true` | 原有行加字段 |
| done 豁免 | `must` 模块绕过「已完成」过滤；`generate` 里从 `MODULES` 直接取，**不受 `pickModules` 空返回影响** | `pickModules` + `generate` |
| 最小课时 | `MUST_MIN_ROWS = {m43:2, m44:2, m45:2}`（各 2 行 = 4 课时） | `allocateRows` |
| 槽位预算 | `maxRows = max(2, round(课时/2) - 2)`；**不减必开个数**；`allocateRows` 另收 `maxRows = round(课时/2) - 1` 作为模块槽位上限 | `generate` |
| 三轮划分 | `roundIndexOf`：`_final`/`m43-45` → 3；名字含 `专项｜压轴` → 2；topic∈`计算/真题/错题/模拟` → 3；其余 → 1 | `roundIndexOf` |
| 三轮文案 | **<100h → 基础过关/专项突破/真题模拟**；**≥100h → 一轮补基础/二轮抓题型/三轮练真题**（文案逐字保留原样） | `threeRounds` |
| 课表排序 | 按轮次稳定排序（一轮→二轮→三轮），收尾检测行仍在最后 | `generate` |
| **m41 位置** | **优先于轮次排序**：band1 → 第 1 行（不在池也插）；band2&score<70 → 前 3 行；其他不动。**轮次排序后要在 `generate` 里再修正一次**（否则被 `topic:"计算"` 判成第三轮而沉底） | `pickModules` + `generate` |
| 自检 | 「检测落地」判据放宽为 `/检测｜综合模拟/`；新增「模块覆盖/未排入模块」 | `selfCheck` |

## 七、待办的下一步（按优先级）

### P0 · 已完成 ✅ m41（初高中衔接与计算过关）位置修正

**规则**（已实现并测试通过）：

- `band === 1`（<50 分）→ 强制**第 1 行**；**不在池里也强制加进来**（豁免 done）
- `band === 2 && score < 70` → 排进**前 3 行**；不在池里就不加
- 其他（band 3，或 band2 且 score ≥ 70）→ 不强制

**⚠️ 实现上有个必须知道的坑（两处修改，缺一不可）**：

1. `pickModules()` 里排序后调整 `m41` 的位置（band1 → unshift，band2&<70 → splice 到下标 2）
2. **`generate()` 的轮次排序之后还要再修正一次** —— 因为 `m41` 的 `topic` 是「计算」，
   `roundIndexOf` 会把它判为**第三轮**，于是低分段方案里它反而被排到**最后**（实测 band=1 时第 45/45 行），
   与「低分段必须先补衔接与计算」直接冲突。所以最终顺序上要再把它提到最前，
   **这条规则的优先级高于轮次排序**。

**另一个坑**：收尾的「综合模拟与查漏」行（`module.id === "_final"`）必须**始终留在最后一行**，
否则 `selfCheck` 的「检测落地」会变成 warn。所以 m41 只能插在它**前面** ——
实现里先把尾行 `pop()` 出来，插完再 `concat` 回去。

### P1 · 线上一致性

执行 `supabase/migrations/0011_fix_math_plan_min_plan.sql`（把 `/tools/math-plan` 的 `min_plan` 改成 `free`）。
跑之前非会员进不了工具页。

### P2 · 网站层面（用户说另开任务）

`/dashboard`（4,121 字节）与 `/tools`（1,387 字节）**共用同一个 `@/components/tool-grid`**，
数据来源也相同（`getToolViewsForMembership` + `getCurrentUserWithRole` + `getMembership`）。
差异只有：dashboard 多了会员状态卡（`PLAN_LABELS`/`remainingDays`）+ `SignOutButton`。
→ 可以从 `/tools` 改造成"个人中心"（挂上会员卡 + 退出），dashboard 改成 redirect，消除重复。**未动代码。**

### P3 · 其它已知项

- 模板是否补「咨询师」标签（见第三节末）
- `{{method}}` 三轮叙述的措辞可再润色（当前见 `roundsSentence`）

---

## 八、回归测试清单（改完必须全绿）

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `tests/math-plan-template.test.mjs` | **76** | 模板完整性（278 占位符 / 逐格映射）、动态行（20/67/80）、格式不变、统一字体、手填区不动、method 拼接、**R4 辅导时间不重复**、可重复导出 |
| `tests/math-plan-lessons.test.mjs` | **37** | 必开模块、done 豁免、最小课时、三轮口径与排序、极端场景、**m41 位置（三条规则）** |
| `tests/math-plan-export-ui.test.mjs` | **16** | 真浏览器：脚本加载、两个按钮、真实导出、DEMO 落盘 |
| `tests/math-plan-ai-sections.test.mjs` | **26** | AI 分区润色接口鉴权/入参/前端往返 |

**合计 155 项。**

跑法（用 bundled Node）：

```powershell
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tests\math-plan-template.test.mjs
```

**另有两个需要真服务的套件**（会自己起 next start，端口 3000）：
`math-plan-export-ui` / `math-plan-ai-sections`。跑之前先 `pnpm build`。

⚠️ 跑法注意：**连续跑多个需要真服务的套件时偶发 1 项失败**（登录/会话时序抖动），
重跑即过；判断是否真失败要看能否稳定复现。

---

## 九、环境与账号（重要）

| 项 | 值 |
|---|---|
| 测试账号分工 | **`roleb-` = VIP（会员版，剩 30 天）**；**`rolea-` = 免费版（admin 但非会员）** |
| AI Key | 本地 `.env.local` **无 `AI_KEY`** → 接口返回 503；`rolea` 调则 403 |
| 免 Key 验证技巧 | 用**假 `AI_KEY`** 另起一次服务，可验证「503 之后的链路」（上游用假 Key 拒绝 → 502） |
| 构建 | `pnpm build`（Turbopack）；构建后 `/api/math-plan/ai-sections` 应出现在路由表 |
| 浏览器测试注意 | 必须 `next build` + `next start`（dev 模式 hydration 有问题） |
| GitHub 网络 | `github.com:443` 偶发连接重置（`api.github.com` 正常），push 需重试 |

---

## 十、设计约束（不要破坏）

- **模板格式 100% 一致**：只能做「文本替换 + 整行增删」，**绝不自己拼 `tcW`/`tblGrid`/`tblPr`/边框**
- **AI 改写后立刻导出要用最新文本**：导出时**从 DOM 现取**（`#methodBody` 的 `innerText`、`#goalsBody` 的 `[data-goal]` 单元格），不要用生成方案时的快照
- 旧版导出 `exportWord()`（HTML 转 .doc）**保留为次级按钮**，不要删
- 改模板后必须重新跑 `python public/tools/math-plan/build-template.py` 重新生成 `template-data.js`
- 不要碰 feedback / paper-analysis / membership 的文件
