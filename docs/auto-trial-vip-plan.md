# 新注册用户自动送 15 天会员（迁移 `0023`）

> **一句话**：在 Supabase 的 `auth.users` 上加一个数据库触发器 —— 以后**每一个新注册的人**
> 都会自动得到 `vip / active / 到期时间 = 注册时刻 + 15 天`。
> 不写前端、不改注册接口；用户注册完直接关页面也不会漏。
>
> **现状（2026-10-20）**：✅ **已执行并验证通过** —— 用户已在 Supabase 跑过
> `0023_auto_grant_vip.sql` 与运行期自检，看到「自动获得 15 天会员」。
> 只对执行之后新注册的人生效；**老用户不回溯**。

---

## 1. 用户原话与硬要求

> 「为了让新用户能无门槛体验 AI 功能，要求每个新注册的用户，默认自动获得 15 天的会员（VIP）体验期。」

必须遵守：

1. **不能写在前端或注册页面里，也不能改现有注册接口** —— 万一用户注册完直接关页面就漏了；
2. 在 **Supabase 数据库层面**加 Trigger：`auth.users` 新增一行时，自动往 `user_roles` 插一条；
3. 规则固定：`plan='vip'`、`status='active'`、`expires_at = now() + interval '15 days'`；
4. 建 Trigger 不算改表结构，但要写成**独立 migrations 文件**（`0023_auto_grant_vip.sql`）；
5. **不能覆盖/冲突**管理员后台已经手动开通的会员；
6. 能本地测就测；不能就在文档里写清楚测试步骤。

---

## 2. 为什么放在数据库触发器（而不是注册代码）

| 方案 | 问题 |
|---|---|
| 改 `signUp()` / 注册页 | 用户明确禁止；而且以后换注册方式（后台建用户、邀请、第三方登录）就会漏 |
| 注册成功后前端再调一个接口 | 用户注册完直接关页面就漏了；也不可靠 |
| **`auth.users` after insert 触发器** | **所有**注册路径最终都会插 `auth.users`；注册一成功就落库，不依赖浏览器 |

触发器在**同一个数据库事务**里执行：注册成功 = 会员行也在；不会出现“注册成功但没送”的中间态。

---

## 3. 规则与兼容性

**触发器逻辑（`supabase/migrations/0023_auto_grant_vip.sql`）**：

```
auth.users 插入一行
  → 往 public.user_roles 插入：
      user_id    = new.id
      role       = 'user'          （普通用户，不自行提权）
      plan       = 'vip'
      status     = 'active'
      expires_at = now() + interval '15 days'
  → on conflict (user_id) do nothing
```

**四条兼容性保证**：

| 场景 | 行为 |
|---|---|
| 管理员后来点「开通 90 天 / 取消会员 / 封禁」 | 都是 **update**，触发器只监听 **insert**，**不会碰** |
| 这一行已经存在（任何原因） | `on conflict (user_id) do nothing` ⇒ **原样保留，不改写** |
| 已注册的**老用户** | **不回溯**：没有任何 update/backfill，老用户保持原样 |
| 触发器自身失败（缺列/被锁/权限） | 只 `raise warning` 并放行注册，**注册不会失败**；新用户按免费版处理，日志里能看到 warning |

> ⚠️ **为什么不“有 row 就改成 vip”**：那会覆盖管理员已经做的操作（比如刚把某人设成免费/封禁）。
> 用户特别点名“不能覆盖或冲突”，所以选 `do nothing`。

> ⚠️ **15 天从“注册”开始算，不是从“点邮件确认”开始算**。
> 用户要求的是 `auth.users` 新增时触发；如果某个人注册后隔了 10 天才确认邮箱，
> 他实际能用的体验期只剩 5 天。**如果你希望从“首次登录/邮箱确认”开始算**，
> 要改成 `after update of email_confirmed_at` 的触发器 —— 这是另一个口径，需要你拍板。

---

## 4. 怎么在 Supabase 执行

1. 打开 Supabase → 你的项目 → **SQL Editor** → New query；
2. 把 `supabase/migrations/0023_auto_grant_vip.sql` **整段**粘进去 → Run；
3. 看到 Success 即可（可重复执行，不会重复建触发器）。

> 这条 SQL **不改表结构**（没有 add/drop column、没有 create table），
> 只新增一个函数 + 一个触发器。回滚方法在文件末尾（注释里）。

---

## 5. 怎么验（推荐先跑“运行期自检”）

