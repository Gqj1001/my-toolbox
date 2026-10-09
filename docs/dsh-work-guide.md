# 跟用户配合的方式（每个新会话必读）

## 用户是谁
高中数学老师，**不懂代码**。所有代码操作交给 DSH。

## 沟通方式
- **大白话**，不要甩术语（"debounce"、"SSR"这种词要解释）
- 每做一步，说清：做什么、看到什么、不对怎么办
- 不要假设用户懂 git / 命令行 / Supabase 细节

## 工作节奏
1. **改代码前先给方案**，用户确认后再动手
2. **关键决策给选项**（A/B/C），不要自己拍板
3. **每步做完给结果**，用户确认后再进下一步
4. **不要一口气改太多**——真实 bug 和可选优化分两批

## 代码改动原则
- 每个真实 bug 修完，**加测试防护**（用户很在意"测试能不能真抓到 bug"）
- 提交前**跑全套回归**
- commit message 用户会看过再说
- **push 前停下**，用户去 Vercel 部署

## 安全边界
- **绝不要向用户索要**：service_role key、Vercel token、DeepSeek API Key
- 这些用户自己在平台后台填
- 测试账号：`roleb`=VIP、`rolea`=免费

## 项目全景
- 网站 `010034.xyz`（Next.js + Supabase + Vercel）
- 真正做出来的工具是 3 个：**辅导方案生成器、试卷分析、课后反馈**
  （`README.md` 与本文件旧版写的「已上线 5 个工具」是**过时**的，
  另外两个空壳已在 `0012` 迁移里下线。**以 `project-overview.md` 的表为准。**）
- **两个 DSH 会话分工**：
  - 工具会话：管 `public/tools/` 里的工具本身
  - 网站会话：管登录、会员、dashboard、路由、权限
- 不要跨会话改对方的文件
  （⚠️ 用户偶尔会**破例**授权一个会话全做完某件事 —— 那是他明确说的，
  不要自己扩大范围；**破例时他会写清约束**，照约束走，做完在报告里说明）

## ⚠️ 这个项目里踩过的坑（新会话务必先看，能省几小时）

### 1. 测试断言「硬编码某个数字」→ 迟早假红

实测踩过好几次：`=== 11`（出网次数）、`=== 1`（热请求）、
「响应里必须有某句话」（措辞后来变过）、「首次访问没走缓存」（依赖缓存是否恰好为空）。
**一条优化上线后，这些数字会合法地变化，测试就红了，而产品是好的。**
写断言时优先用**口径**（「没有变多」「不是本机版」「已进入云端态」），
必须写数字时留**区间**并注明为什么。

### 2. 仓库里**已经有一份**东西时，先找它，不要另写一份

`parseDisplayDate`（日期解析）、`historyByStudent`（历史装配）、
`studentsByName`（学生装配）、`debug-gate`（调试开关）、`ttl-cache`（缓存）
—— 这些都已经存在且被复用。**第二个来源**是这个项目反复踩过的坑
（注释里甚至专门写了「这个项目已经在『标签有两个来源』上踩过一次」）。

### 3. Next.js 的两个静默陷阱（都实测过）

- **`process.env.NODE_ENV` 会在构建期被内联成常量**。
  于是「在运行期设 `NODE_ENV=test` 来绕开生产判断」**根本无效**，
  而且那种判断失败方向是「关闭」→ 你会得到一个永远不生效的开关。
  **要用就用自己的环境变量**（如 `ALLOW_DEBUG_CACHE_CLEAR`）。
- **`.select()` 必须是单字面量字符串**。写成 `"a" + "b"` 拼接会让 PostgREST
  的类型推断退化成 `GenericStringError`，**编译期**报 TS2352。

### 4. Supabase 的几个真实行为（不是猜的）

- **`reuse interval` 内复用同一个 refresh token 会被判「泄露」→ 撤销整个会话**。
  症状就是用户说的「每次进网站都要登录」，而且看起来**随机** ——
  只在「access token 剩 < 90 秒」这个窗口里恰好有并发请求时才发生。
  ⚠️ **光把它调大不能根治**：要减少**并发刷新**本身（见下一条）。
- ⚠️ **`auth.getUser()` 自己会刷新，而且带重试**（2026-10 收口 A-2 时实测，最费时间的一条）：
  `GoTrueClient.__loadSession()` 在 `expires_at - now < 90 秒` 时会调 `_callRefreshToken()`，
  而 `_refreshAccessToken()` 内部**还带指数退避重试**（200/400/800…ms）。
  **`auth: { autoRefreshToken: false }` 挡不住它**（那个开关只管后台定时器）。
  后果：一个请求里的一次 `getUser()` 能放大成 **18–24 次** `/auth/v1/token`。
  **要校验会话就别用 `getUser()`，直接打 `/auth/v1/user` 带 Bearer**（实测 1 次 vs 18 次）；
  **要刷新就自己打 `/auth/v1/token`**（不重试），并且**让 auth-js 读不到快过期的会话**
  （把 cookie 的读取过滤一层，见 `src/lib/session-freshness.ts` 的
  `hideStaleSessionFromAuthJs`）。
  ⚠️ 但**只能过滤「读」，不能动「写」（`setAll`）** —— 登录/登出都靠它写会话，
  去掉会让**登录直接失效**（本轮踩过，两个套件立刻变红）。
- **auth-js 的去重是「实例级」的**：`refreshingDeferred` 和 `_acquireLock` 都挂在
  客户端对象上。服务端每请求新建 client ⇒ **跨请求零去重**。
  所以「并发 N 个请求 → N 次刷新」是默认行为，必须有**进程内单飞**才挡得住。
