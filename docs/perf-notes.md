# 页面性能：诊断、已做的修复、还剩什么

> 一句话：`/dashboard` 和 `/tools` 慢，是因为**一次页面渲染要等好几次数据库往返**，
> 而且等待期间**整页白屏**。第一批已修，实测首字节时间降了一半以上。
>
> 对应代码改动见 `docs/project-overview.md` 第七之二节；本页是完整记录，供后续复测与继续优化。

---

## 一、根因（按影响排序）

| # | 根因 | 说明 |
|---|---|---|
| 1 | `SiteHeader` 重复查会员 | `src/components/site-header.tsx` 自己调 `getMembership()`，而页面刚在上层查过一次；`getMembership()` 内部是「查用户 + 查角色」两次网络往返，**白做一遍** |
| 2 | 没有任何去重/缓存 | `getMembership` 与 `getCurrentUserWithRole` 各查一次用户、各查一次 `user_roles`（字段还不重叠），全仓库没有 `React.cache` / `unstable_cache` |
| 3 | 两段式瀑布 | 列表页先 `await` 会员信息，再 `await` 工具目录；工具页壳子 `getMembership → getToolByRoute → getCurrentUserWithRole` 三段全串行 |
| 4 | 没有 `loading.tsx` | 整页 SSR 必须等完所有往返才吐第一个字节 → 白屏 |

> 注：中间件（`src/proxy.ts`）每个请求也会查一次用户与 `user_roles`。
> 中间件**不在 React 渲染树里**，`React.cache()` 跨不过去，这一份省不掉。

---

## 二、已做的修复（第一批）

1. **新增 `src/lib/viewer.ts` 的 `getViewer()`**：一次 `auth.getUser()` + 一次
   `select("role, plan, status, expires_at")`，把原先两次查询合并；并套 `React.cache()`，
   使同一次渲染里**页面与顶栏都调它也只查一次库**。
2. **`getMembership()` / `getCurrentUserWithRole()` 改为薄封装**：返回结构完全不变，
   因此其余约 10 处调用点（admin、banned、upgrade、AI 接口等）**一行都不用改**。
3. **拆掉瀑布**：`/dashboard`、`/tools` 把 `getActiveTools()` 提到与 `getViewer()` 并发；
   `tool-page-shell.tsx` 的 `getViewer()` 与 `getToolByRoute()` 并发（**重定向顺序保持不变**）。
4. **补骨架屏**：`src/app/dashboard/loading.tsx`、`src/app/tools/loading.tsx`。

---

## 三、实测数据

测量方式：给服务端进程插桩（`NODE_OPTIONS=--require` 预加载一个包装 `fetch` 的脚本），
统计它对 `*.supabase.co` 发出的**真实请求次数**；浏览器侧用无头 Edge + CDP，
并**在请求层掐断 `next-router-prefetch` 预取**，避免预取污染「本页自身开销」。
（本机到 Supabase 延迟极低，量到的绝对耗时没有代表性，所以主指标用**往返次数**。）

| 页面 | 往返次数 改前→改后 | TTFB 改前→改后 | load 改前→改后 |
|---|---|---|---|
| `/dashboard` | 6 → **5** | 681ms → **291ms** | 735ms → **537ms** |
| `/tools` | 6 → **5** | 630ms → **259ms** | 706ms → **515ms** |
| `/tools/math-plan` | 14 → **12** | 728ms → **319ms** | 1611ms → **682ms** |

每次渲染剩下的往返（`/dashboard` 与 `/tools` 相同）：

```
proxy：            1 次 auth.getUser + 1 次 user_roles     ← 省不掉（中间件不在 React 树里）
页面 getViewer()： 1 次 auth.getUser + 1 次 user_roles     ← 已合并、已去重
页面 工具目录：     1 次 tools
```

`/tools/math-plan` 多出的部分是 **iframe 加载工具 HTML 时中间件又跑了一遍**（每页约 7 次往返）。

> **正确性已回归**：两批改动做完后，6 套测试全绿（`math-plan-template` 76、`lessons` 44、
> `export-ui` 18、`ai-sections` 26、`ai-vip-path` 17、`ai-apply` 20，合计 **201 项**）。

---

## 四、第二批：工具目录缓存（已做）

`tools` 表是全用户共享的固定目录（7 行，几乎不变），而 `/dashboard`、`/tools`、`/upgrade`
每次渲染都要它 —— 不缓存就是每次白跑一次外网往返。现已加 30 秒缓存。
**实测：连续两次请求，第二次查库 0 次**（预期再省 1 次往返）。

### ⚠️ 踩坑记录：不能用 `unstable_cache`（已实测否决）

最初用 `unstable_cache(getActiveTools, …, { revalidate: 30, tags: ["tools"] })`，
**它每次都返回空数组、而且从不查库**，导致 `/tools` 与 `/dashboard` **静默地不显示任何工具**
（页面不报错，就是没有卡片）。同一份代码只差这一层的 A/B：

| | `/tools` 响应体 | 工具名 | 查 `/rest/v1/tools` |
|---|---|---|---|
| 原始代码 | 45,534 字节 | ✅ 有 | 1 次 |
| 加 `unstable_cache` | **14,889 字节** | ❌ **全部消失** | **0 次** |

→ 改用 `src/lib/tools-db.ts` 里的**进程内 TTL 缓存**（`TOOLS_TTL_MS = 30_000` + 并发去重）。
**别再改回 `unstable_cache`**；该文件里已写明原因与实测数字。

### 失效语义（实测过三种情况）

| 场景 | 结果 |
|---|---|
| 连续两次请求 | 第 1 次查库 1 次，第 2 次 0 次（缓存命中） |
| 改库、不调失效接口 | 约 **30.7 秒**后自动可见（TTL 到期） |
| 改库 + 调 `revalidateTools()` | **立即**可见（下一个请求直接查库） |

**⚠️ `revalidatePath("/tools")` 不能清掉这个缓存** —— 实测调完它之后紧接着请求，
仍然查库 0 次、仍是旧值。**别以为 admin 动作里的 `revalidatePath` 覆盖了工具目录缓存。**
（`src/app/admin/membership-actions.ts` 的 `revalidateAll()` 里已经额外调了 `revalidateTools()`。）

**现状的实际影响**：管理员在 Supabase SQL Editor 里直接改 `tools` 表（改 `min_plan`、下线工具等），
**最多 30 秒后全站生效**，不需要手动操作。项目目前**没有**「改工具权限」的后台界面；
将来若加，那个 Server Action 里请调 `revalidateTools()`，可获得「改完即见」。

> 缓存是**每个服务端实例各一份**。多实例时其它实例最多滞后 TTL（30 秒）。

## 四之二、还剩一项（未做）

**导航链接预取太凶**：`SiteHeader` 里的 `<Link>` 没关预取。
实测加载一个页面会额外触发 **11 条**后台 RSC 预取：

```
/tools?_rsc=…            ×2   （页面里还有一个「工具列表」入口）
/admin?_rsc=…            ×2
/upgrade?_rsc=…          ×2   （免费用户看到的「开通会员」）
/tools/math-plan?_rsc=…  ×2   （每张工具卡片）
/tools/paper-analysis?_rsc=… ×2
```

每条预取都要重跑一遍代理 + 页面查询。给非当前页的链接加 `prefetch={false}` 可消掉，
**代价是点击后首次进入略慢**——所以这是取舍，用户决定先不做。

> 另外注意：加了 `loading.tsx` 之后，Next 会对这些动态路由**做壳预取**。
> 好处是切换时先出现骨架屏（感知更快），代价是多了一些后台请求。
> 所以骨架屏与预取开关要一起权衡，别只看请求数。

---

## 五、怎么复测

`/tools` 与 `/dashboard` 都不是静态页。**改完第二批后，期望值变了**：

- 冷启动第一次请求：`/dashboard`、`/tools` 各约 **5 次**；工具页约 **12 次**。
- **30 秒内的后续请求**：`/tools`、`/dashboard` 应少掉 `tools` 那 1 次（变为 ~4 次），
  这就是目录缓存生效的证据。
- 判断有没有退化：看「每次页面请求触发的服务端 supabase 请求数」有没有涨回去。
  涨回去说明 `React.cache()` 去重或并发被破坏（常见原因：有人把 `getViewer()` 换成
  自己新建 client 直接查、把并发改回 `await` 串行、或动了 `getActiveTools` 的缓存）。

**最快的单点验证**：连续两次请求 `/tools`，看第二次有没有再再查 `tools` 表 —— 没有就对了。

---

## 六、课后反馈工具（曾经的主瓶颈）· 交接

> ✅ **本节描述的是「优化前」的现状。P1–P4 之后：首次进入约 3.0 秒、30 秒内第二次约 0.6 秒
> （原为 5–6 秒 / 1.5–2 秒），热请求出网次数 10 → 1。**
> 沿革见「六之二」P2、「六之三」P3、「六之四」P4；本节保留作为**根因分析**与对照基线。

