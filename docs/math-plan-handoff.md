# 高中数学辅导方案生成器 · 交接报告

> 本报告只讲**现在在哪、下一步做什么、有什么坑**。完整演变见 `git log --oneline`
> （⚠️ git **不在 PATH** 上，可执行文件路径见第九节）。
> 工具本体：`public/tools/math-plan.html`（**单文件 HTML** + 外挂 js/资源）

---

## 一、当前状态

| 项目 | 状态 |
|---|---|
| 已推送的最新提交 | **`b249a02`**「自检目标量化修正 + 点名到行 + 文档同步」 |
| 工作区 | 干净；`main` == `origin/main` == `b249a02`（**已全部推送**） |
| 上次完整交接（本报告基准） | `b575362`「更新 math-plan 交接文档：P1 完成 + 补记踩坑」 |
| ⚠️ 本报告写完后又有提交 | **基准之后还有 6 个提交动过真实代码/测试/文档** —— 若读到的还是「基准 = `b575362`」，说明本报告落后，**先按第十一节核对，再动手** |
| 线上 `tools` 表 | ✅ `/tools/math-plan` 的 `min_plan` **已是 `free`** —— 0011 已在 Supabase SQL Editor 执行成功（核对证据见第七节 P1） |
| 页面可访问性 | ✅ 非会员可正常打开 `/tools/math-plan`（`min_plan=free` → `vipOnly=false` → 不再跳 `/upgrade`）；页内 AI 功能区仍 VIP 专属 |
| 模板文件 | `模板-占位符.docx`（185,749 字节，**新版**，由 `make-new-template.py` 从桌面那份重建）；旧版备份 `模板-占位符.old.docx`（185,564 字节，**已废弃**） |
| 用户桌面模板 | `C:\Users\郭庆杰\Desktop\模板-辅导方案.docx`（232,207 字节）—— **只读基准，全程未改动** |
| DEMO 产物 | `D:\my-website\.tmp-planning-samples\demo-out\`（v1..v5，最新 **v5** 已通过 Word 验收） |

> **本报告已同步到 `b249a02`。** 第 11 节记录了基准 `b575362` 之后的 6 个提交各自改了什么，
> 以及本报告里**已被它们推翻**的旧口径（**至少第四节之二的「教师默认值郭庆杰」是错的**）。
> 先看第 11 节，再看你要改的那一节。

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
| `o.teacher` | **`#f-teach`** | `{{tchr}}` | **教师**（**空输入框**，仅 placeholder「如 郭庆杰」，**不预填**） |
| `o.mgr` / `o.cons` | 无输入框 | `{{mgr}}` / `{{cons}}` | 程序固定传空（学管师/咨询师由老师手填） |

**本轮变更**：原先「校区 / 教师」是**一个**输入框（`#f-teacher`），只喂给了 `o.campus`，
`o.teacher` 一直是 `undefined` → 导出的 `{{tchr}}` 永远是空。现在拆成两个：

- HTML：`#f-teacher` 删除，改为 `#f-campus` + `#f-teach`
  （`#f-teach` 初版带 `value="郭庆杰"`，**已由 `01c5c92` 去掉预填、只留 placeholder** —— 别照旧报告写回默认值）
- `readForm()`：`campus: $("#f-campus")…`、新增 `teacher: $("#f-teach")…`（**两处都只有 `.value.trim()`，没有兜底默认值**）
- 屏幕基本信息表：「校区/教师」一格 → `校区`/值 + `教师`/值 两对
- 顶部 meta 行：**只显示校区**（按需求，不显示教师）
- payload（`exportWordTemplate` 与 `MathPlanHooks.buildPayload`）已是 `camp: o.campus` / `tchr: o.teacher`，无需改
- ⚠️ **副作用**：教师不再预填 → 老师**忘了填就是空**，导出的 `{{tchr}}` 会留白。这是刻意取舍（`01c5c92`），
  不是 bug；要改回预填得先确认需求。

---

## 四之三、统一学生档案（阶段4，2026-10）

工具**以前什么都不存**（刷新即丢）。现在左侧「① 学生与考区」多了一排
**已保存学生的小圆片** + 一个「💾 保存档案」，数据存在全站统一的学生档案里
（`feedback_students` 表，接口 `/api/students`，合并语义）。

