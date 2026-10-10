# 下个会话待办

> 更新时间：2026-10（**第一批：空壳工具口径对齐 + 非法日期 500 修复 + vision-scores 防回归**）。
> **已完成的条目已删除**，这里只剩还没做的。
> 配套阅读：`docs/project-overview.md`（现状总入口）、`docs/dsh-work-guide.md`（配合方式）、
> `docs/perf-notes.md`（性能完整记录）。
>
> 每条都写了「为什么」和「怎么验」，**不要只照标题做**。

---

## 1. ✅ 阶段 4：math-plan 接入统一学生 API（**已完成 2026-10**）

> 这一条做完了，**不要再做一遍**。留下的结论与新待办见下面「已完成」与「1b」。

### 已完成（做了什么）

1. `public/tools/math-plan.html` 的「① 学生与考区」多了一排**已保存学生的小圆片**
   （点一下带出 年级/校区/教师/学段/教材/考区）+ 一个「💾 保存档案」。
   **只在 `/tools/math-plan.html` 下出现**（双击 HTML、放到别的服务器上行为不变）。
2. 数据层照 paper 的模板抄：`CLOUD_STORE`（`loadAll` / `deleteStudent`）+
   `persistStudent`（**唯一的写入口**）/ `removeStudent`。
   ⚠️ 刻意**没有**在 `CLOUD_STORE` 里再放一个 `saveStudent` —— 那会变成
   「同一件事有两个来源」（本项目反复踩过的坑），迟早有一份忘了合并 `extra`。
3. **只存学生身份**：`name/grade/campus/teacher` + `extra` 里的 `phase/book/exam`。
   分数 / 目标分 / 课时 / 频次 / 薄弱模块 / 已完成模块 / 备注 **一个都不进档案**
   （它们是「这一次方案」的参数）。测试有双重防护：点名查这些键，
   **并且**断言 `extra` 里没有数字型值（身份字段全是字符串）。
4. ⚠️ **`extra` 是整块替换、不是按键合并** —— 合并语义只保护顶层列。
   所以 `persistStudent()` 先 `loadAll()` 读回旧行、展开旧 `extra`，再盖自己的三个键。
   少了这一步，老师用一次辅导方案就会把 paper 的 `extra.cls` 抹掉
   （有变异测试证明这条断言真的会 FAIL，不是空过）。
5. 顺手修掉一个真实 bug（`src/app/api/students/route.ts`）：
   `op:"import"` 的 `tool` 原来是「缺省按 paper」→ 会把**将来接进来的工具**的数据
   **静默标成 paper**（接口 200、归属错、不报错）。现在白名单外的值一律 400，
   混着传时「好的进、坏的条数如实报」(`rejectedTool`)。`tests/math-plan-students.test.mjs`
   与 `tests/students-unified.test.mjs` 都钉住了。
6. 顺手把左侧底部那句「不上传任何数据」改成实话（点保存会上传学生身份，
   但不上传分数/课时）—— 原文与实际行为不符。

### 测试

- 新增 `tests/math-plan-students.test.mjs`（29 项，真服务 + 真浏览器）：
  选学生带出信息、**只存身份字段**、刷新不丢、**两家工具的 `extra` 键同时活着**、
  `import` 的 `tool` 校验、**本机模式（`file://`）行为一行没变**。
  ⚠️ 它自己起 `next start`，**会杀 3000 端口**，别和别人并行跑。
- 扩 `tests/students-unified.test.mjs`：补「阶段4」组（两家工具的 `extra` 键同时活着、
  `import` 的 `tool` 校验）；合并语义组原样保留。**62 项**。
- 顺手把 `students-unified` 里两条**写死数字**的断言改成**相对口径**
  （见「怎么验」——这正是 `dsh-work-guide.md` 坑 1 说的那种假红）。

### 1b. `math-plan` 已登记为合法的历史归属（**已完成 2026-10**）

- 迁移 **`0016_history_tool_allow_math_plan.sql`**：把 `feedback_history_tool_check`
  从 `('feedback','paper')` 放开到 `('feedback','paper','math-plan')`。
  **用户已在 Supabase SQL Editor 里执行过**（重复执行也安全，脚本是 drop if exists + add）。
- 接口白名单 `ALLOWED_TOOLS` 同步加上 `"math-plan"`（`src/app/api/students/route.ts`）。
  ⚠️ 两边**必须一致**：只改库 → 接口 400；只改代码 → 写库撞约束（23514）。
  现在接口遇到约束没放开的情况会返回 **409 + 明确指向迁移文件名**（不再是一句「操作失败」）。