### 优化前：每次切科目/教材约 5–6 秒

**根因（已实测定位，不是猜测）**：香港 Vercel → 新加坡 Supabase，**每次调用约 400–500ms**；
而**单次 scoped 请求要打 10 次 Supabase**。10 × 500ms ≈ 5 秒。

**注意**：不是"浏览器到 Vercel 的固定往返"，也不是冷启动 —— 框架自身只花 3–14ms。
贵的全是 **Vercel → Supabase 的每一次调用**。所以**唯一有效的方向是减少调用次数**。

### 一次 `GET /api/feedback/data?stage=senior&subject=math` 的调用清单

| # | 调用 | 来源 | 能否省 |
|---|---|---|---|
| 1 | `auth/v1/user` | `src/proxy.ts:85` 中间件 | 否（Next 无法与 route 共享） |
| 2 | `user_roles` (`role,status`) | `src/proxy.ts:136` 中间件 | 否（同上） |
| 3 | `auth/v1/user` | `src/lib/viewer.ts:52` `getViewer` | 否（同上） |
| 4 | `user_roles` (`role,plan,status,expires_at`) | `src/lib/viewer.ts:64` | 否 |
| 5 | `feedback_history` | route（`getHistory()`） | **能**（按 user 短缓存） |
| 6 | `feedback_phrases` | route（`getPhrases()`） | **能**（静态表缓存） |
| 7 | `feedback_students` | route（`getStudents()`） | **能**（按 user 短缓存） |
| 8 | `feedback_categories` | route（`getCategories()`） | **能**（静态表缓存） |
| 9 | `feedback_textbooks` | route（`getTextbooks()`） | **能**（静态表缓存） |
| 10 | `feedback_chapters` | route（按需 1 本 or 1 条 in 查询） | **能**（静态表缓存） |

> 第 1–4 项是**理论下限**（中间件 2 + getViewer 2）。除非改用 JWT 本地取 `sub`
> （用户已决定**不做**，安全取舍不值得），否则降不下去。

### 本轮已完成（commit `5803dd8` + P0-fix）

- **N+1 干掉**：`feedback_chapters` 从 **29 次 → 1 次**（原来对每本教材各查一次章节）
- **数据截断修复**：不带参数的「全量分支」返回 **400**（原来 8992 行只返回 1000 行，静默丢 89%）
- **关键词 30 秒缓存**：连续请求的第 2 次起不再查 `feedback_keywords`
- **P0-fix**：删掉 `route.ts` 里多余的 `user_roles` 查询（`user_roles` **3 → 2**）；
  同样修掉 `paper-analysis` 的 3 处（`mode` / `parse-file` / `vision-scores`）
- **UI**：选了教材后隐藏重复的「关键词库」区块（取消后自动恢复）
- 净效果：**36 次 → 10 次**调用

### ✅ P1 已完成（本会话收尾）

| 项 | 做法 | 实测 |
|---|---|---|
| **静态表缓存** | `categories`(8 行) / `textbooks`(219 行) / `chapters`(按需) / `phrases`(10 行) —— 全用户共享、极少变。照 `src/lib/tools-db.ts` 的**进程内 TTL 缓存**写法（**没用 `unstable_cache`**，见第四节踩坑），TTL 30 秒 | 这 4 张表命中时**一次都不查** |
| **students/history 按用户短缓存** | key 用 `user_id`，TTL 25 秒；写入/删除后**立刻**调 `invalidateStudents()` / `invalidateHistory()` | 命中时**一次都不查** |

**实测（`tests/feedback-data-cache.test.mjs`，P1 当时 14/14 通过）**：`GET /api/feedback/data?stage=senior&subject=math`

```
冷请求（缓存全空）：11 次出网
  auth:user×2, user_roles×2,
  feedback_categories×1, feedback_chapters×1, feedback_history×1,
  feedback_keywords×1, feedback_phrases×1, feedback_students×1, feedback_textbooks×1
热请求（TTL 内再来一次）：4 次出网
  auth:user×2, user_roles×2
```

**11 次 → 4 次，省 7 次**（比原预估「−4 次」还多省了 3 次：因为指定维度时
`getChapters`+`getChaptersByTextbookIds`+ 关键词那几条也一并命中了）。
响应体必须逐字节一致：实测冷/热都是 **9,479 字节**，内容**完全相同**。

> ⬆️ **这两组数字是 P1 当时的记录。P2 之后热请求变成 3 次**（`user_roles` 又省掉一次），
> 详见下面的「六之二、P2」。

⚠️ **按用户的两张表必须把 `user_id` 拼进缓存 key**：RLS 只保证「查出来的是本人的行」，
**保证不了「缓存 key 不串号」**。共用 key 会把甲的档案发给乙。
route 里已经把 `guard.user.id` 直接传进 `getStudents(uid)` / `getHistory(uid)` ——
**别为了「顺便查一次会话」把那两个参数删掉**（删了会退回再付一次 `auth/v1/user` 往返）。

> ⚠️ **唯一一处「故意不用缓存」的地方：写档案前的合并读**（2026-10 第二批）。
> `upsertStudent()`（`src/lib/feedback-db.ts`）在做**按键合并**（含 `extra`）之前，
> 走的是**直读** `getStudentsFresh()`，**不是**上面那张 25 秒缓存 ——
> 因为合并的正确性完全依赖「旧值是最新的」，用缓存版可能把别家工具刚改过的键**写回旧值**。
> 代价是**每次「保存档案」多一次 Supabase 往返**（用户明确选了这个取舍：保存是低频动作，换不丢数据）。
> **别为了省那一次往返把它改回 `getStudents(uid)`。**

### ⚠️ 这个缓存最危险的失效方式不是「慢」，而是「静默变空」`unstable_cache` 那次就是这样：页面不报错、只是**什么都没有**，肉眼看不出来。
所以本步**必须**有一条「缓存命中时数据不为空」的断言 —— 见
`tests/feedback-data-cache.test.mjs`（冷/热两次响应体逐字节比对 + 各字段非空）。
**只测「快了」是不够的：快和空可以同时成立。**

### 失效语义（实测过）

| 场景 | 结果 |
|---|---|
| TTL 内连续两次请求 | 第 1 次查库，第 2 次 **0 次**（静态表 TTL 10 分钟 / 档案与历史 25 秒 / 会员状态 30 秒） |
| 后台改关键词/教材/章节/短语 | **立即**（两个 admin actions 的 `revalidate()` 里已调 `invalidateKeywords()` + `invalidateStaticTables()`） |
| 工具页存/删档案、存/删历史 | **立即**（route 里写完就 `invalidateStudents()` / `invalidateHistory()`） |
| `/admin` 开通会员 / 取消 / 封禁 / 解封 | **立即**（`membership-actions.ts` 的 `revalidateAll()` 里调 `invalidateUserRoles()`） |
| 改库但**不经过**这些代码路径（如在 Supabase SQL Editor 直接改） | 静态表最多 **10 分钟**、档案/历史 **25 秒**、会员状态 **30 秒**后自动可见 |

> 缓存是**每个服务端实例各一份**。多实例时其它实例最多滞后一个 TTL。

### ⚠️ 一处「看着像 bug、其实是原来就这样」的地方（别改错）

`getCategories(stage)` **本来就没有按 stage 过滤查询** —— 它把全部行取回来，
再在内存里按 stage 过滤（SQL 里只有 `.eq("active", true)`）。
所以缓存层缓存的是「**全部行**」（一份，所有学段共用），**不是**「过滤后的行」。
改成按 stage 分开存不但没必要，还会把「过滤」这个语义偷偷挪进缓存层。

### ⚠️ 明确不做的（用户已决定）

- **全量关键词缓存**（"一次拉完 8992 条放内存、按参数切片"）：评估后**降级不做**。
  实测单次最多只能拿 1000 行，拉全量要 **9 次分页**（1.80MB / 本地 2.6 秒 / 用户环境约 4.5 秒），
  而它**只省 1 次调用**（关键词本来已缓存）—— 性价比低于静态表缓存。
  （内存本身不是问题：8992 行 ≈ 2.1MB，Vercel 默认 1024MB。）
- **中间件与 route 去重**：Next 无法传递，风险大于收益。
- **`getViewer` 并行 / JWT 取 sub**：安全取舍，不做，保留 1 次 `auth/v1/user` 网络校验。

---

## 六之二、P2：缓存 key 收敛 + 10 分钟 TTL + 会员状态缓存（已完成）

> 起因：用户实测「**缓存有效，但使用频率低的人每次都冷启动**」，
> 截图里切科目/教材每次 2.7–5.4 秒。

### 先纠正一个误判（实测数据说话）

当时的直觉是「TTL 太短（30 秒），所以冷」。**量出来不是**：