### 只存「学生是谁」

| 存进档案 | 字段 |
|---|---|
| 顶层列 | `name` / `grade` / `campus` / `teacher` |
| `extra`（工具专属） | `phase` / `book` / `exam`（考区存**短码**：`bj`/`nh1`/`custom`） |

**不进档案**（属于「这一次方案」）：分数、目标分、课时、频次、周数、薄弱模块、
已完成模块、备注、主攻方向、课堂环节、检测节奏、真题来源。
唯一落点是 `readStudentIdentity()` —— **往那里加字段就等于把它们写进学生档案**。

### 代码在哪

`math-plan.html` 里搜「八之三、阶段4」。要点：

- `NEXT_HOST` —— 只有网址是 `/tools/math-plan(.html)` 时才开云；
  **双击 HTML / 放到别的服务器上跑，行为与接入前完全一致**。
- `persistStudent()` —— **唯一的写档案入口**（调用点不要自己 `fetch`）。
- ⚠️ `extra` 是 jsonb，**传了就是整块替换**（合并语义只保护顶层列）。
  所以 `persistStudent()` 先 `loadAll()` 读回旧行、展开旧 `extra`，再盖自己的三个键。
  少了这一步，math-plan 存一次就会把 paper 的 `extra.cls` 抹掉。
- 拉不到档案时不静默：关掉云模式并**明确提示**（避免按钮点了没反应）。
- 左侧底部那句提示已按事实改过（点保存会上传学生身份，但不上传分数/课时）。

### 没做的

- **不写历史记录**：`feedback_history.tool` 的 CHECK 只允许 `('feedback','paper')`，
  要加 `math-plan` 必须先跑一条迁移（改约束），**再**改接口与前端。
- 没有「首次迁移弹窗」：本工具从来没有本地数据，**没有东西要迁**
  （paper 有 localStorage 旧数据，所以那边有）。

### 测试

`tests/math-plan-students.test.mjs`（29 项，真服务 + 真浏览器）：
选学生带出信息、只存身份字段（含 `extra` 无数字值的双重防护）、刷新不丢、
**两家工具的 `extra` 键同时活着**、`import` 的 `tool` 校验、**本机模式（`file://`）一行没变**。
另有 `tests/students-unified.test.mjs` 的「阶段4」组（该文件现为 62 项）。

---

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
| 自检 | 「检测落地」判据放宽为 `/检测｜综合模拟/`；新增「模块覆盖/未排入模块」；**「目标量化」不再误报收尾行**，且不合格时**点名「第 N 行「阶段名」」+ 总数**（`b249a02`，见第 11 节） | `selfCheck` |

## 七、待办的下一步（按优先级；P0、P1 已完成 ✅）

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

### P1 · 线上一致性 ✅ 已完成

**动作**：在 Supabase Dashboard → SQL Editor 整段执行 `supabase/migrations/0011_fix_math_plan_min_plan.sql`
（把 `/tools/math-plan` 的 `min_plan` 从 `vip` 改成 `free`）。**已执行成功。**

**核对证据（用 anon key 直查线上 `tools` 表 —— `min_plan` 是公开字段，不需要 service_role）**：

```powershell
$env_ = Get-Content D:\my-website\my-toolbox\.env.local -Raw
$url  = ([regex]::Match($env_,'NEXT_PUBLIC_SUPABASE_URL=(\S+)')).Groups[1].Value.Trim()
$key  = ([regex]::Match($env_,'NEXT_PUBLIC_SUPABASE_ANON_KEY=(\S+)')).Groups[1].Value.Trim()
$h    = @{ apikey = $key; Authorization = "Bearer $key" }
Invoke-RestMethod -Uri "$url/rest/v1/tools?select=sort_order,name,route,min_plan,active&order=sort_order.asc" -Headers $h |
  Format-Table sort_order,name,route,min_plan,active -AutoSize
```

实测输出（本轮）：

```
sort_order name                     route                      min_plan active
---------- ----                     -----                      -------- ------
         1 高中数学辅导方案生成器    /tools/math-plan           free     True
         6 试卷分析工作台            /tools/paper-analysis      free     True
        10 JSON 格式化             /tools/json-formatter      free     True
        15 课后反馈工作台            /tools/feedback            free     True
        20 密码生成器              /tools/password-generator   free     True
        40 会员专属：批量数据处理     /tools/vip-batch           vip      True
        50 会员专属：高级报表导出     /tools/vip-report          vip      True
```

