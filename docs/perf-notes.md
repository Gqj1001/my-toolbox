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