```
同一实例内连续访问不同维度（改之前）：
  高中/数学（冷）           2069ms  11 次出网   ← 静态表 5 次
  高中/数学（同一维度再打）   466ms   4 次出网   ← 完全命中
  高中/英语（换科目）         810ms   7 次出网   ← textbooks/chapters/keywords 全 miss
  高中/化学（换科目）         850ms   7 次出网
  初中/数学（换学段）         801ms   7 次出网
  高中/化学 + 指定教材82      743ms   6 次出网
```

**真正的原因是缓存 key 精确到「学段+科目+教材」**：`textbooks` 有 **17 条** key
（线上实测 17 个「学段|科目」组合）、`chapters` 有 **64 条**（64 本教材有章节）。
每换一个组合就是一次**全新的 miss** —— 而 TTL 再长也救不了「第一次切到化学」。
一个老师上课就是在几个科目/教材之间切，所以每次都像冷启动。

### 三条改动

| # | 改动 | 效果（实测） |
|---|---|---|
| 1 | **教材表收敛成 1 条 key**（`feedback_textbooks` 只有 219 行 / 24 KB，而且原查询**本来就没按 stage/subject 过滤**，是取回全表再内存筛） | 换任何科目/学段，教材表**一次都不查**（17 条 → 1 条，零代价） |
| 2 | **章节收敛成「学段\|科目」**（64 条 → 17 条）：一次取该科目**全部教材**的章节，内存按教材分组 | 同一科目内换教材不再各 miss 一次。容量实测：最大的 senior\|math 一次只有 **417 行 / 约 80 KB**，不会撞 PostgREST 的 1000 行上限；仍带分页兜底 |
| 3 | **静态表 TTL 30 秒 → 10 分钟**（含关键词）；档案/历史保持 **25 秒** | 只是**兜底** —— 后台改动一律主动失效，TTL 管的是「绕过代码路径直接改库」 |

### 实测对比（`tests/feedback-data-cache.test.mjs`，23/23 通过）

```
                     改之前      改之后
冷请求（首次）         11 次       11 次     （这一份数据必须付）
热请求（同维度）        4 次        3 次     ← 又省掉「页面侧那次 user_roles」
换一个科目             7 次        5 次     ← 教材表已共享，只剩章节+关键词各一次
★再次进入同一科目      7 次        3 次     ← 这才是「用过的组合不再冷」
同一科目内换教材        6 次        4 次     ← 章节按科目共享
```

耗时（本机 ~90ms/次往返，只作看门狗）：冷请求 **1757ms**、热请求 **338ms**。
**用户环境单次约 400–500ms，所以换算过去热请求约 1.2–1.5 秒。**

### user_roles（会员状态）也进了 30 秒进程内缓存

`getViewer()` 每次请求都查一次 `user_roles`。会员状态**只有管理员会改**，
而唯一会改它的代码路径是 `src/app/admin/membership-actions.ts`（开通/取消/封禁/解封），
所以在那里的 `revalidateAll()` 里调 `invalidateUserRoles()` —— **改完即生效**。

- 每次请求的 `user_roles` 从 **2 次降到 1 次**（省掉的是页面侧那次；
  **中间件 `src/proxy.ts` 不在 React 渲染树里，它那次省不掉**）。
- 每次请求的出网次数：**4 次 → 3 次**（中间件 auth + 中间件 user_roles + getViewer 的 auth）。
- ⚠️ **安全取舍（用户已确认）**：**只有绕过 `/admin`、直接在 Supabase SQL Editor 里改库时**，
  封禁才需要等最多 30 秒生效。走 `/admin` 按钮是立即的。
- ⚠️ `auth/v1/user`（会话校验）**绝不缓存** —— 那是安全底线。

### 启动预热：只烤「又小又每次都要」的三张表

模块加载时**不阻塞**地预热 分类(8行) / 短语(10行) / 教材(219行)，
并**跳过 `next build`**（构建期会 import 这个模块）。

> ⚠️ **它不是「用户来的时候一定热」的保证，别指望它解决冷启动。**
> Vercel 实例是按需起的、闲置就回收，而「启动预热」正好跑在**有请求才让实例起来**的那一刻，
> 所以它常常是跟第一个真实请求**并发**跑的 —— 最坏情况比不预热更慢（抢连接）。
> **真正的收益来自上面的 key 收敛，不是这里。**
> 章节和关键词**故意不预热**：全量分别约 340KB / 更多，预热等于给每个新实例加启动开销。

### ⚠️ 两个必须守住的约定（都会静默出错，看不出来）

1. **空结果要缓存，失败不能缓存。**
   这条界限在 `src/lib/ttl-cache.ts`：`load` **查失败必须抛异常**（抛了就不写缓存），
   **查成功但没数据就正常返回 `[]`**（会被缓存）。
   - 反过来做（不缓存空结果）会踩坑：**新用户没有学生档案**，于是每次请求都白查 2 次 ——
     实测就是这样，热请求里 `feedback_students` / `feedback_history` 一直在。
   - 「把失败缓存成空」正是 `unstable_cache` 那个坑的形态：页面静默地什么都没有。
2. **缓存层不缓存失败，但接口层不能因此 500。**
   `feedback-db.ts` 的 `softFail()` 把「查失败」翻译成「空结果」返回给调用方
   （与改动前的降级行为一致），同时失败**没有**落进缓存 —— 所以下一次请求会重新查库，
   数据库一恢复就立刻正常，不会像缓存失败那样一直空到 TTL 过期。

> ⚠️ 顺便记一个测试坑：**`NEXT_PUBLIC_*` 会被烧进 `next build` 的产物**
> （在 `.next/server/chunks/*.js` 里能搜到 anon key）。所以
> 「build 完再改 `.env.local` 来模拟数据库连不通」**是无效的** —— 服务端用的还是构建时那份，
> 测试会假绿。（本轮踩过：以为在测降级，其实服务端一直是好的。）
- **导航预取 `prefetch={false}`**：取舍，不做。

---

## 六之三、P3：中间件缓存（已完成）—— 「打开工具页 5–6 秒」的最后一块

> 起因：用户实测「进入 `/tools/feedback` 后 5–6 秒才出现学生面板与教材下拉；
> F12 显示**等待服务器 4.31 秒、Content download 只 8ms**」——不是内容大，是服务端往返多。

### 根因：中间件在每次带 cookie 的请求上做 **2 次**外网查询

`src/proxy.ts` 每次请求都要：

1. `supabase.auth.getUser()` —— 向 Auth 服务校验 token（**1 次往返**）
2. `user_roles` 查询（封禁 + 管理员判定，**1 次往返**）

而打开一个工具页，中间件要跑 **2–4 次**（页面壳 `/tools/feedback` → iframe 里的
`/tools/feedback.html` → 之后每个 API 请求）。香港→新加坡每次 400–500ms，
这就是那 4.31 秒的主要来源。

⚠️ **页面侧的缓存帮不到这里**：`src/lib/viewer.ts` 里 P2 加的 `user_roles` 缓存
跑在 React 渲染树所在的运行时；中间件不在渲染树里，两边内存不共享。
**所以两边各缓存一份不是重复劳动。**

### 做法

在 `src/proxy.ts` 里加两个**模块级** TTL 缓存：

| 缓存 | key | 值 |
|---|---|---|
| 认证结果 | **access token 本身** | 最小用户信息 `{id, email}` |
| 角色/封禁 | `user.id` | `{role, status}` |

- cache key 用 token ⇒ **token 一变 key 就变，自动 miss**；登出后浏览器不再带该 token ⇒ 也自然 miss。
  **不需要额外设计失效机制。**
- token **只当缓存 key**，绝不参与身份判定；缓存里的 user 仍然来自**被 Auth 服务校验过**的
  `getUser()` 返回值 —— **不是**用 `getSession()` 读 cookie 冒充校验。
- 容量上限 500 key，超出按最久未写淘汰。
- 缓存逻辑抽在 `src/lib/three-state-cache.ts`（**不 import `server-only`**、
  只用 Map/Date.now，Edge 与 Node 都能跑）。它与 `ttl-cache.ts` 的区别：
  那个只能表达「一次成功加载」，中间件要缓存**三态**（已登录 / 未登录 / 查不到），
  而且「未登录」**必须**被缓存，否则匿名请求反而变慢。

### 开关：`MIDDLEWARE_CACHE_TTL`

| 值 | 行为 |
|---|---|
| 不设 / 空 | **默认 30（秒）** |
| `30` | 30 秒 |
| `0`（或负数 / 非法） | **关闭缓存**，回到「每次都查」 |

> 名字**不带 AI 前缀**（原标题 `AI_MIDDLEWARE_CACHE_TTL` 是错的：它同时管认证与角色，
> 跟 AI 无关）。线上出问题时设成 `0` 即可**不改代码**摘掉缓存。

### 安全取舍（用户明确接受）