→ 正好命中 0011 第 3 节自检的断言：**math-plan 已 `free`，而 `vip-batch` / `vip-report` 仍是 `vip`
（没有误改其它工具）**。并且仓库 `0003_seed_tools.sql` 里写的就是 `free` ——
**仓库与线上现在已经一致，漂移消除。**

**跳转链路核对**（只看到 `free` 不够，三段都要过）：

1. `getToolByRoute()` 先过滤 `.eq("active", true)` → 线上 `active=True` ✅
2. `tool-page-shell.tsx`：`vipOnly = min_plan === "vip"` → 现为 `false`，`locked = false` → **不再 `redirect('/upgrade')`** ✅
3. `tools-db.ts` 的 `toToolView()`：`unlocked = !vipOnly || isVip` → `true`，`href` 就是 `/tools/math-plan` 本身 ✅

**结论**：`rolea-`（免费版）现在能打开工具页，页内 iframe 加载 `public/tools/math-plan.html`（97,294 字节）。
AI 分区润色仍走 `/api/math-plan/ai-sections` 的 `requireVip()` —— 即
「**工具本身 free（所有登录用户可开），只有其中的 AI 功能是 VIP 专属**」，
与 feedback / paper-analysis 口径一致。

> 无需补任何代码改动：0011 早在 `339d6f4` 就已提交进版本库。

### P2 · 网站层面（用户说另开任务）

`/dashboard`（4,121 字节）与 `/tools`（1,387 字节）**共用同一个 `@/components/tool-grid`**，
数据来源也相同（`getToolViewsForMembership` + `getCurrentUserWithRole` + `getMembership`）。
差异只有：dashboard 多了会员状态卡（`PLAN_LABELS`/`remainingDays`）+ `SignOutButton`。
→ 可以从 `/tools` 改造成"个人中心"（挂上会员卡 + 退出），dashboard 改成 redirect，消除重复。**未动代码。**

### P3 · 其它已知项（**代码侧只剩这两条**，其余均已闭环）

- 模板是否补「咨询师」标签（见第三节末）。**需先定需求**：保持留白给老师手填，还是补标签格。
  改模板要连带重跑 `build-template.py` + `math-plan-template` 套件。
  **（用户已决定：保持留白，不做。）**
- **AI 模型名隐患**：`DEFAULT_MODEL = "deepseek-chat"` 官方已停用但实测仍兼容
  （`route.ts:29`，**核对过仍未被改**）—— 详见第九节「已知隐患」。**AI 突然报 502 时先查这一行。**
  推荐做法：在 Vercel 加环境变量 `AI_MODEL=deepseek-flash`（代码是 `process.env.AI_MODEL ?? DEFAULT_MODEL`），
  以后换模型连代码都不用动。**（用户自己去 Vercel 加，不改代码。）**

> ✅ **`{{method}}` 三轮叙述的措辞已于 2026-10 润色完成**（原为 P3 待办）。
> 现状：句首「复习节奏上分 N 步走：先用…课时…；再用…；最后…。」（N 动态 = 轮次数）。
> 改之前请先读清下面三条 —— 其中第 1 条**推翻了本节旧说法**：
>
> 1. ⚠️ **`roundsSentence` 不进 AI，也不与 `samples.ts` 打架**（旧版本节说「动它要连带看 samples.ts」，
>    那个因果**不成立**，已实测核对）：
>    · 这句是**只在导出/payload 时**拼上去的（`math-plan.html` 的 `exportWordTemplate` 与
>      `MathPlanHooks.buildPayload`），**从不写进 `#methodBody`**；
>    · 而 AI 润色只处理 `#methodBody` 里的 **6 个带小标题的段落**（（1）方案与总量 …（6）目标），
>      `rounds` 虽在 context 里，但它不在 `paragraphs` 里，提示词也只要求「逐段润色」——
>      所以 AI **根本不会写三轮节奏**，不存在「示例与提示词打架」。
>    · 顺带核实：`samples.ts` 里**没有**本工具的轮次名与 ACT 动作短语（`grep` 过：它出现的
>      「一轮」全都指**学生学校的**一轮复习），那套名字的唯一来源是 `math-plan.html` 的 `threeRounds`。
> 2. **仍只改串词、不改数据口径** —— 轮次名与 `ACT` 六个动作短语是工具内部权威口径
>    （来源 `threeRounds`），改动会让屏幕课表的分轮与叙述对不上，别顺手改。
> 3. **句首不要自己再补一句开场话术** —— `ACT` 短语自带动作（`基础过关` 那条就是「逐模块补齐基础…」），
>    再写一句会撞成「把基础逐模块过一遍，逐模块补齐基础…」（本轮真踩过，已加断言防回归）。
>    推进感由连接词（先用…；再用…；最后…）承担。
> 4. 句首用「**步**走」而不是「三轮」：`<100h` 的轮次名是「基础过关/专项突破/真题模拟」，本来就没有
>    「一轮/二轮」字样，说「三轮」会和新高三那套「一轮补基础…」的口径混在一起。