### 方案 A（推荐）：事务内自检，**不会留下任何数据**

1. Supabase → SQL Editor → New query；
2. 把 `supabase/tests/0023_auto_grant_vip_test.sql` **整段**粘进去 → Run；
3. 成功时最后一条消息是：

```
NOTICE:  OK：新用户自动获得 vip / active / 15 天
```

它会在一个事务里插一个临时 `auth.users` 行（`@example.com`，**不会发邮件**），
检查触发器有没有自动建 `user_roles` 行、`plan/status/expires_at` 对不对，最后 **ROLLBACK**。
所以**不会留下测试用户、也不会留下会员行**。

> 如果报 `FAIL：触发器没有为新用户建 user_roles 行`：说明 0023 没执行成功，或触发器报 warning；
> 回头查 `0023` 是否 Run 成功、`user_roles` 的 `plan/status/expires_at` 列是否都在。
> 如果中途报错，事务是“已中止”状态，不会写入任何数据；再执行一句 `rollback;` 即可。

### 方案 B：后台手动建一个测试用户（更直观）

1. Supabase → **Authentication → Users → Add user**：填一个测试邮箱（如 `trial-test-<日期>@example.com`）、
   密码，勾选 **Auto Confirm User**；
2. SQL Editor 跑：

```sql
select u.email,
       r.plan,
       r.status,
       r.expires_at,
       round(extract(epoch from (r.expires_at - now())) / 86400.0, 2) as days_left
from auth.users u
join public.user_roles r on r.user_id = u.id
where u.email = 'trial-test-<日期>@example.com';
```

期望：`plan=vip`、`status=active`、`days_left ≈ 15`。

3. **兼容性**：在网站 `/admin` 给这个测试用户点「开通 90 天」；
   再跑上面的 SQL，`days_left` 应变成 **≈ 90**（触发器没有覆盖管理员操作）。
4. 清理：Authentication → Users → 删除这个测试用户
   （`user_roles.user_id` 有 `on delete cascade`，会跟着删）。

---

## 6. 测试覆盖（诚实说明）

| 层 | 文件 | 覆盖 |
|---|---|---|
| 静态契约 | `tests/signup-trial-vip.test.mjs`（**12 项**） | 触发器在 `auth.users` after insert、规则精确（15 天）、`on conflict do nothing`、不回溯、异常不阻断注册、幂等、不改表结构、运行期自检文件存在 |
| 运行期 | `supabase/tests/0023_auto_grant_vip_test.sql` | 真插一个临时 `auth.users` 行 → 检查 `user_roles` → rollback（**要你在 SQL Editor 跑**） |
| 手动兼容性 | 本文 §5 方案 B 第 3 步 | 管理员开 90 天后，触发器不覆盖 |

⚠️ **为什么不写成 Node 自动测试**：本地只有 `anon` key，**没有 `service_role`**；
在 Node 里建 auth 用户要么需要 `service_role`，要么用公开 signup（会真的发确认邮件、
而且删不掉测试用户）。所以运行期验证放在 SQL Editor，事务 + rollback，既不依赖密钥也不留垃圾。
静态契约测试已加入全套回归（**54 套 / 1798 项**），每次都会检查 SQL 没被改坏。

---

## 7. 回滚

```sql
drop trigger if exists on_auth_user_created_grant_trial_vip on auth.users;
drop function if exists public.grant_trial_vip_on_signup();
```

⚠️ 回滚只停止**以后**的赠送；**已经发出去的 VIP 行不会自动收回**。
要收回得在后台逐个取消，或另写 SQL（先问用户，别自己跑）。

---

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `supabase/migrations/0023_auto_grant_vip.sql` | **要执行的迁移**：函数 + `auth.users` 触发器 |
| `supabase/tests/0023_auto_grant_vip_test.sql` | **运行期自检**（事务 + rollback，不留数据） |
| `tests/signup-trial-vip.test.mjs` | 静态契约测试（12 项，已进全套回归） |
| `docs/auto-trial-vip-plan.md` | 本文件 |

---

## 9. 还没做 / 待你拍板

- **不回溯老用户**（当前口径）。如果你想让“已经注册的免费用户”也拿 15 天，那是**另一条
  backfill SQL**，会一次性给一批人开会员，风险大，必须先单独确认。
- **15 天从注册算**（当前口径）。想改成“从邮箱确认/首次登录算”，需要换触发器事件。
- **没有在线支付**、**没有“试用到期自动提醒”** —— 不在本次范围。