- **最多延迟一个 TTL（默认 30 秒）**才察觉 token 被吊销 / 会话失效。
- ⚠️ **做不到「登出/改密码时主动清缓存」** —— 原因是结构性的：
  中间件与 API 路由 / Server Action **不是同一个执行环境、内存不共享**，
  在 logout 路由里 `clear()` 中间件那份内存是**无效的**。只有中间件自己能清自己的。
- **封禁不受影响**：封禁走 `user_roles`，`/admin` 点封禁会主动清页面侧缓存；
  中间件这份最多滞后 30 秒（与上面同源）。

### 实测（`tests/middleware-cache.test.mjs`，6/6）

连续请求同一个受保护页面：

```
第 1 次 [auth:user, user_roles, tools] 共 4 次出网
第 2 次 [auth:user, tools]             共 2 次出网      ← user_roles 归零
耗时：809ms → 18ms
```

> **必须钉住的假设**：这套做法依赖「**中间件里模块级变量能跨请求存活**」。
> 该假设一旦不成立（Next 换运行时 / 部署形态变成每请求一个新 isolate），
> 代码不报错、功能正常，只是**静默失去全部收益** —— 没有任何迹象。
> 所以测试直接断言「第 2 次的 `user_roles` 次数为 0」；
> 另外用 `MIDDLEWARE_CACHE_TTL=0` 跑同一套件，断言「关掉后第 2 次**仍会**查 user_roles」。

**顺带结论：这条链上不再靠排除静态资源提速。** 实测 `public/tools/feedback.html`
**没有任何外部 `<script src>`/`<link>`**（0 个子资源），所以 matcher 排不排 `.js`/`.css`
对反馈工具几乎没影响；而 `.html`/`.js`/`.css` 被中间件拦住是**刻意设计**
（`tests/paper-regression.test.mjs` 断言未登录取 `/tools/feedback.html` 必须 307），
不能为了提速排掉。

### 另一块：`/tools/feedback` 的骨架屏

`tools/loading.tsx` **不会**套用到 `/tools/feedback` 这条动态子路由，
所以服务端渲染出页面壳之前是**整屏空白**。现在补了两层**纯静态**骨架：

- `src/app/tools/feedback/loading.tsx` —— 盖住服务端渲染阶段；
- `ToolFrame`（客户端组件）+ `feedback-skeleton.tsx` —— 盖住 iframe 加载阶段，加载完淡出。

⚠️ 实现要点：iframe **从第一次渲染就挂上**，骨架是叠在它上面的绝对定位层。
若写成「等 onLoad 再渲染 iframe」，改 state 引起的重渲染可能让 React
**重新挂载 iframe → 工具被加载两次**。另外骨架加载完必须 `pointer-events-none`，
否则看不见的骨架会挡住工具页的点击。

### 复测方法

```powershell
# 先 pnpm build，然后：
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  tests\middleware-cache.test.mjs
```

期望：第 1 次 4 次出网 → 第 2 次 2 次（`user_roles` 为 0）。
若第 2 次仍是 4 次 → **缓存没生效**（中间件模块状态没能跨请求存活，
或 `readAccessToken` 没解析出 token）。

### 复测方法

```powershell
# 先 pnpm build，然后：
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  tests\feedback-data-cache.test.mjs
```

这个套件会自己起 `next start`（端口 3000）并**杀掉 3000 上的旧监听进程**，
所以别和其它真服务套件同时跑。它靠 `tests/_instrument.cjs` 插桩数出网次数
（`NODE_OPTIONS=--require=…` + 一个 4599 端口的小查询口），**不改生产代码**。

期望输出：冷请求约 11 次、热请求约 1 次、`26/26 passed`。
（热请求从 4 → 3 → 1 的沿革见「六之二」与「六之三」；只剩页面侧 `getViewer` 的会话校验。）
若热请求仍然 ~11 次 → 缓存没生效（多半是 key 拼错或有人把 `cached()` 去掉了）；
若热请求次数正常但**数据为空** → 命中缓存的失败路径（正是 `unstable_cache` 那种坑）。

**排查原则**：**看调用次数，不要看毫秒**。本机到 Supabase 延迟低（约 120ms），
绝对耗时没有代表性；**次数 × 用户环境的单次成本才是真实体感**。

---

## 六之四、P4：feedback 云端首屏重写（已完成）—— 消除「先错后对」的闪烁

> 起因：用户实测「进入 `/tools/feedback` 会**先显示 localStorage 旧数据**
> （💾 本机版 + 55 条旧关键词、没有教材下拉），2–3 秒后才切成云端
> （☁️ 云端·管理员 + 3 个学生 + 11 条本册关键词 + 教材下拉）」。
> ⚠️ **真正的问题不是闪，而是用户可能拿旧数据生成了反馈** —— 家长会收到错内容。

### 根因：`init()` 是「先同步渲染 localStorage，再异步拉云端」

```
init()
  ├─ fillSelects / 日期 / 默认值 / bind          ← 与数据无关，照旧
  ├─ renderStuList / applyCloudKeywordStore / renderGenerate / renderPhrases / renderHist
  │    ⚠️ 此刻 cloudData 还是 null → applyCloudKeywordStore() 直接 return，
  │       所以渲染出来的是**默认/旧关键词**（就是那 55 条）
  ├─ updateModeBadge()                          ← API.mode 还是 'local' → 徽章「💾 本机版」
  │                                               （静态 HTML 里写死的初值）
  └─ detectServer().then(…)                     ← 到这里才开始异步
```

云端的两个问题（这次一并解决）：

1. `NEXT_MODE`（云端模式）**是纯本地判断**（`protocol` + `pathname`），
   但 `API.mode='next'` 却写在异步回调里 → 徽章必然先显示「本机版」再跳。
2. 启动时**多打了一次 `/api/feedback/mode` 只为取 `isAdmin`** —— 而
   `/api/feedback/data` 的响应里**本来就有 `isAdmin`**。多这一跳要多跑一次中间件
   （`auth.getUser` + `user_roles`），跨洋网络下就是白等几百毫秒。

### 改动

| # | 改动 |
|---|---|
| 1 | **删掉 `/api/feedback/mode` 这次请求**（`detectServer()` 里的 `NEXT_MODE` 分支**整个删除**，不留死代码）；`isAdmin` 直接从 data 响应读。路由文件保留，只是不在启动链路上 |
| 2 | `API.mode` 改为**同步**设定：命中 `NEXT_MODE` → `'connecting'`，否则 `'local'`。新增 `'connecting'` 徽章态「⏳ 正在载入…」 |
| 3 | 新增 `initCloud()`：盖骨架 → 恢复上次学段/科目 → **直接** `loadCloudScoped()`（一次请求拿全部数据 + `isAdmin`）→ **一次性渲染全部** → 隐藏骨架 → 徽章切云端 |
| 4 | iframe 内部**静态骨架** `#appSkeleton`（叠在 `.wrap` 上，纯灰块，不发任何请求） |
| 5 | **8 秒总预算** + 失败处理（见下） |

`loadCloudScoped()` 里的渲染只服务于**后续**维度切换（用 `_cloudBooted` 区分首屏与后续），
避免同一屏被渲染两遍。

### ⚠️ 设计取舍：云端首屏**不回退 localStorage**（用户明确确认）

超时（8 秒）或数据失败时：

- 隐藏骨架（让页面可用，不是永远卡住）
- 顶部明确报错「⚠️ 云端数据加载失败（…），请刷新重试」
- **关键词区 / 结果区 / 学生档案区全部保持为空**
- **刻意不回退 localStorage**：回退等于让用户**拿一份旧数据去生成反馈**，
  家长会收到错内容 —— 宁可空着并明说。
- **不做自动重试**（用户确认）：宁可让用户明确知道失败，也不要让他以为在加载而干等。

> 推论：云端拉不到数据时页面就是**空的**，这是有意为之。若将来希望「离线也能用本机数据」，
> 应当做一个**明确的「离线模式」入口**，而不是自动回退。

### 实测（真浏览器 5 项，全部通过）

| # | 验证点 | 结果 |
|---|---|---|
| 1 | 首次进入 | **2997ms**（原 4–5 秒） |
| 2 | 30 秒内第二次 | **613ms**（原 1.5–2 秒） |
| 3 | 不再「先本机版」 | 脚本启动后 **18 帧采样、0 帧**出现「本机版」；首帧即「⏳ 正在载入…」 |
| 4 | 不再「先 55 条旧词」 | 骨架显示期 **17 帧**采样，关键词数**恒为 0** |
| 5 | 只让 `/api/feedback/data` 失败 | 显示失败提示；关键词 0 / 结果区 0 字 / 档案 0 |
| 附 | mode 请求已删 | 本轮实际请求的 `/api` 路径**只有 `/api/feedback/data`** |

> ⚠️ 复测这个场景**不要**用 `Network.emulateNetworkConditions({offline:true})` ——
> 那会让**整个页面**都加载不了、连 iframe 都不存在，测到的是「没有 iframe」而不是
> iframe 内部的失败路径。正确做法是用 `Fetch.enable` 只让 `/api/feedback/data` 失败。