---

## 八、回归测试清单（改完必须全绿）

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `tests/math-plan-template.test.mjs` | **82** | 模板完整性（278 占位符 / 逐格映射）、动态行（20/67/80）、格式不变、统一字体、手填区不动、method 拼接、**R4 辅导时间不重复**、可重复导出、**三轮叙述措辞（「分 N 步走」+ 防重复动作短语 + 两轮时不说「三轮」）**（2026-10 由 76 → 82） |
| `tests/math-plan-lessons.test.mjs` | **44** | 必开模块、done 豁免、最小课时、三轮口径与排序、极端场景、**m41 位置（三条规则）**、**自检「目标量化」（6 个预设全跑 + 不合格时点名到行）** |
| `tests/math-plan-export-ui.test.mjs` | **18** | 真浏览器：脚本加载、**导出按钮只剩 1 个（旧版入口已删）**、**教材版本为「人教A版」**、真实导出、DEMO 落盘 |
| `tests/math-plan-ai-sections.test.mjs` | **26** | AI 分区润色接口鉴权/入参/前端往返 |
| `tests/math-plan-ai-vip-path.test.mjs` | **17**（静态计数，见下） | **补记（原清单漏了这套）**：用**假 `AI_KEY`** 另起一次服务，验证「VIP + 有 Key」之后的路径 —— 无 Key → 503；假 Key → 502（**不是** 503）、上游错误原文不透传、Key 绝不回传前端；有 Key 后入参校验分支才真正可达，故另补 5 条 400 |
| `tests/math-plan-ai-apply.test.mjs` | **20** | **★补上的测试缺口**：自带**本地桩上游**（`AI_BASE_URL` 指向 `127.0.0.1:4567`），让「AI 返回写回 DOM」这一步**真的被执行**。断言：method 6 段的小标题各只出现 1 次、goals 40 格全部落地、请求体里 method 要求「只输出正文」、goals 带 `band` + 每行 `lv`、页面无 JS 异常 |
| `tests/math-plan-students.test.mjs` | **29**（阶段4 新增） | 真服务 + 真浏览器：选学生带出信息（含**清掉上一位残留**）、**只存身份字段**（点名查方案参数 + `extra` 里不许有数字值）、刷新不丢、**两家工具的 `extra` 键同时活着**、`import` 的 `tool` 不许静默兜底、**本机模式（`file://`）行为一行没变**。⚠️ **它自己起 next start，会杀 3000 端口** |

**合计：7 套 236 项。**（82 + 44 + 18 + 26 + 17 + 20 + 29）

> **数法说明（`b249a02` 复核）**：这套测试**不用 `test()`/`assert`**，而是自带 `ok()` 收集器
> （`results.push(...)` + 末尾打印 `SUMMARY: N/M passed`）。所以：
> - **`results` 长度才是项数**，`grep -c "ok("` 数出来的是**调用点**，会偏小 ——
>   静态数得 `template`=60、`lessons`=44，而报告记的是实跑值（现在是 82 / 44）。
>   差额来自**循环里逐项调用**的断言（同一行代码跑多次、每次记一条）。
> - **想拿到真实项数，只能实跑看 SUMMARY 行**，不要用 grep 数。
> - 本文的 82 / 44 / 18 / 26 / 17 / 20 / 29 是**实跑记录**，不是静态计数。

