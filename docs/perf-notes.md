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

## 六、课后反馈工具（当前主瓶颈）· 交接

### 现状：每次切科目/教材约 5–6 秒

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

### ⚠️ 未完成（P1，留给新会话）

| 项 | 做法 | 预期 |
|---|---|---|
| **静态表缓存** | `categories`(8 行) / `textbooks`(219 行) / `chapters`(按需) / `phrases`(10 行) —— 全用户共享、极少变。照 `src/lib/tools-db.ts` 里 `getActiveTools` 的**进程内 TTL 缓存**写法（**不要用 `unstable_cache`**，见第四节踩坑） | 每次请求 **−4 次** ≈ **−2 秒** |
| **students/history 按 user 短缓存** | key 用 `user_id`，TTL 20–30 秒 | **−2 次** ≈ **−0.8 秒** |

**预期合计：10 次 → 4–5 次，5–6 秒 → 约 2 秒。**

### ⚠️ 明确不做的（用户已决定）

- **全量关键词缓存**（"一次拉完 8992 条放内存、按参数切片"）：评估后**降级不做**。
  实测单次最多只能拿 1000 行，拉全量要 **9 次分页**（1.80MB / 本地 2.6 秒 / 用户环境约 4.5 秒），
  而它**只省 1 次调用**（关键词本来已缓存）—— 性价比低于静态表缓存。
  （内存本身不是问题：8992 行 ≈ 2.1MB，Vercel 默认 1024MB。）
- **中间件与 route 去重**：Next 无法传递，风险大于收益。
- **`getViewer` 并行 / JWT 取 sub**：安全取舍，不做，保留 1 次 `auth/v1/user` 网络校验。
- **导航预取 `prefetch={false}`**：取舍，不做。

### 复测方法

```powershell
# 期望（改完 P1 前）：feedback/data scoped 每次约 10 次出网、user_roles 2 次
# 改完 P1 后应降到 4-5 次
```

**排查原则**：**看调用次数，不要看毫秒**。本机到 Supabase 延迟低（约 120ms），
绝对耗时没有代表性；**次数 × 用户环境的单次成本才是真实体感**。