> ⚠️ 另一个复测陷阱：轮询 iframe 状态时，若在**脚本还没执行**时就读 DOM，
> 会看到静态 HTML 初值（徽章写死「💾 本机版」、骨架 `hidden`）—— 那**不是**闪烁。
> 判定必须只看「脚本启动后」的帧（`readyState !== 'loading'` 或骨架已显示）。

### 本轮自己踩的坑（已修）

把 `#syncHint` 的「AI 润色由服务器代理」写在 `await` **之后**，把
`loadCloudScoped()` 写的「✓ 已载入云端数据…」**盖掉了** → `verify-checklist` /
`paper-regression` / `step7-ui` 三个套件变红。已改为在请求**之前**写提示。

### 复测方法

```powershell
# 先 pnpm build，然后用真浏览器打开 /tools/feedback，硬刷两次：
#   第 1 次：先见灰块骨架 + 「⏳ 正在载入…」→ 一次性出现云端版
#   第 2 次（30 秒内）：约 1 秒内就绪
# 若又想验证失败路径：用 Fetch 拦截只让 /api/feedback/data 失败（见上）
```

---

## 六之五、客户端缓存（IndexedDB）：让「第二次进入」不再跨洋等一次

> 起因：服务端缓存（上面 P1–P4）解决的是「同一个实例在 TTL 内别重复查库」，
> 但老师在**两节课之间**再打开工具，往往早就过了 TTL（静态表 10 分钟），
> 于是又要完整等一次「中间件 + 数据接口」的跨洋往返（用户环境约 3 秒）。
> 本轮把**全局静态数据**放到用户自己的设备上，第二次进入**先画出来**，同时后台照常核对。

### 一句话机制

```
打开 /tools/feedback
  ├─ ① 读 IndexedDB（几毫秒）→ 有 → **立刻渲染关键词/教材/分类/短语** → 撤掉骨架屏
  ├─ ② 后台**照常**打一次 GET /api/feedback/data（这一步绝不省）
  │     ├─ 新数据与已渲染的**逐字节相同** → 一行 DOM 都不动（不闪烁）
  │     ├─ 不同（管理员改过 / 版本号变了）→ 静默替换成新的
  │     └─ 失败 → 保持缓存显示 + 明确提示「数据可能不是最新」
  └─ ③ 把这次的静态数据写回 IndexedDB（供下次秒开）
```

### 缓存什么、不缓存什么（红线）

| 数据 | 缓存？ | 为什么 |
|---|---|---|
| `categories` / `textbooks` / `chapters` / `phrases` | ✅ | 全站共享、只有管理员会改 |
| `categoryKeywords`（当前维度的关键词） | ✅ | 同上；但**必须**按上面的流程后台核对过才敢说「最新」 |
| **`students` 学生档案** | ❌ **绝不** | 老师看完可能直接生成反馈发给家长，拿旧的 = 发错内容 |
| **`history` 反馈历史** | ❌ **绝不** | 同上 |
| `isAdmin` / `userId` / `email` | ❌ 不落盘 | 与权限有关；每次以真实响应为准 |

**这两条红线是「结构上」保证的，不靠调用者自觉**：落盘字段走一张白名单
`CACHEABLE_KEYS`（在 `feedback.html` 里），`students` / `history` 根本不在名单里；
而且缓存渲染那条路径（`applyCachedSnapshot`）**只画静态块**，
`renderStuList()` / `renderHist()` 只由真实响应触发。
`tests/feedback-client-cache.test.mjs` 会直接扒开 IndexedDB 断言「里面没有这两个字段」，
还会**故意往缓存里塞一个假学生**，断言它绝不会出现在屏幕上。

### 参数

| 项 | 值 | 说明 |
|---|---|---|
| 存储 | **IndexedDB**（库 `feedback_cache_v1`，表 `kv`） | 不用 localStorage：静态数据一份几百 KB，localStorage 只有约 5MB 且是同步 API |
| 键 | **一个维度一条**，key = query string（如 `stage=senior&subject=math`） | 与请求参数**共用同一处拼法**（`_scopeKeyOf()`），避免「缓存 key 说 A、请求其实是 B」 |
| 条目的字段 | `{ value, savedAt, fetchedAt, version }` | `fetchedAt` = 最后一次**被确认是最新的**时刻 |
| TTL | 10 分钟（`CLIENT_TTL_MS`） | 只管「要不要在后台重新拉」；**过期不影响显示**，只是后台一定会重新拉 |
| 「可能不是最新」提示阈值 | 24 小时（`CLIENT_STALE_HINT_MS`） | **另一条独立规则**：只管「要不要告诉用户这可能不是最新」。超过它且**没能核对成功** → 顶部明确提示 |

> ⚠️ 这两条**故意不合并**：TTL 过期（隔一顿饭回来）是常态，每次都弹警告纯属吓人；
> 只有「超过 24 小时都没能成功核对一次」才值得说出口。合并成一个判据是本轮先写错的一版
> （见下面第 3 条不变量）。
| 版本号 | 响应里的 `dataVersion`（`src/lib/feedback-db.ts`） | 客户端只拿它判断「该不该把本地那份整批作废」 |

### `dataVersion` 是怎么来的（以及为什么不是查库得来的）

`src/lib/feedback-db.ts` 里维护一个模块级计数：

- **种子 = `floor(now / 10分钟)`**，`invalidateKeywords()` / `invalidateStaticTables()`
  （两个 admin actions 的 `revalidate()` 都会调）里 `+1`。
- 为什么**不**去查一次 `MAX(updated_at)` 拿「真实版本」：那要给**每个请求**多付一次
  Supabase 往返（跨洋 400–500ms）—— 这个项目所有性能工作的核心结论就是**要减调用次数**。
  版本号只是**提示**，不值得为它买一次外网往返。
- 为什么种子是「10 分钟桶」而不是固定 0：
  · 同一个桶内启动的多个实例版本号**天然相同** ⇒ 客户端在实例间漂移时不会白清缓存；
  · 重新部署后种子稳定（桶内不变），不会每次部署都让所有客户端清一遍；
  · 10 分钟正好等于静态表 TTL。
- **已知局限（方向是安全的）**：跨 10 分钟桶启动的两个实例版本号可能不同，
  客户端遇到不同的版本号会**清掉本地缓存重拉一次**。宁可多拉，不可用旧。

### ⚠️ 唯一的诚实性取舍：版本号只有真实响应里才有

也就是说，**首屏那一刻无法提前知道缓存是不是已经过期**。所以：

- 命中缓存就**先画出来**（这是「0.5 秒」的全部来源），
- 真实响应回来后若版本号不同，立刻**静默替换**成新内容，
- 并且把提示语写成
  **「✓ 已载入云端数据：…（此前显示的是本机缓存，服务端已更新，画面已刷新）」**
  —— 显示过一瞬旧内容就**必须认**，不能只写「已载入云端数据」让用户以为一路都是新的。

> 想完全避免这一瞬，只能每次打开前先问一次服务器「版本号是多少」——
> 那就又变成一次跨洋往返，**整个功能的意义就没了**。这是本轮明确接受的取舍，
> 并且代价极低：那一瞬显示的仍然是**同维度**的静态数据（关键词/教材名），
> 而**用户自己的数据（学生、历史）从来不走缓存**，本来就是实时的。

### 提示语口径（都在 `#syncHint`，改动前先看这段）

| 场景 | 提示语 |
|---|---|
| 骨架屏路径（没有缓存） | `✓ 已载入云端数据：高中 · 数学，共 N 个关键词`（**这串字别改**：三个老套件按它断言） |
| 命中缓存 + 核对确认版本没变 | 上面那句 + `（本机缓存，已核对最新数据）` |
| 命中缓存但版本变了、已静默替换 | 上面那句 + `（此前显示的是本机缓存，服务端已更新，画面已刷新）` |
| 命中缓存但后台核对**失败** | `⚠️ 当前显示本机缓存（后台核对失败），数据可能不是最新；你的档案与历史仍是实时的` |
| 缓存 >24 小时且还没核对成功 | `⚠️ 显示的是本机缓存（N 天前下载），数据可能不是最新 —— 你的档案与历史仍是实时的` |

### ⚠️ 三条必须守住的不变量（错了都会**静默**出问题）

1. **「先显示缓存」绝不等于「不再拉新」。**
   命中缓存那条路径一定会走一次真实的 `loadCloudScoped()`。测试直接断言
   「缓存命中的那一趟，网络里确实出现了 `/api/feedback/data` 请求」——
   只测「快了」是不够的，**快和「再也不更新」可以同时成立**。
2. **缓存读/写失败 = 没有缓存，不能影响功能。**
   IndexedDB 在隐私模式/配额满时会抛；整层包在 `try/catch` 里，失败就静默走回原来的
   骨架屏流程。读缓存也带 8 秒总预算（缓存 API 有可能既不 resolve 也不 reject），
   最坏情况下仍然走 `cloudBootFailed`，页面不会永久卡住。