> ⚠️ 为什么必须有 `ai-apply`：另外两套 AI 测试**都到不了落地那一步** ——
> `ai-sections` 本地无 Key → 503，`ai-vip-path` 假 Key → 502，**替换逻辑根本不会执行**。
> 所以「小标题写两遍」这种 bug 在 172 项全绿的情况下照样漏到了线上。
> **凡是「只有成功返回才会走到」的代码，都必须用桩上游把它压到。**

> ⚠️ 原文只列了 4 套就写「合计 155 项」——**155 是 4 套的数**，第 5 套 `math-plan-ai-vip-path` 当时被漏在清单外
> （只在第九节「免 Key 验证技巧」提了一句）。数套件时别按 4 套算。

**⚠️ 第 5 套的两个坑（补记）**：

- 它的 **17** 是 happy-path 断言数；**2026-10 已实跑通过 17/17**（跑它需要 `pnpm build` + 真服务）。
  若中途某项登录失败，实际记录数会**少于** 17；失败时还会多记 1 条「测试执行未异常中断」。
- **它会先把 3000 端口上的监听进程 `Stop-Process -Force` 杀掉**（脚本开头就干这事）。
  所以跑它之前**先关掉你自己的 dev server 或另一个真服务套件**，否则两边互相踩。
  它还会起两个独立 Edge profile：`.edge-profile-mp-vip`、`.edge-profile-mp-vip2`。

跑法（用 bundled Node）：

```powershell
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tests\math-plan-template.test.mjs
```

**另有四个需要真服务的套件**（会自己起 next start，端口 3000）：
`math-plan-export-ui` / `math-plan-ai-sections` / `math-plan-ai-vip-path` / `math-plan-ai-apply`。
跑之前先 `pnpm build`。
（`ai-vip-path` 会**杀 3000 端口**，`ai-apply` 会同时占用 **4567（桩上游）**，别和其它真服务套件同时跑。）

⚠️ 跑法注意：**连续跑多个需要真服务的套件时偶发 1 项失败**（登录/会话时序抖动），
重跑即过；判断是否真失败要看能否稳定复现。

---

## 九、环境与账号（重要）

| 项 | 值 |
|---|---|
| 测试账号分工 | **`roleb-` = VIP（会员版，剩 30 天）**；**`rolea-` = 免费版（admin 但非会员）** |
| AI Key | 本地 `.env.local` **无 `AI_KEY`** → 接口返回 503；`rolea` 调则 403 |
| 免 Key 验证技巧 | 用**假 `AI_KEY`** 另起一次服务，可验证「503 之后的链路」（上游用假 Key 拒绝 → 502）。**已固化为第 5 套测试 `math-plan-ai-vip-path.test.mjs`（见第八节）** |
| 构建 | `pnpm build`（Turbopack）；构建后 `/api/math-plan/ai-sections` 应出现在路由表 |
| 浏览器测试注意 | 必须 `next build` + `next start`（dev 模式 hydration 有问题） |
| GitHub 网络 | `github.com:443` 偶发连接重置（`api.github.com` 正常），push 需重试 |
| **Git 可执行文件** | **`D:\my-website\.tools\git\cmd\git.exe`**（v2.56.0）。**不在 PATH 上** —— 直接敲 `git` 会报 `CommandNotFound`，必须写全路径调用 |

### 已知隐患：`AI_MODEL` 默认值 `deepseek-chat` 已被官方停用（但实测仍能用）

| 项 | 内容 |
|---|---|
| 位置 | `src/app/api/math-plan/ai-sections/route.ts` → `const DEFAULT_MODEL = "deepseek-chat"` |
| 官方口径 | DeepSeek 更新日志：`deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 停止使用**（2026-04-24 公告、三个月后生效）。当前模型名是 **`deepseek-flash`**（V4.1 Flash）与 `deepseek-v4-pro`；官方只承诺兼容路由 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`，**没有承诺兼容 `deepseek-chat`** |
| 线上实况 | Vercel 上**只设了 `AI_KEY`**，没有 `AI_MODEL`、也没有 `AI_BASE_URL` → 实际走的就是这个默认值 |
| 实测 | **目前 AI 功能仍能正常使用** → `deepseek-chat` 事实上仍被上游兼容路由（属未公告的兼容） |
| 结论 | **暂不改**（能用就先不动）。但这条兼容随时可能被撤，故记为已知隐患 |

