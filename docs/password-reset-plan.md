# 忘记密码 / 修改密码 · 方案与交付（2026-10 第十五批）

> 需求原话：「你能在这个过程中再帮我做一个用户找回密码和更改密码的功能吗，不用问我了，
> 等下你跑完把我需要做的事情再给我说一下，我集中执行。」
> ⇒ 所以本文档既写**方案**，也写**你要集中执行的那几件事**（§3）。

## 0. 一句话

两条路都做完了：
1. **忘记密码**（没登录也能用）：登录页 →「用邮箱重置」→ `/forgot-password` 填邮箱 →
   收到邮件 → 点链接 → 自动换出会话 → `/reset-password` 设新密码；
2. **修改密码**（登录后用）：个人中心（会员卡旁）或多处入口 → `/account/password` →
   填**当前密码 + 新密码两遍** → 保存。

## 1. 为什么这样做（三个关键选择）

| 选择 | 理由 |
|---|---|
| **复用 Supabase 自带的邮件重置**，不自己写 token 表 | 发信、token 有效期、限流、防重放都已经由 Supabase 管好；自己造一套 token 表既多一张表，也多一堆安全边界要自己守（本项目「能不加表就不加表」） |
| **重置链接回到已有的 `/auth/confirm`** | 那个路由**本来就支持 `type=recovery`**（当初做邮箱确认时写好的），本轮**一行没改**——`verifyOtp` 会把会话写进 Cookie，然后按 `next=/reset-password` 跳过去 |
| **改密码必须先验"当前密码"** | 老师常在**公共电脑**上登录着；只凭会话就能改密码的话，摸到那台电脑的人可以把密码改掉、把账号锁死。验旧密码的做法是**用旧密码再登录一次**（`signInWithPassword`）——比 `updateUser({ current_password })` 可靠，因为后者依赖 Supabase 后台一个**我们看不到的开关**（`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`，默认关闭时该字段被忽略） |

### 1.1 重置流程为什么不要求"当前密码"

走到 `/reset-password` 的人**正想不起旧密码**——要求他填就是死锁。
所以：表单里带一个隐藏字段 `reset=1`，服务端看到它**跳过**验旧密码，只要求"有一个会话"
（那个会话正是邮件链接换出来的）。两条路**共用同一个服务端动作**，避免"改密码"出现两套实现。

> ⚠️ 所以这个隐藏字段是**安全相关**的：`/reset-password` **没有**放进公开路径
> （`src/proxy.ts` 的 `PUBLIC_PATHS`），必须先有会话才能打开它。
> `tests/password-flows.test.mjs` 用一条静态契约 + 一条真 HTTP 断言钉住了这两点。

## 2. 改了什么（文件清单）

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/lib/password-policy.ts` | **新增** | 密码规则的**唯一来源**（纯函数 `checkNewPassword`：必填 / 至少 6 位 / 最多 72 位 / 两次一致 / 新密码不能等于当前密码） |
| `src/lib/auth-errors.ts` | **新增（搬家）** | 认证类报错的**中文翻译唯一来源**。原来住在 `src/app/auth/actions.ts`，但那个文件有 `"use server"` —— **该指令下每个 export 都必须是 async**，同步的翻译函数一 export 就构建失败（`Server Actions must be async functions`）。已搬出，两个动作文件都 import 它 |
| `src/app/auth/password-actions.ts` | **新增** | 两个 Server Action：`requestPasswordReset`（发重置邮件）、`changePassword`（改密码，含 `isResetFlow` 分支） |
| `src/app/forgot-password/page.tsx` + `src/components/forgot-password-form.tsx` | **新增** | 忘记密码页（公开） |
| `src/app/reset-password/page.tsx` + `src/components/reset-password-form.tsx` | **新增** | 设置新密码页（**必须**由邮件链接换出会话后才能进） |
| `src/app/account/password/page.tsx` + `src/components/change-password-form.tsx` | **新增** | 登录后改密码页 |
| `src/proxy.ts` | 改动一行 | `PUBLIC_PATHS` 加 `/forgot-password`（不加则忘了密码的人被弹回登录页，永远进不去） |
| `src/app/login/page.tsx` | 改动 | 加「忘记密码了？用邮箱重置」入口 |
| `src/components/membership-card.tsx` | 改动 | 个人中心会员卡旁加「修改密码」入口 |
| `tests/password-flows.test.mjs` | **新增** | **32 项**：纯函数 + 静态契约 + 真 HTTP（公开/受保护页）+ 真浏览器 |

## 3. ⭐ 需要你在后台集中执行的清单

> 这三件事都在你那边点几下就完事；**先说结论：不做第 1 条的话，"忘记密码"的邮件会发不出去**
> （Supabase 会拒绝把这个跳转地址写进邮件），其它功能不受影响。

### ① Supabase → Authentication → URL Configuration：把下面两条加进 **Redirect URLs**

```
https://010034.xyz/auth/confirm
http://localhost:3000/auth/confirm
```

- 为什么要加：重置邮件里那条链接要回到我们站点的 `/auth/confirm`（由它换出会话）。
  Supabase 只允许跳到**白名单里**的地址，不在名单里**这封邮件就发不出去**。
- `Site URL` 保持你原来的（一般是 `https://010034.xyz`）即可。
- ⚠️ 地址必须**逐字**一致（含 `/auth/confirm` 这一段）；**不要**只写域名。