- math-plan 顶栏加了「📥 存入档案」：**手动点**才把这一次方案写进该学生档案
  （用户选的手动，避免生成十几次存出一堆垃圾）。正文含
  【学情诊断】【提分目标】【课时安排】【逐次课表】【学习特点】，
  并带 `title`（学段+「辅导方案」）与 `score/full_score`（供以后看趋势）。

### ⚠️ 1c. 仍然留着的两件（**不在本轮范围**）

| # | 事项 | 说明 |
|---|---|---|
| a | 接口层的 `extra` 仍是整块替换 | 现在靠**每个工具自己**先读旧值再合并。将来若要根治，应当让服务端把 `extra` 也做成**按键合并**（或在 `buildStudentRow()` 里合并 `extra`），这样任何工具少写一句都不会踩别人。 |
| b | 学员档案还没有「按学情分析」 | 用户明说「现在只做管理」，**生成整体学情分析是以后的事**。现在只是把记录收集齐、能按学生看。 |

---

## 2. `/tools` 改个人中心（**已完成 2026-10**）+ 百宝箱改「学员档案」（**已完成 2026-10**）

> ⚠️ **原方案作废**：这条原来是「`/tools` 挂会员卡 + `/dashboard` 改成自动跳转，
> 消除两页重复」。用户 2026-10 明确改口：**百宝箱不删了，要把它做成「学员档案管理」页**
> （把每个学生的辅导方案 / 试卷分析 / 反馈收集到一处，**只做管理**；
> 「生成整体学情分析」是以后的事）。所以两页是**各有各的活**，不再合并。

### ✅ 已完成：`/tools` = 个人中心（2026-10）

| 做了什么 | 细节 |
|---|---|
| 新增会员状态卡 | `src/components/membership-card.tsx`：邮箱 / 会员等级 / 剩余天数 / 到期日 / 管理员标识 / 查看会员权益 / **退出登录** |
| 顶栏精简 | `site-header.tsx` **只留导航**（+ 管理后台入口）。邮箱、会员徽标、退出按钮全部移走 —— 原来它们和 `/dashboard` 正文各显示一遍 |
| 顺手省一次查询 | 顶栏不再查 `getMembership()`，每个页面少一次会员查询（`role` 仍由调用方传入，用于显示「管理后台」入口） |
| 导航只留一个入口 | 去掉重复指向同一处的「百宝箱」链接（档案页上线后再加回「学员档案」入口） |
| 落点全部改到 `/tools` | `/` 首页、登录后、`/upgrade` 的「已是会员」、**非管理员被挡**（`?error=admin_required`）、管理员自我降级（`?error=self_demoted`）。以前这些落点都是 `/dashboard` |
| 过渡期保护 | `/dashboard` **一行没动**，并加了一条临时断言「它仍可访问、不是空页」，避免改造期间被弄坏 |

### ✅ 已完成：百宝箱 = 学员档案管理（2026-10）

用户选的定位：**能看又能改**。已做：

| 做了什么 | 细节 |
|---|---|
| **名单页** | 学生列表（每人显示 年级/校区/教师 + 记录条数）+ 姓名搜索 + **新建学生** |
| **详情页** `/dashboard?name=xxx` | 学生信息 + **全部记录**（按工具分组：辅导方案 / 试卷分析 / 课后反馈）+ 展开全文 |
| **修改** | 每个字段配一个「改」勾选框：**勾了才提交**（勾上留空 = 明确清空）。⚠️ 不用「留空＝不改」——那样「清空校区」永远做不到 |
| **删除** | 二次确认，明说「会连同三个工具里这个学生的记录一起删除」 |
| **顶栏入口** | 加回「学员档案」（原来故意没放） |
| **写入口** | `src/app/dashboard/archive-actions.ts`：三个 Server Action，**全部复用** `feedback-db` 的 `upsertStudent()` / `deleteStudentByName()`，不另写一套 |

#### ⚠️ 本轮踩到并修掉的三个真实 bug（都很难查，记录一下）

1. **新建表单什么都没存进去**：`createStudent` 用了「修改」的解析器，而修改要求
   `change_<字段>` 勾选框 —— 新建表单没有勾选框，于是三个字段**一个都没写**，
   页面还跳转成功（静默失败）。→ 拆成 `newStudentPatch()` / `patchFromForm()` 两个解析器。