**⚠️ 排查口诀：如果哪天 AI 润色突然开始报 502「AI 服务暂时不可用」，第一件事就是检查这一行，改成 `deepseek-flash`。**

改法（只改一个字符串）：

```ts
const DEFAULT_MODEL = "deepseek-flash";   // 原值 "deepseek-chat"（已于 2026-07-24 官方停用）
```

或者更稳：**在 Vercel 上加环境变量 `AI_MODEL=deepseek-flash`** ——
代码里是 `process.env.AI_MODEL ?? DEFAULT_MODEL`，会优先用环境变量，以后换模型连代码都不用动。

> 注意：502 不只这一个原因，也可能是 `AI_KEY` 失效/欠费，或上游故障。
> 服务端日志 `[math-plan/ai-sections] 上游返回 <状态码>` 会记录真实原因（前端看不到，是故意的）。

### 工具链注意事项（本仓库特有，踩过）

- **`glob` 工具在本仓库不可靠，不要凭它的空结果断定「文件不存在」。**
  实测 `docs/**`、`public/tools/*.html` 都返回过**空结果**，但文件其实都在
  （`public/tools/math-plan.html` 97,294 字节、`docs/math-plan-template/*` 三个 docx 都在）。
  → **改用 `Get-ChildItem`（pwsh）+ `grep` 交叉核对。**

- **`Get-Content` 在本机对 UTF-8 文件不可靠**（数行、比对文本都别用它）。
  本机的 shell 实际是 **Windows PowerShell 5.1.19041（Desktop 版，不是 pwsh 7）**，
  `Get-Content` 默认按 **ANSI/GBK 解码** UTF-8 文件，后果有两个：
  **① 中文乱码；② 换行被吞、行数偏少。**
  实测：`samples.ts` 被数成 **273 行**，真实是 **295 行** ——
  用字节复核是 295 个 LF、0 个 CR、无 BOM，与 `git diff --stat` 的 295 条插入完全一致。
  → 要数行 / 精确比对文本：用
    `[System.IO.File]::ReadAllBytes()` + `[System.Text.Encoding]::UTF8.GetString()`；
  → 或者更省事：直接用 **`read` / `grep` 工具**（它们按 UTF-8 处理，不会乱码）。
  → **推论**：命令输出里看到中文乱码，**先怀疑是 shell 解码问题，不要断定文件坏了** ——
    本轮就因此差点误判 `samples.ts` 被写坏。

- **`git` 不在 PATH 上**，一律用全路径调用：

  ```powershell
  & "D:\my-website\.tools\git\cmd\git.exe" -C D:\my-website\my-toolbox log --oneline -5
  ```

- 万一 git 用不了，**直接读 `.git` 里的文件也能拿到历史与推送状态**（本轮验证过）：
  - 提交信息：`.git\logs\HEAD`（每行最后一列就是 commit message）
  - 本地分支：`.git\refs\heads\main`；远端：`.git\refs\remotes\origin\main`
  - **两者哈希相同 = 已推送**（核实时 `main` 与 `origin/main` 都是 `b249a02`，所以确认已推送；
    上一版报告核实的是 `0b4126f` —— **这行只是「怎么核实」的示范，别把哈希当结论，现场重跑一次**）

- **线上 `tools` 表可以用 anon key 直查**（`min_plan` / `active` 等公开字段），**不需要 service_role**，
  命令见第七节 P1。这是核对线上权限口径最快的手段，别再因为「没有 service_role」就放弃核对。

---

## 十、设计约束（不要破坏）

- **模板格式 100% 一致**：只能做「文本替换 + 整行增删」，**绝不自己拼 `tcW`/`tblGrid`/`tblPr`/边框**
- **AI 改写后立刻导出要用最新文本**：导出时**从 DOM 现取**（`#methodBody` 的 `innerText`、`#goalsBody` 的 `[data-goal]` 单元格），不要用生成方案时的快照
- 旧版导出 `exportWord()`（HTML 转 .doc）**函数保留在代码里**，但 UI 入口（`#btnDocLegacy` 次级按钮）**已按需求删除**（2026-10）。要退回旧版：把按钮 HTML 加回来 + 恢复那行绑定（`math-plan.html` 里留了注释）
- 改模板后必须重新跑 `python public/tools/math-plan/build-template.py` 重新生成 `template-data.js`
- 不要碰 feedback / paper-analysis / membership 的文件

