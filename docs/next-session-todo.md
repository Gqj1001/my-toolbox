# 下个会话待办

> 生成时间：2026-10（本轮收尾时）。
> 配套阅读：`docs/project-overview.md`（现状总入口）、`docs/dsh-work-guide.md`（配合方式）、
> `docs/perf-notes.md`（性能完整记录）。
>
> 每条都写了「为什么」和「怎么验」，**不要只照标题做**。

---

## ~~1. viewer.ts 改造~~ ✅ **已完成（2026-10 本轮）**

**结论先行：原方案是错的，照它改会让情况变糟（实测 8 次 → 14 次）。**

原判断是「A-2 只压掉了中间件那一半，剩下 8 次来自页面侧 `getViewer()`」。
**真凶是 auth-js 自己**：`GoTrueClient.__loadSession()` 在 token 剩 < 90 秒时会去刷新，
而 `_refreshAccessToken()` **内部还带指数退避重试**；`autoRefreshToken: false` **挡不住它**。
实测 8 个并发请求最多炸成 **24 次** `/auth/v1/token`。

做法（见 `docs/perf-notes.md` **六之七**）：新增 `src/lib/session-freshness.ts`，
**绕开 auth-js 管理会话** —— 直连 `/auth/v1/user` 校验、直连 `/auth/v1/token` 刷新，
并让 auth-js **读不到**快过期的会话（`hideStaleSessionFromAuthJs`）。

| 场景 | 修复前 | 收口后 |
|---|---|---|
| token 还剩 1 小时 | 0 次 | **0 次** ✅ |
| token 只剩 3 秒（单请求） | 1 次 | **1 次** ✅ |
| **并发 8 个「快过期」请求** | **16 次** | **1 次** ✅ |

「留痕」断言已删除，换成真断言 `≤ 2 次`。

> ⚠️ **两条给后人的警告**（都实测踩过）：
> 1. **别把 Cookie 的「写」（`setAll`）也一并去掉** —— 登录/注册/登出都靠它写会话。
>    本轮先写成空实现，结果**登录直接失效**（`admin-grant90` 10/18、`feedback-client-cache` 2/4 抓出来）。
> 2. **别用 `supabase.auth.getUser()` 换掉直接校验**：本机实测 **1 次 vs 18 次**。
> 3. **`readSessionFromCookies` 必须同时认两种 cookie 形状**：正式的 `base64-<base64url>`
>    与松散格式（URL 编码的 JSON 明文 —— `tests/paper-analysis.test.mjs` 的 `signInCookie()`
>    就是后者）。只认 base64 会让那套件从 56/56 掉到 12/21。

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

## ~~3. 阶段 3：paper-analysis 接入统一学生 API~~ ✅ **已完成（2026-10）**

**做法**（`public/tools/paper-analysis/js/app.js`）：
- 新增 `CLOUD_STORE`（`loadAll / saveStudent / deleteStudent / deleteHistory / importHistory`），
  只在**云端模式**（`NEXT_HOST`）启用；本机版 / 自建 `server.js` 的部署**行为不变**。
- 四种写入集中到 `persistStudent / removeStudent / persistHistory / removeHistory`
  四个入口，调用点不再自己 fetch（避免「同一件事两个来源」）。
- 档案字段映射：本工具的 `cls` ↔ 表的 `class_name`，并同时写进 `extra.cls`。
- 历史映射：`tool='paper'` / `title=examName` / `score` / `full_score=full`。
- 首次进入：**弹窗问用户**（上传 / 以后再说 / 别再问），上传后**保留 localStorage**；
  只在「本机有数据 + 账号里还是空的」时才弹。
- 导入幂等；**日期解析不出来的条数如实报出来**（`dateUnparsed`）。

**日期归一化**：做了 **(a) 扩展解析器**（用户拍板的方案）——
`parseDisplayDate()` 新增「`2026年10月7日` → `2026-10-07`」分支（用它自己的年份）。
这是**有意改变行为**，`tests/date-input.test.mjs` 里那份老实现副本**保持原样**，
新增一组「有意分歧」断言把差异钉住。

**顺带补的接口**：`DELETE /api/students?id=<historyId>` —— 原来只有
`/api/feedback/data` 支持删单条历史，统一接口这边缺（paper 的「删一条」需要它）。

**测试**：新增 `tests/paper-analysis-students.test.mjs`（**27 项**，全绿）：
档案往返、合并语义（只发 grade 时 `class_name`/`extra` 不能被清）、
历史导入幂等、`tool/title/score/full_score` 映射、日期归一化、
`dateUnparsed` 如实报告、跨账号隔离、`DELETE ?id=` 不被 25 秒缓存"复活"、`DELETE ?name=` 连带历史。

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

**全套回归现状（2026-10 本轮实测）**：

```
math-plan-template 82/82   math-plan-lessons 44/44   ai-thinking-mode 11/11
middleware-cache 13/13     step7-api 39/39           paper-analysis 56/56
paper-regression 18/18     paper-score-edit 59/59    paper-score-report 15/15
feedback-data-cache 26/26  feedback-client-cache 51/51
students-unified 54/54     date-input 9/9            admin-grant90 18/18
math-plan-ai-sections 26/26  math-plan-ai-vip-path 17/17
math-plan-export-ui 18/18  paper-score-ui 35/35
```

> ⚠️ **两个真浏览器套件本轮没跑成**：`math-plan-ai-apply`（20/20）与 `verify-checklist`（18/18）
> 都停在 `无法连接 Edge 调试端口`。**不是代码问题** —— 在**未改动的基线**上跑同样报这个错。
> 原因是本机调试端口 **9490** 上残留了两个「幽灵监听者」（指向已死的 PID，
> `Get-NetTCPConnection` 正常列出、但连不上），新起的 Edge 绑不上这个端口。
> 处理办法：**重启一次机器**（或换端口）后再跑这两个套件即可。
> 其余 19 个套件全部全绿。