### ② Supabase → Authentication → Emails：确认「Reset password」邮件模板可用

- 默认模板（`{{ .ConfirmationURL }}`）**照用即可**，不用改。
- 顺手确认发信服务（SMTP）是通的：如果注册的确认邮件一直收得到，那这条也是通的。
- ⚠️ 内置邮件服务有**每小时几封**的限额，测试时别连着点很多次（超了会提示"请求过于频繁"）。

### ③ 上线后**自己点一遍**（这是唯一还没被自动测覆盖的一步）

自动测试**故意没有真改一次密码**（那要动共享测试账号的密码，中途失败会把账号留在未知密码上，
后续所有测试一起红）。所以请你自己走一遍，两条路各一次：

| 走哪条 | 步骤 | 应该看到 |
|---|---|---|
| 修改密码 | 登录 → 个人中心「修改密码」→ 填**当前密码** + 新密码两遍 → 保存 | 「密码已修改。这台设备上仍是登录状态…」；然后退出、用新密码登录成功 |
| 忘记密码 | 退出登录 → 登录页「用邮箱重置」→ 填你的邮箱 → 收邮件 → 点链接 | 跳到「设置新密码」页（页面上会写你的邮箱）→ 设新密码 → 用新密码登录成功 |
| 顺手验一个错误路径 | 在「修改密码」里**故意填错**当前密码 | 「当前密码不正确，请重新输入。」（不会改掉密码） |

> 如果第 1 条没配而点了"发送重置链接"：页面会显示 Supabase 返回的英文/中文报错
> （日志里是 `[password] 发送重置邮件失败: …`）—— 那就把报错发我。

## 4. 怎么验（自动化部分）

`tests/password-flows.test.mjs`（**32 项**，自己起 `next start`，独占 3000 端口）：

- **纯函数**：空表单 / 太短 / 两次不一致 / 太长 / 合法 / "新密码不能和当前密码一样" /
  **重置流程（当前密码为空）不许被误判成"和当前密码一样"**；
- **静态契约**（不许出现第二个来源 + 安全口径）：
  报错翻译只有一份、`"use server"` 文件里没有同步 export、
  **改密码必须把 `oldPassword` 交给校验**（只有重置流程才不传）、
  重置邮件 `redirectTo` 必须回到 `/auth/confirm?next=/reset-password`、
  重置页必须有 `reset=1` 隐藏字段、
  `/forgot-password` 是公开路径而 `/reset-password` **不是**；
- **真 HTTP**：未登录能开 `/forgot-password`（200）、登录页有入口、
  未登录开 `/reset-password` 与 `/account/password` 都被 307 挡住（后者带回跳地址）、
  登录后两页都能打开且 `/reset-password` **没有**"当前密码"那一栏；
- **真浏览器**：登录后打开修改密码页 → **空表单被浏览器原生校验挡住** →
  绕开原生校验再提交 → 服务端给出中文提示，且**没有**真的改掉密码。

### 4.1 变异自证（三条，全部实做）

| # | 把什么退回去 | 结果 |
|---|---|---|
| **M1** | `checkNewPassword` 的长度下限（`< 6` 改成 `< 1`） | **30/31**，红的正是"太短被拒" |
| **M2** | 动作里改成"总是把 `oldPassword` 交给校验"（重置流程不再跳过） | 第一次 **31/31 没红**（断言太松：只测了纯函数）⇒ 补一条**静态契约**后 **31/32**，红的正是那条 ✅ |
| **M3** | 把 `/reset-password` 也放进 `PUBLIC_PATHS` 并**重新构建** | **30/32**：静态契约 + 真 HTTP（未登录能打开了）**两处一起红** ✅ |

> ⚠️ **M2 的教训与上一批同款**：变异跑出"全绿"时先怀疑**断言写松了**，
> 而不是"这句代码无所谓"。这次补的是"直接对动作源码下契约"——因为动作本身要连 Supabase，
> 纯函数测不到它有没有把参数传下去。

## 5. 没做 / 刻意不做（记在这里）

- **不自己写 token 表**（见 §1）；
- **不做"改密码后强制所有设备下线"**：Supabase 的改密码会让其它 refresh token 失效，
  但**已经签发的 access token 最多还能活 1 小时**。这一点写在成功提示里
  （"别的设备请重新登录"）。要更狠就得逐请求校验，代价见 `project-overview.md` 第九节的安全取舍；
- **不做邮箱换绑**（改邮箱会涉及二次确认，属另一件事）；
- **不做密码强度计**（英文/数字/符号那种进度条）——Supabase 服务端已经会拒太弱的密码，
  前端再算一遍就是"两个来源"。