3. **`fetchedAt` 只在「确认是最新的」时推进。**
   它的含义是「最后一次被确认是最新的时刻」：真实拉取成功、或后台核对成功 → 记此刻；
   命中缓存但核对失败 → **保留旧值**。写错方向的后果是
   「超过 24 小时没能核对上」这条提示被一次次命中悄悄抹掉，用户永远看不到警告
   （本轮先写错了一版：`cacheIsFresh` 用了 `Date.now()-fetchedAt < CLIENT_TTL_MS`，
   时间越久反而越「新鲜」，提示永远不出现）。

### 实测（`tests/feedback-client-cache.test.mjs`，51/51 通过）

| 场景 | 结果 |
|---|---|
| 首次访问（IndexedDB 已清空） | 155–304ms 出内容 = **骨架屏路径**，随后写入缓存 |
| 二次访问（TTL 内） | **155–197ms 出内容**（本机同量级，因为本机到 Supabase 本来就只有约 90ms） |
| 数据相同 | 后台核对照做（`fetchedAt` 被推进），**重渲染 0 次** |
| 数据不同 | 静默替换，缓存里的旧内容被纠正 |
| 版本号不一致 | 缓存被清掉、按真实版本重写，提示语承认「此前显示的是本机缓存」 |
| 往缓存里塞假学生 | 屏幕上不出现；落盘内容里也始终没有 `students`/`history` |
| 超 TTL（>24 小时） | 先显示缓存 + 过期提示；核对成功后新鲜度被推进 |
| 缓存条数 | 塞进 9 条后自动裁到 6 条，且**刚用过的那条不会被裁掉** |

### 实测：**在模拟跨洋延迟下**冷 vs 热（内容出现耗时，即「用户看到关键词出现」）

本机到 Supabase 只有约 90ms，直接量差不出东西，所以用 CDP 的
`Network.emulateNetworkConditions` **人为加延迟**，量「从页面导航开始到关键词真正画出来」：

| 每个请求加的延迟 | 冷（`?noclientcache=1`，等价没有客户端缓存） | 热（本机缓存） | 省下 |
|---|---|---|---|
| 0ms | 169ms | 180ms | ≈ 0（本来就不慢） |
| **400ms** | **846ms** | **442ms** | **404ms** |
| 900ms | 1843ms | 1019ms | 824ms |

读法（这段很重要，别误读）：

- **客户端缓存省掉的正好是「1 次数据接口往返」**：400ms 延迟下省 404ms，900ms 下省 824ms
  —— **每 400ms 的单向延迟约省 400ms**。
- **冷路径随延迟线性涨、热路径几乎只涨一半**：热路径里那次后台核对仍然要走网络，
  但它**不再挡着用户看内容**；剩下的耗时主要是「HTML/iframe 本身要下下来」。
- **热路径在 900ms 延迟下还有约 1 秒**，所以如果用户体感目标是「0.5 秒」，
  那需要**更低的延迟**或**更少的往返**，不是这一层能单独保证的。
  诚实的说法是：**这一层把「第二次进入」从「等 2 次往返」降到「等 1 次往返加一个本地读」**。
  用户环境里那 3 秒里还含 Supabase 查询与外层页面加载，由 P1–P4 与服务端缓存分担，
  两者叠加才有「3 秒 → 0.5 秒」的体感（`project-overview.md` 第八节那张表）。

> ⚠️ 测试文件本身**不断言毫秒上限**（本机绝对值没有代表性），
> 它断言的是：缓存命中时首屏 < 500ms、**后台请求确实发出**、数据相同时**重渲染次数为 0**。
> 上面这张延迟对比表是**手工跑 `Network.emulateNetworkConditions`** 量出来的，
> 不是自动化断言 —— 别把它当成「每次跑测试都会验一遍」的东西。

> ⚠️ **本机的绝对毫秒没有代表性**（到 Supabase 只有约 90–120ms）。
> 用户环境每次跨洋 400–500ms，所以「首次 3 秒 → 二次 0.5 秒」这个结论要看
> **「二次省掉的往返次数」**，不是看本机的 155ms。
> 测试因此不去断言毫秒上限，而是断言：缓存命中时首屏 < 500ms、后台请求确实发出、
> 数据相同时重渲染次数为 0。

### 怎么复测

```powershell
# 先 pnpm build，然后（它自己起 next start 并杀掉 3000 上的旧监听，别和别的真服务套件同时跑）：
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  tests\feedback-client-cache.test.mjs
```

期望：`51/51 passed`。判断有没有退化，看这几条：

- **二次访问首屏 > 500ms** → 缓存没生效（key 拼错、`CACHEABLE_KEYS` 漏了字段、
  或者有人把 `initCloud` 里的读缓存那段删了）。
- **「缓存命中也照样发了真实请求」这条红了** → 有人把后台核对去掉了
  （这是最危险的一种「优化」：页面看着快，其实再也不更新了）。
- **「没有 students / history」这条红了** → 白名单被扩了，立刻回退。
- **场景0 报 `usedCache=true`** → 测试自己没把 IndexedDB 清干净（不是产品问题），
  看它打印的 `deleteDatabase=` / `复查剩余条数=`。

### 关掉它

两种方式，都**不用改代码、不用回滚提交**：

- 给工具页加参数：`/tools/feedback.html?noclientcache=1`（只影响这一台/这一次）
- 或在浏览器控制台执行 `localStorage.setItem('fb_noclientcache','1')` 后刷新
  （清掉：`localStorage.removeItem('fb_noclientcache')`）

关掉后行为立刻回到 P4 那套「骨架屏 → 一次请求 → 一次渲染」。
`_cacheDisabled` 就是在读这两个开关。

---

## 六之六、A-2：中间件刷新策略（已完成一半）—— 治「每次都要登录」

> 起因：用户反馈「**每次进网站都要登录**」。查下来根因**不是** session 存不住
> （cookie 有效期 1 年、关浏览器再开仍登录、access token 会自动续期），
> 而是 **Supabase 的「检测泄露 → 撤销会话」被并发刷新误触发**。
> 用户已把 reuse interval 从 10 秒调到 **30 秒**；本节是代码侧的那一半。

### 根因（实测数据 + 源码行号）

1. **`auth.getUser()` 会在 token 快过期时自己去刷新**，阈值是 auth-js 的
   `EXPIRY_MARGIN_MS = AUTO_REFRESH_TICK_THRESHOLD(3) × AUTO_REFRESH_TICK_DURATION_MS(30s) = 90 秒`
   （`@supabase/auth-js/dist/main/lib/constants.js`）。
   也就是说：**每个小时的最后一分半钟**里，每个调用 `getUser()` 的请求都想刷新。

2. **auth-js 的去重是「实例级」的，跨请求完全无效**。
   `_callRefreshToken` 用 `this.refreshingDeferred` 单飞（`GoTrueClient.js:4196-4199`），
   `_acquireLock` 用的也是 `this.lock`（默认 `navigatorLock` 是**浏览器**多标签锁，
   服务端为 `null` → 退化成实例内的 `pendingInLock`）。
   而本项目**每个请求都新建一个 `GoTrueClient`**（`createServerClient`），
   所以并发的 N 个请求 = N 个互不知情的刷新。

3. **实测（伪造「还剩 3 秒」的会话 + 并发 8 个请求）→ 16 次 `/auth/v1/token`**
   （每请求 2 次：中间件 1 + 页面侧 `getViewer` 1）。
   同一个 refresh token 被并发使用 → 触发撤销 → 下一个请求 `getUser()` 失败
   → 中间件 302 到 `/login` → **用户体感「每次都要登录」**。

> 为什么它表现得像「随机」：只在**刚好那 90 秒内有并发请求**时才发生。
> 一次页面加载有 **13 条 RSC 预取**（`/tools`、`/admin`、`/upgrade`、每张工具卡片）
> 全部并行打中间件 —— 平时被 30 秒进程内缓存接住，一旦 token 进入窗口就全部冲向刷新。

### 已有防御为什么挡不住

| 防御 | 为什么无效 |
|---|---|
| 中间件 `authCache`（key = access token，30 秒） | key **就是** token；刷新时恰好全部 miss，而 token 变化本身就意味着「刚刷过」 |
| `MIDDLEWARE_CACHE_TTL` 调大 | 同上，改 TTL 不改变「刷新瞬间全 miss」 |
| 调大 reuse interval | 只是让容忍的重复次数变多；**风暴越大越可能穿透**，且它是相对「首次使用」的绝对窗口 |

### A-2 实现（`src/proxy.ts`）