### ⚠️ 铁律：标签只能有一个来源（已经踩过两次，别再踩第三次）

凡是「**标签 + 值**」的内容（小标题、字段名、单位、前缀），**必须先明确由哪一端写标签，绝不允许两端各写一遍**。
两次事故的病根完全相同：

| | 第 1 次（模板导出） | 第 2 次（AI 改写落地） |
|---|---|---|
| 标签 | 「辅导时间：」 | 「（1）方案与总量。」 |
| 谁写了 | 模板那格**自带** + `buildMap` 又拼了一遍 | 前端保留 `<b>` 标签 + AI 提示词又要求「保留分条编号」 |
| 症状 | 导出成「辅导时间：辅导时间：春季」 | 正文成「（1）方案与总量。（1）方案与总量。…」 |
| 修法 | `buildMap` 里只填值（见第四节） | 提示词改为「只输出正文」+ 落地侧 `stripMethodLabel()` 幂等剥离（见下） |
| 为什么测试没抓到 | 只有真导出才暴露 | **两套 AI 测试都到不了「写回 DOM」那一步**（无 Key→503 / 假 Key→502），172 项全绿照样漏 |

**落地侧必须幂等**：即使上游不听话又吐了一遍标签，也要能剥掉再拼 ——
`math-plan.html` 的 `stripMethodLabel(line, label)` 就是这么做的（先按 label 精确比对，再用结构正则兜底）。

**判据**：写任何「拼标签」的代码之前，先问一句「**这个标签还有谁在写？**」答不上来就先别写。

---

## 十一、基准之后的 6 个提交（`b575362` → `b249a02`，**本报告已据此校准**）

> 上一版交接报告把「最新提交」写成 `0b4126f`，**实际已经到 `b249a02`**。
> 下面这 6 个提交都动过真实代码/测试/文档，读本报告时**必须并着这一节看**。

| 提交 | 标题 | 改了什么 |
|---|---|---|
| `84e537d` | AI 分区润色接入 few-shot 示例（4 份真实方案） | 新增 **`src/app/api/math-plan/ai-sections/samples.ts`（295 行）** 导出 `GOAL_EXAMPLES` / `METHOD_STYLE_BLOCK`；`route.ts` 导入并拼进提示词 |
| `01c5c92` | 教师输入框改为 placeholder 提示（去掉预填「郭庆杰」） | **只改 `math-plan.html`**：`#f-teach` 去掉 `value="郭庆杰"`。**推翻**本报告第四节之二原写的「默认值郭庆杰」 |
| `c211f5e` | 辅导方案修 4 处 + AI 量化校准 + 补 AI 落地测试 | `math-plan.html`、`route.ts`、**新增 `tests/math-plan-ai-apply.test.mjs`（230 行）**、`math-plan-export-ui.test.mjs` |
| `b249a02` | 自检目标量化修正 + 点名到行 + 文档同步 | `math-plan.html` 的 `selfCheck`：不再误报收尾行；不合格时点名「第 N 行「阶段名」」+ 总数；`math-plan-lessons.test.mjs` 补断言 |

**两处最容易踩的旧口径**：

1. **教师不再预填**（`01c5c92`）—— 老师忘填就是空，`{{tchr}}` 留白是**刻意取舍**，别当 bug 修回去。
2. **AI 提示词多了 `samples.ts` few-shot**（`84e537d`）—— 以后改 `{{method}}` 文案或 `roundsSentence`，
   **必须同时看 `samples.ts`**，否则示例与提示词口径打架。

**核对本报告是否还新鲜**（一行命令）：

```powershell
& "D:\my-website\.tools\git\cmd\git.exe" -C D:\my-website\my-toolbox log --oneline -3
```

若首行**不是** `b249a02`，说明又落后了：先跑
`git log --oneline b249a02..HEAD` 看多出来的提交，再决定要不要信本报告。