- ⚠️ **`perf-notes.md` 六之三曾说「中间件跑在 Edge，与页面侧内存不共享」——这句是错的**。
  2026-10 实测（Next 16.3.8）：中间件往 `globalThis` 写的东西，页面侧的 API 路由**读得到**，
  且 `EdgeRuntime` 未定义 ⇒ 实际是 **Node 运行时、同一个进程**。
  所以「两边共用一份缓存」是可行的（A-2 收口就是靠它）。
  ⚠️ 但**别把结论建立在内存共享上**：写代码时让「共享内存」只是**优化**，
  拿不到就自动退化成各查一次（`readAuthUser` 返回 `undefined` 就是这个语义）。
- **cookie 里的会话有「两种形状」**：正式的是 `base64-<base64url(JSON)>`（还可能切片成
  `.0`/`.1`），但**测试与手写的 cookie 常常是 URL 编码的 JSON 明文**。
  只认 base64 会让后者全部变成「未登录」→ 401（本轮把 `paper-analysis` 从 56/56 打到 12/21）。
- **`not null` 的 jsonb 列不能写 `null`**：会撞 23502。
  症状很迷惑 —— **新建**行 500、**更新**已有行却正常（因为有旧值）。
  正确做法是「没有值时**省略这个键**」，让数据库默认值生效。
- **`upsert`（PostgREST）是整行覆盖**：payload 里没带的列会被写成 NULL。
  同一行要被多个工具共用时，这会造成**静默的数据丢失**；
  要么用合并语义（先读旧行），要么把 payload 补全。

### 5. 「先显示缓存」类的优化，测试必须钉住「仍然拉了新数据」

最危险的失效方式不是「慢」，而是**静默不再更新**（或者**静默变空**）。
`unstable_cache` 那次就是：页面不报错、只是什么都没有。
所以这类改动一定要有「**确实发了真实请求**」和「**缓存命中时数据不为空**」两条断言。

### 6. 改中间件 = 改全站鉴权入口，风险最高

- 改完必须跑 `tests/middleware-cache.test.mjs`（含「第 2 次 `user_roles` 归零」
  与「关掉开关后仍会查」两条钉子）。
- 想测「token 快过期」这类场景，用 `tests/_helpers.mjs` 的
  `sessionCookieExpiringIn()` —— 它**只改 `expires_at`**，
  `access_token`/`refresh_token` 仍是真 token，所以行为是真的、也能被计数。

### 7. 别信「本机毫秒数」

本机到 Supabase 只有约 90ms，用户环境 400–500ms。
**看调用次数，不要看毫秒**（本文件与 `perf-notes.md` 都强调过）。
耗时断言要么不做，要么留很宽的区间。

## 开工前先确认的路径与命令（省得第一步就卡住）

| 项 | 值 |
|---|---|
| **工作目录 vs 仓库** | 工作目录可能是 `D:\my-website`，但**仓库在子目录** `D:\my-website\my-toolbox`。文档里的相对路径（`docs/...`、`tests/...`）都是**相对仓库根** |
| git | `D:\my-website\.tools\git\cmd\git.exe`（**不在 PATH**，要用全路径调用） |
| node（跑测试用） | `C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| 跑测试前 | 先 `next build`（这些套件跑在 `next start` 上，不是 dev） |
| 跑单个套件 | `& "<上面的 node>" tests\<套件名>` |
| 推送 | 先 `git push origin main`；若 `github.com:443` 不通，用 `node scripts\push-via-api.mjs` |
| 浏览器自动化 | 用 CDP + 无头 Edge；`tests/_helpers.mjs` 已有现成的登录/导航/求值工具，**别重写** |

> ⚠️ **有些套件会杀掉 3000 端口**
> （`feedback-data-cache.test.mjs`、`feedback-client-cache.test.mjs`、
> `students-unified.test.mjs`、`admin-grant90.test.mjs`、`middleware-cache.test.mjs`、
> `math-plan-students.test.mjs`（阶段4 新增）等会自己起 `next start`）。
> **它们不能并行跑**，要一个一个来；需要外部服务器的套件（`step7-api`、`step7-ui`、
> `verify-checklist`、`paper-regression` 等）则要先自己起好 3000。

> ⚠️⚠️ **2026-10 本轮实测过一次「假红」，务必记住**：两个 runner **同时**用 3000 时，
> `ai-thinking-mode` 直接变成 **0/11** —— 它起服务时带了假 `AI_KEY`，
> 而请求被**别人的**服务回答了，回来 503「服务端未配置 AI Key」。
> 结论：**看到端口类失败（503 / 连不上 / 一半 PASS 一半怪错误），先怀疑"是不是有别人占着 3000"，
> 再怀疑代码。** 一次只跑一个 runner。
>
> 需要外部服务的 6 套 + 自带服务的 1 套已经固化成脚本，照顺序跑就行（它会先把 3000 等空）：
>
> ```powershell
> & "<bundled node>" tests\_run-ui-suites.mjs
> ```
>
> 它会实时回显、逐套落日志到 `.tmp-planning-samples/ui-suite-logs\`，并在末尾汇总哪几套不干净。

## 用户会做的操作
用户可以自己：
- 在 Vercel 看 Deployments 状态
- 在 Supabase SQL Editor 跑 SQL
- 在网站 `/admin` 开会员
- 在 Word 里打开导出的 docx 对比格式
- 给你截图或报错信息

用户不能做：
- 读代码、改代码
- 分析日志、定位 bug
- 用命令行（除非你给逐字命令）