```
读 cookie 里的 expires_at / refresh_token（readSession）
├─ expires_at 距今 > 120 秒（FRESH_MARGIN_MS）
│    → **完全不调 getUser**：身份取自上次被 Auth 服务校验过的会话
│      （只**解码** JWT 取 sub/email，**不验签** —— 验签是 Auth 服务的事），
│      并写入 authCache。**0 次外网 → 也就不可能触发刷新。**
└─ 快过期 / 取不到会话 / JWT 解不出来
     → 交给 auth-js 的 getUser（它在这个分支才会真刷新）
     → 用 `singleFlight`（key = **refresh_token**）让同一波并发只发一次 /token
     → 刷新成功后把**轮换后的新 token** 写回 authCache
```

- **`FRESH_MARGIN_MS = 120_000`**：必须 **≥ 库内部的 90 秒**，否则库会抢在我们前面刷新，
  这个判断就白做了。留 30 秒余量；也不能太大（会拉长「过期未刷新」的窗口）。
- 单飞是**进程内**的（与本文件其它缓存一样，每个服务端实例各一份）。多实例时最坏 2 次，
  配合「写回 authCache」足够落在 30 秒 reuse interval 内。

### ⚠️ 安全取舍（用户明确确认接受）

- 分支① 不再**逐请求**向 Auth 服务确认「token 是否被吊销」，改为
  **每个 token 生命周期确认一次**（token 1 小时一轮换，进入 120 秒窗口时必然走分支②）。
  代价：**改密码 / 主动吊销最多延迟到该 token 过期才生效（≤1 小时）**。
- **封禁不受影响** —— 它走下面的 `user_roles` 查询（独立一条链，仍有自己的缓存与主动失效）。
- 明确**不做**的：中间件本地校验 `exp` 后完全不刷新（= 更强的 A-1 方案，
  会彻底失去「确认吊销」，用户已否决）。

### 实测结果

| 场景 | 修复前 | 现在 |
|---|---|---|
| token 还剩 1 小时 | — | **0 次刷新** ✅ |
| token 只剩 3 秒（单请求） | 1 次 | **1 次** ✅ |
| **并发 8 个「快过期」请求** | **16 次** | **1 次** ✅（本轮收口，见「六之七」） |

---

## 六之七、A-2 后半场：`viewer.ts` 收口（已完成）—— 「每次都要登录」的**真凶**

> 起因：`viewer.ts` 改造是交接文档里的**头号待办**。原判断是「A-2 只压掉了中间件那一半，
> 剩下 8 次来自页面侧的 `getViewer()`」。**这个判断只对了一半**：页面侧确实是 8 次，
> 但真正的根因比这更麻烦，而且**光按原方案改 `viewer.ts` 会把情况变得更糟**（实测 8 → 14 次）。

### 先纠正两个被写进文档的「事实」（都被实测推翻）

| 旧说法 | 实测结果 |
|---|---|
| 「中间件跑在 Edge，与页面侧内存不共享」（六之三、`viewer.ts` 旧注释） | **错的**。Next 16.3.8 下中间件与页面侧是**同一个进程的同一份模块内存**（中间件往 `globalThis` 写的东西，页面侧的 API 路由读得到；且 `EdgeRuntime` 未定义 ⇒ 实际是 Node 运行时）。插入临时探针验证过。 |
| 「并发 8 个请求 = 8–12 次 `/token`」 | 基线精确复现是 **8 次**（16 次是 A-2 之前）。但**改法不对**会**涨到 14–24 次**。 |

### 真正的根因：`auth-js` 会因为「读到快过期的会话」自己去刷新，而且带重试

`@supabase/auth-js` 2.117.2 的 `GoTrueClient.__loadSession()`（源码 2537-2544 行）：

```js
const hasExpired = expires_at * 1000 - Date.now() < EXPIRY_MARGIN_MS;  // 90 秒
if (!hasExpired) return 已经有效的会话;
const { data, error } = await this._callRefreshToken(refresh_token);   // ← 自己刷新
```

而 `_refreshAccessToken()` 内部**还带指数退避重试**（`retryable`，200/400/800…ms，上限 30 秒）。
`_recoverAndRefresh()`（client 初始化时）走的是同一套判断。

**三条结论，全部是实测：**
1. **`auth: { autoRefreshToken: false }` 挡不住它** —— 那个开关只管后台定时器。
2. 所以「只要请求经过一个 `createServerClient`，而 cookie 里的会话快过期，就会炸出一串 `/token`」。
3. 实测放大倍数：8 个并发请求 → **24 次**；16 次是全站加起来。

⇒ 这解释了「每次进网站都要登录」**为什么看起来随机**：只在 token 进入最后 90 秒时发生，
而且是**并发越集中越严重**；更糟的是重试过程里某次 `getUser()` 会返回 `null`，
中间件就把人送去登录页。

### 做法：绕开 auth-js 管理会话，只用于「查库」

新增 `src/lib/session-freshness.ts`（**中间件与页面侧共用同一份**），把三件事都直连实现：

| 动作 | 实现 | 为什么不用 auth-js |
|---|---|---|
| 判断「够不够新」 | `isFreshSession()`：剩余 > `FRESH_MARGIN_MS`(120 秒) | — |
| **校验**身份 | `validateTokenWithAuthService()`：直接 `GET /auth/v1/user` 带 Bearer | `getUser()` 会顺手刷新（见上）；这条就是 2026-10 已经验证过的「绕开会话加载」方案 |
| **刷新** | `refreshSessionWithAuthService()`：直接 `POST /auth/v1/token?grant_type=refresh_token`，**不重试** | `refreshSession()` 同样带重试风暴 |
| 写回新会话 | `persistRefreshedSession()`：用 `@supabase/ssr` **公开导出**的 `createChunks` + `stringToBase64URL` + `DEFAULT_COOKIE_OPTIONS` 复刻它的编码（`base64-` 前缀、3180 分片、清理旧分片） | `applyServerStorage` **没有导出**，深层 import 会在升级时静默失效 |
| 去重 | `authRefreshOnce()`（key = refresh token，TTL 内复用结果）+ `authSingleFlight()` | 只靠单飞**不够**：并发请求是**错峰**到达的，实测仍 8 次 |
| 让 auth-js 彻底闭嘴 | `hideStaleSessionFromAuthJs()`：把「快过期」的会话从 `getAll()` 里过滤掉 | 这是**最终生效的那一刀** |

**最后一条是关键**：只要 auth-js 还能**读到**快过期的会话，它就会刷新。
所以干脆让它读不到 —— 刷新由中间件单独做一次，做完写回 Cookie，
下一个请求 auth-js 读到的就是新鲜会话，`getUser()` / RLS 查询都照常。

> ⚠️ **只过滤「读」，绝不改「写」**：`setAll` 必须原样保留 ——
> 登录 / 注册 / 登出都靠它把会话写进 Cookie。
> 本轮先写成「页面侧不写会话」的空实现，结果**登录直接失效**，
> 被 `admin-grant90`（10/18）与 `feedback-client-cache`（2/4）抓出来。已回退。

### 实测对比（同一份会话，`tests/middleware-cache.test.mjs`）

| 场景 | 修复前 | 收口后 |
|---|---|---|
| token 还剩 1 小时 | 0 次 | **0 次** ✅ |
| token 只剩 3 秒（单请求） | 1 次 | **1 次** ✅ |
| **并发 8 个「快过期」请求** | **16 次**（收口前 8 次） | **1 次** ✅ |
| 单请求的全部出网 | 5 次 | **5 次**（`token`1 + `user`1 + `user_roles`2 + `tools`1） |

> ⚠️ 复测时**每个场景要用一份新的会话**。共用同一份会话时后面几个场景会命中
> 「同一把 refresh token 只刷一次」的结果缓存，量到 **0 次** —— 那是**对的**，
> 但会让人误以为「没测到东西」。

### ⚠️ 这条链上最容易改错的三处

1. **别给 `viewer.ts` 加回自己刷新**。页面侧（Server Component）**写不了 Cookie**，
   在这儿刷新等于白刷（新 token 落不了盘，下个请求还得再刷）—— 那正是旧实现放大刷新次数的原因。
2. **别把「快过期」的会话继续喂给 auth-js**（即别删掉 `hideStaleSessionFromAuthJs`）。
   删了立刻回到 24 次刷新，而且**不会有任何报错**，只是用户又开始被踢去登录页。
3. **别用 `supabase.auth.getUser()` 换掉 `validateTokenWithAuthService()`**。
   本机实测：直接校验 **1 次**，`getUser()` **18 次**。

### 安全口径（与 A-2 一致，用户已确认）

- 分支① 仍是「每个 token 生命周期向 Auth 服务确认一次」，不是逐请求确认；
  代价：改密码 / 主动吊销最多延迟到该 token 过期（≤1 小时）。
- 封禁不受影响（走 `user_roles`，独立一条链）。
- `validateTokenWithAuthService` 的失败方向**必须是关闭**：网络失败与 401 一律返回 `null`
  （不能写成「网络抖动 → 当成已登录」）。

---

## 六之八、旧记录：A-2 残留分析（**已被六之七取代，保留作对照**）

**原判断**：并发刷新只压掉了中间件那一半，剩下的来自页面侧的 `getViewer()`。