2. **`/api/students` 读的是 25 秒缓存，看不到刚写的数据**：Server Action 里的
   `invalidateStudents()` **清不掉 Route Handler 那份缓存**（不在同一个执行上下文里传失效信号）。
   症状：档案页显示正常（它是直读），但 `/api/students` 返回 `count:0` ——
   三个工具拉档案时看不到这个学生，最长 25 秒，看起来就是「保存了没生效」。
   → 该接口与档案页**都改用 `getStudentsFresh()` / `getHistoryFresh()`（直读、不缓存）**。
   工具页仍用缓存版（它们读写在同一会话里，写完自己失效，缓存收益是实打实的）。
3. **构建期一行误导日志**：`/` 是静态预渲染 + 它 redirect 到 `/dashboard`，
   于是构建期真的去查了一次库，抛出 "Dynamic server usage" 被 `softFail` 接住并打成
   一行**像故障**的日志（构建结果其实是对的）。→ `/dashboard` 显式 `export const dynamic = "force-dynamic"`。

> 测试：新增 `tests/archive-students.test.mjs`（17 项，真服务 + 真浏览器，含
> 「不勾框不提交」「勾框才改」「删除连带记录」）。

---

## 3. ✅ vision-scores 启用态测试（**已完成 2026-10**）

> 用户 2026-10 已实机自测「符合预期」；本轮按下面的清单把**防回归**补上了。
> **做了什么**：新增 `tests/vision-scores.test.mjs` —— 起本地桩冒充 `{baseUrl}/chat/completions`，
> 用 `AI_VISION_BASE_URL` 指过去（**产品代码一行没改**），并**分两阶段起服务**
> （阶段① 不配 `AI_VISION_MODEL` → 验 503；阶段② 配 `deepseek-flash` + 桩 → 验其余 4 条）。
> 5 条断言全部落地，另加「桩真的被打了」「图片 data URL 原样透传」「Authorization 头没断」**防假绿**。
> 详见下方清单与 `docs/perf-notes.md` / `tests/vision-scores.test.mjs` 的头部注释。


> 用户原话：「对于 1 来说，已经测试完毕，结果不错，符合预期。」
> 所以这条**降级为可选**：功能侧已被用户认可；下面这些断言的价值在于**防将来改坏**
> （尤其是那条「模型名不含 deepseek 就不能带 thinking」——改成无条件带会直接 400）。
> 有空再补，不要当成阻塞项。

**为什么值得补**：答题卡识别的**路由与前端都完整**（逐项查过，见下），
但**「启用之后」那条路径从来没有被执行过** —— 现有测试只覆盖两条降级路径。
**你配好 `AI_VISION_MODEL` 打开开关那一刻，是这条路径第一次真正跑起来。**

### 已经查过、**不需要改**的部分

| 项 | 结论 |
|---|---|
| `src/app/api/paper-analysis/vision-scores/route.ts` | 235 行，完整 |
| 入参 / 出参 | `{image:"data:image/...", questions:[...], model?}` → `{ok:true, scores:[{no,got}]}` |
| thinking 护栏 | ✅ **只有模型名含 `deepseek` 才带** `thinking:{type:"disabled"}`；另有 `AI_VISION_SUPPORTS_THINKING=0` 紧急开关 |
| 错误处理 | 401 / 403(非会员) / 403(封禁) / 503(未配模型，给明确提示) / 413 / 400 / 502 / 超时；思考吃光预算会重试一次 |
| 图片位置 | ✅ 只放 **user** 消息（官方要求：放 system/assistant 会 400）—— 核对过官方文档 |
| 前端 `photoRun()` | ✅ `public/tools/paper-analysis/js/app.js`；按钮 `index.html:129`；API 路径正确 |
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

## 4. ✅ feedback.html「下载 10 秒」—— **已结案（2026-10，根因是本机代理）**

**用户报的现象**：`feedback.html` 42.8 KB，Content download 花了 **10.31 秒**
（等待服务器响应只有 504ms）。

**用户提供了两份 HAR（Chrome + Edge，桌面）后定位到根因**：

> **不是服务器、不是 CDN、不是代码 —— 是用户电脑上的代理软件**
> （`D:\狮子云\shiziCore.exe`，系统代理 `127.0.0.1:7890`）**把网站流量绕出去了**。

证据（用 `tests/_analyze-har.mjs` 跑出来的，脚本已留在仓库里）：