- `src/lib/viewer.ts:96` 的 `loadViewer()` **自己 new 一个 Supabase client** 调
  `auth.getUser()`。它读的是**浏览器发来的原始 cookie**，不是中间件改过的那份，
  所以它也会各自去刷新 —— 8 个并发请求就再刷 8 次。
- **证据**：临时把页面侧改成直接打 `/auth/v1/user`（绕开 auth-js 的会话加载）后，
  `/auth/v1/token` **归零** → 证明剩下的刷新确实和页面侧的会话加载有关。
- **试过但无效的一条路**（记录免得后人重复踩）：在中间件里
  `supabase.auth.setSession({access_token, refresh_token})`。实测**能**把新会话写进
  `next/headers` 的 cookie jar（页面侧 `cookies()` 确实读到了新的 `expires_at`），
  **但页面侧仍然刷新**；而且 `setSession` 自己还会多打一次 `/token`。
  已回退。

> ⚠️ **别照着这段去改**：按它「只改 viewer.ts 复用中间件结果」的写法改完，
> 实测并发刷新从 8 次**涨到 14 次**。真正的做法见六之七。


### viewer.ts 改造方案概要（**已按六之七完成，此处保留当时的方案**）

1. 把 `proxy.ts` 里「够新就不刷」的判断抽成一个小模块，例如
   `src/lib/session-freshness.ts`：
   - `readSessionFromCookies(cookieStore)` → `{ accessToken, expiresAt, refreshToken }`
   - `isFresh(expiresAt, marginMs)` → boolean
   - `userFromJwt(accessToken)` → `{ id, email } | null`（只解码）
2. `loadViewer()` 改用它：**够新 → 不调 `getUser`**，直接用 cookie 里那份；
   快过期才去问 Auth 服务（**实际实现改为直接校验、不刷新**，见六之七）。
3. 中间件侧也改用同一个模块，去掉重复代码。✅
4. **目标**：并发 8 个请求的 `/auth/v1/token` 从 8–12 次压到 1–2 次。✅ **实测 1 次**
5. **测试**：扩 `tests/middleware-cache.test.mjs`，断言并发 8 个 ≤ 2 次。✅
6. **注意**：`viewer.ts` 是 `server-only` 的，抽出来的模块**不要**带 `server-only`。
   ✅（不过实测中间件在 Next 16.3.8 下跑的是 Node 运行时，这条不再是硬约束）

### 复测方法

```powershell
# 先 pnpm build，然后（它自己起 next start，别和其它真服务套件同时跑）：
& "C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  tests\middleware-cache.test.mjs
```

期望：**13/13**。关注这三条：
- `token 还剩 1 小时（> 120s）→ 不刷新（/auth/v1/token = 0 次）`
- `token 只剩 3 秒（< 120s）→ 触发刷新（= 1 次）`
- `并发 8 个「快过期」请求 → ≤ 2 次（修复前 16 次）` ← **2026-10 收口后已收紧到 2**

若第一条红了 → 说明「够新就不刷」那条分支被破坏了（最常见原因：有人把
`FRESH_MARGIN_MS` 改到小于 90 秒，于是库抢先刷新）。
若**第三条**红了 → 优先查 `hideStaleSessionFromAuthJs()` 是否还在生效
（它是最终挡住 auth-js 自动刷新的那一层，删掉不会有任何报错，只会静默涨回 24 次）。

### 预取（同一轮的小改动）

`SiteHeader` 里**只给 `/admin` 与 `/upgrade`** 加了 `prefetch={false}`。
理由：一次页面加载有 13 条 RSC 预取，这两个不是高频点击目标却占其中 4 条；
减少它们等于减少「危险窗口内的并发数」。
**`/dashboard`、`/tools` 与每张工具卡片保持默认预取**（高频目标，预取有价值）。

---

## 七、已知问题（**记录**；第 1 条已于 2026-10 修复）

### 1. ✅ 非法日期会被原样写库、导致整个请求 500 —— **已修（2026-10）**

> **这一条修掉了。** 下面保留"修复前长什么样、为什么当初不修"的原文（它解释了
> 为什么会踩到、以及为什么只加范围校验**不够**），修复记录追加在本小节末尾。

`src/lib/date-input.ts` 的 `parseDisplayDate()` 对 ISO 那条分支**只做正则匹配、不校验月/日是否合法**：

```ts
if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;   // 2026-13-45 也会原样通过
```

于是 `2026-13-45` 这种值会被**原样**交给 `feedback_history.date`，
PostgreSQL 拒绝它 → `/api/feedback/data` 整条写入失败 → 前端 500。

- **发现时间**：2026-10，阶段2 第2步把 `parseDisplayDate` 从
  `src/app/api/feedback/data/route.ts` 搬到 `src/lib/date-input.ts` 时读到的。
- **为什么当时（阶段2）没顺手修**：用户明确要求「搬移行为零改动」。顺手加范围校验属于**行为变更**，
  会让「新老实现逐条一致」这条对照测试失去意义。
- **影响面（修复前）**：只有用户**手填**一个「日期名看着像日期、但那一天不存在」的值才会触发 ——
  `2026-13-45` 这种一眼假的，也有 `2026-02-30`、`2月30日`、非闰年的 `2026-02-29` 这种**不容易看出来**的。
  前端默认填的是「10月3日」这种中文格式，走的是**有范围校验**的分支，所以日常碰不到。

---

#### ✅ 修复记录（2026-10）

**为什么没照原计划只加范围校验**：原文写的方案是"在 ISO 分支上加 `m 1–12 && d 1–31`"。
实测发现**那样挡不住真问题的一半**：`2026-02-30`、`2026-04-31`、非闰年的 `2026-02-29`
都能过这个范围校验，而 PostgreSQL **照样拒绝** → 还是 500。
（更糟：中文/分隔符分支原本就是这个范围校验，所以同一个洞它们也有。）

**做法**：`src/lib/date-input.ts` 三条分支**共用一套真日历校验** `isRealDate()` ——
让 `Date` 自己进位（`2026-02-30` → `2026-03-02`）再回环比对年月日是否被改动；
年份同时限 1–9999。非法一律返回 `null`（该列可空，写入照常成功）。

**校验口径不是拍脑袋定的，是按库的实测行为对齐的**。用**只读查询**
（`GET /rest/v1/feedback_history?date=eq.<值>`，不写任何数据）逐条问过线上库：

| 值 | 库的答复 |
|---|---|
| `2026-10-03`、`2026-02-28`、`2024-02-29`（闰年）、`0001-01-01`、`0999-12-31`、`9999-12-31` | ✅ 接受 |
| `2026-02-29`、`2026-02-30`、`2026-04-31`、`2026-13-45`、`2026-13-01`、`2026-00-10`、`2026-10-00`、`2026-10-32`、`0000-01-01` | ⛔ 拒绝（`22008`） |

> 注意 `0000-01-01`：ISO 正则和"年份 4 位"都过得去，但**库不认 0000 年**
> （最小是 `0001-01-01`）。这条很容易漏，所以校验里年份从 1 起。

**行为变更（有意，两处一起记）**：

| 输入 | 修复前 | 现在 |
|---|---|---|
| `2026-13-45` | 原样写库 → **整个请求 500** | `null` → 写入成功、该列空 |
| `2026-02-30` / `2026-04-31` / `2026-02-29`(2026 非闰年) / `0000-01-01` | 同上（500） | 同上（null） |
| `2月30日` / `4月31日` / `2-30` | 中文/分隔符分支拼出假日期 → 500 | `null` |
| `2026-10-03` / `2024-02-29` / `0001-01-01` / `9999-12-31` / `10月3日` / `2026年10月7日` | 正常 | **逐字不变** |

**钉住它的地方**（`tests/date-input.test.mjs`，三组新断言 + 老实现副本照旧不动）：

1. **「有意分歧」组**：每个非法日期都同时断言「**老实现返回非 null**」与「新实现返回 null」
   —— 只断言后者会退化成"两边都 null"的空过（看着全绿、其实什么都没钉住）。
2. **「反向防护」组**：闰年 `2024-02-29`、边界年 `0001-01-01` / `9999-12-31`、
   `2026年10月7日` / `10月3日` / `10-3` 一个都不能被误伤
   （真日历校验最容易犯的错就是把合法日期也挡了，那是**静默丢日期**，比 500 更难发现）。
3. **端到端组**：真的 POST `2026-13-45` 等值走写路径，断言 **HTTP 200 且库里 `date` 为 null**
   —— 两个都要：只看 200 不够（接口吞错也会 200），只看 null 也不够（请求没成功时也是 null）。
   修复前这一组全是 500。

> 原来的「已知问题留痕」断言（`parseDisplayDateOLD("2026-13-45") === "2026-13-45"`）
> 已改成「修复留痕」：**老实现仍然原样返回**（参照物没被改坏）**且新实现返回 null**。