| 证据 | 数值 |
|---|---|
| 所有请求的「远端 IP / 连接」 | **全部是 `127.0.0.1` : `7890`**（Chrome 16/16、Edge 52/60） |
| `feedback.html` 耗时分解 | 等待服务器 **411ms**（`x-vercel-cache: HIT`、`server: Vercel`、香港 hkg1）+ **下载 2987ms** |
| 实测下载速度 | 约 **56 KB/s**（与用户报的 4–43 KB/s 同量级） |
| Chrome 那份更夸张 | 三个 **8–14KB 的小 JS**，光「等待服务器」各等了 **9.2–9.6 秒** |
| 同页对比 | `/admin` 60KB 用 494ms、`_next` 224KB 用 873ms —— **时快时慢，典型代理链路特征** |

**结论**：服务器只用 411ms，慢的全在「绕行那一趟」。**别再查服务端了。**

**给用户的做法**（已交付）：
- ✅ 在「狮子云」里把 **`010034.xyz` 加入直连/绕过代理名单**（不要去手改系统代理开关，
  「狮子云」下次启动会覆盖）
- 加完再用 F12 → Network 复测 `feedback.html`，掉到 1 秒内即彻底结案
- 可能还要一起加 **Supabase 域名**（它同样被绕行，影响工具的跟手程度）

> ⚠️ 判断口径：以后凡是「某个文件下载慢、但服务端首字节很快」，
> **先看 HAR 里 `serverIPAddress` 是不是 `127.0.0.1`** —— 一眼就能排除服务器。
> 分析脚本：`& "<bundled node>" tests\_analyze-har.mjs "<har 路径>"`

---

## 5. 全学科扩展（等触发条件）

从**物理**试水（与数学最接近），跑通后把「科目配置」抽出来，再横向复制到其他学科。
详细清单见 `docs/other-subjects-plan.md`。
**触发条件**：有物理老师主动要，或数学用稳 2–3 周。依赖：每科要 10–15 份学科网报告。

---

## 6. 其余待办（原清单里还没做的）

| # | 项 | 备注 |
|---|---|---|
| 7 | ✅ 空壳工具清理（**已完成 2026-10**） | 已核对：线上 `tools` 表里这两条确实 `active=false`（顺带确认 `vip-batch` / `vip-report` / `hidden-demo` 也是）；而**代码文件早就不在** —— `public/tools/` 从来**没有**这两个文件，它们的页面在 `d08be8b`（会员系统那一笔）就删了。所以**没有代码可删**，本轮只把 `README.md`、`project-overview.md` 里「文件还在 public/tools/」的旧说法改成事实 |
| 8 | few-shot 效果评估 | 触发条件：累计用 AI 润色 20–30 次后 |
| 9 | 深度优化 AI 润色（调温度/prompt） | 可选 |
| 11 | feedback 离线模式入口 | 可选（现在云端拉不到就是空页面，是**有意**的） |
| 12 | `DEFAULT_MODEL = "deepseek-chat"` 改 `deepseek-flash` | 已用 Vercel 的 `AI_MODEL` 覆盖，属技术债清理 |

**长期（现在不做）**：自动支付、会员使用统计、全站数据导出、多老师团队模式、更换服务器架构（国内备案）。

---

## 7. 已知问题（记录，修不修都行）

1. ✅ **非法日期会被原样写库 → 500**（`2026-13-45` 这种）—— **已修（2026-10）**。
   做法：`src/lib/date-input.ts` 三条分支共用**真日历校验**（不是只加 1–12/1–31 的范围校验，
   因为 `2026-02-30`、`2月30日`、非闰年的 `2026-02-29` 能过范围校验但库照样拒绝）。
   校验口径按**只读查询实测**对齐 PostgreSQL：接受 `0001-01-01` / `2024-02-29`，
   拒绝 `0000-01-01` / `2026-02-29` / `2026-04-31` / `2026-10-32`。
   防护在 `tests/date-input.test.mjs`：新增「有意分歧」组（老实现放行 / 新实现 null）、
   「反向防护」组（闰年与边界年份不被误伤）、以及端到端「**HTTP 200 + date 落成 null**」。
   完整记录见 `docs/perf-notes.md`「七、已知问题」第 1 条（已从"不修"改成"已修"）。
   （注：`2026年10月7日` 那类**不是**这个问题，阶段 3 已支持。）
2. **`tools` 表的建表语句不在仓库里**（只有种子数据），
   会员那三列（`plan`/`status`/`expires_at`）的加列语句也不在。
   **不要试图用仓库的 SQL 重建数据库。**
3. **换工具权限 / 下线工具没有后台界面** —— 只能去 Supabase SQL Editor 手工跑
   （照 `0012` 的写法）。改完最多 30 秒全站生效（`tools` 表有 30 秒进程内缓存）。
4. **这些套件会自己起 `next start`、并杀掉 3000 端口**，别和其它真服务套件并行跑：
   `feedback-data-cache`、`feedback-client-cache`、`students-unified`、`admin-grant90`、
   `middleware-cache`、`math-plan-students`、`date-input`、`paper-analysis-students`、
   `archive-students`、**`vision-scores`（2026-10 新增，起两次服务）**。
5. **`tests/step7-ui.test.mjs` 隔离弱点**：按关键词查全表，会被上次运行遗留数据污染。
6. **Edge 调试端口会被「幽灵监听者」占住**（2026-10 踩过一次）：
   `Get-NetTCPConnection` 列得出 9490 在监听、PID 却是个**不存在的进程**，
   新起的 Edge 绑不上 → 真浏览器套件统一报 `无法连接 Edge 调试端口`。
   **重启机器**即可（换端口也行）。不是代码问题。

---

## 8. 环境备忘（新会话不用再问用户）

| 项 | 值 |
|---|---|
| 仓库 | `D:\my-website\my-toolbox`（注意：工作目录可能是 `D:\my-website`，**仓库在子目录里**） |
| git | `D:\my-website\.tools\git\cmd\git.exe`（**不在 PATH**） |
| 线上 | `https://010034.xyz` |
| 测试账号 | `roleb`=VIP（`userEmail`）、`rolea`=免费/管理员（`adminEmail`） |
| 跑测试 | `C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe tests\<套件>`；**先 `next build`** |
| 推送 | 先 `git push origin main`；若 `github.com:443` 不通（会超时 300 秒），用 `node scripts\push-via-api.mjs` |
| 三份交接文档 | `docs/project-overview.md`、`docs/dsh-work-guide.md`、`docs/perf-notes.md` |
| 本文件 | `docs/next-session-todo.md` |

**全套回归现状（2026-10 第一批实测，26 个套件全绿 ✅，合计 802 项断言）**：

```
math-plan-template 82/82   math-plan-lessons 44/44   math-plan-students 37/37
math-plan-ai-apply 20/20   math-plan-ai-sections 26/26  math-plan-ai-vip-path 18/18
math-plan-export-ui 18/18  middleware-cache 13/13    verify-checklist 18/18
step7-api 39/39            step7-ui 36/36            ai-thinking-mode 11/11
paper-analysis 56/56       paper-regression 23/23    paper-score-edit 59/59
paper-score-report 15/15   paper-score-ui 36/36      paper-preset 18/18
paper-analysis-students 27/27
feedback-data-cache 26/26  feedback-client-cache 51/51
students-unified 64/64     date-input 15/15          admin-grant90 18/18
archive-students 17/17     vision-scores 15/15
```

> ⚠️ **以「刚跑完的那一次」为准，别照抄旧值**。本轮实测发现旧表有几处本来就**过期或漏项**：
> `math-plan-students` 实际是 **37**（旧表写 29）、`students-unified` 实际 **64**（旧表写 62），
> 而且**整个 `archive-students`（17 项）被漏掉了**。这正是 `dsh-work-guide.md` 坑 1 说的那类问题。
>
> 变化说明（2026-10 第一批）：`date-input` **11 → 15**（新增「非法日期有意分歧」
> 「反向防护（闰年/边界年不被误伤）」「端到端不再 500」三组）；
> **新增 `vision-scores` 15/15**（本地桩上游 + 分两阶段起服务，补上"启用态"这条从没被跑过的路径）。

> ⚠️ **一次只跑一个 runner；看到「端口类失败」先怀疑端口被抢**。
> 本轮我同时起了两个 runner，`ai-thinking-mode` 直接变 **0/11**（请求被别人的服务回答，
> 回来 503「未配置 AI Key」），而代码是好的。重跑就 11/11。
> 需要外部服务的套件已固化成 `tests/_run-ui-suites.mjs`（会先等 3000 空出来再跑）：

```powershell
& "<bundled node>" tests\_run-ui-suites.mjs
```

> ✅ `math-plan-ai-apply` 与 `verify-checklist` 上一轮**重启机器后已补跑通过**，
> 之前那次失败是 Edge 调试端口的幽灵监听者（见「已知问题」第 6 条），不是代码问题。
