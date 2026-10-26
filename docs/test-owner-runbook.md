# 测试账号 Runbook（0030 之后）

## 结论先说

当前仓库**没有** `SUPABASE_SERVICE_ROLE_KEY`，也没有数据库直连串（`.env.local` 只有 URL + anon key）。
因此测试代码**不能**自动把 rolea 提权；硬编码提权 RPC 会变成线上后门，不能做。

以后跑全套，按下面三步：

1. 在 Supabase SQL Editor 执行 `tests/test-owner-grant.sql`；
2. 跑 `tests/test-owner-preflight.test.mjs`（应为 3/3），再跑全套；
3. **无论测试成功还是失败，马上**执行 `tests/test-owner-revoke.sql`，把 rolea 降回普通 user。

生产库只在测试窗口内临时提权；不要在线上长期保留 Test Owner。

---

## 两个 SQL

### 提权（测试前）

`tests/test-owner-grant.sql`

```sql
update public.user_roles r
set role = 'admin',
    admin_scope = 'owner',
    scope_id = null,
    campus_id = null,
    plan = coalesce(r.plan, 'free'),
    status = coalesce(r.status, 'active'),
    updated_at = now()
from auth.users u
where u.id = r.user_id
  and u.email like 'rolea-%@gmail.com';

insert into public.user_roles (user_id, role, plan, status, admin_scope, scope_id, campus_id)
select u.id, 'admin', 'free', 'active', 'owner', null, null
from auth.users u
where u.email like 'rolea-%@gmail.com'
  and not exists (select 1 from public.user_roles r where r.user_id = u.id);

select u.email, r.role, r.admin_scope, r.scope_id, r.campus_id
from public.user_roles r
join auth.users u on u.id = r.user_id
where u.email like 'rolea-%@gmail.com';
```

### 降级（测试后）

`tests/test-owner-revoke.sql`

```sql
update public.user_roles r
set role = 'user',
    admin_scope = null,
    scope_id = null,
    campus_id = null,
    updated_at = now()
from auth.users u
where u.id = r.user_id
  and u.email like 'rolea-%@gmail.com';

select u.email, r.role, r.admin_scope, r.scope_id, r.campus_id
from public.user_roles r
join auth.users u on u.id = r.user_id
where u.email like 'rolea-%@gmail.com';
```

降级只改角色，不动 `plan/status/expires_at`（roleb 的会员不受影响）。

---

## 标准流程

```bash
# 1) SQL Editor：执行 tests/test-owner-grant.sql

# 2) 前置检查：应为 3/3
node tests/test-owner-preflight.test.mjs

# 3) 全套：应 57 套 / 1833 项全绿
node ..\.tmp-planning-samples\run-full-regression.mjs

# 4) SQL Editor：立刻执行 tests/test-owner-revoke.sql
```

如果全套中途失败/中断，**也要先执行 revoke**，再排查。

---

## 降级后哪些套件会红（预期）

没有 Test Owner 时，以下套件依赖 rolea 的管理员权限，会红（2026-10-26 降级后实测）：

- `test-owner-preflight`：1/3（前置检查故意失败）
- `admin-feature-flags`：8/14
- `admin-grant90`：3/5
- `admin-profiles`：3/4
- `admin-archives`：7/18
- `region-scope`：12/17
- `verify-checklist`：14/18

以下套件也依赖管理员权限（需要先起服务，未逐一跑，预计红）：
`step7-api` / `step7-ui`、`paper-analysis`、`students-unified`、`middleware-cache`、`paper-regression`、`feedback-client-cache` / `feedback-data-cache`。

其余套件不依赖管理员，降级后仍应绿。

---

## 大区管理员测试会不会污染线上？

`region-scope` 只做临时操作：

1. 用现有“廊坊大区 / 燕郊中学校区”；
2. 临时把 roleb 设为大区管理员；
3. 创建 `__区域探针A__` / `__区域探针B__` 两个学生及历史；
4. 断言 RLS / RPC / 页面只读；
5. 收尾恢复 roleb 为普通 user、清空探针资料、删除两个探针学生。

不会新建大区/校区，不会改线上真实学生。若测试中断，按上面“收尾”手工清理探针即可；
roleb 若残留大区权限，执行：

```sql
update public.user_roles r
set role = 'user', admin_scope = null, scope_id = null, campus_id = null, updated_at = now()
from auth.users u
where u.id = r.user_id and u.email like 'roleb-%@gmail.com';
```

---

## 为什么不自动提权

- 没有 service_role / DB 直连；
- 用 anon key 写一个“自动提权”RPC，等于给线上留后门；
- 测试代码也不应知道真实 Owner 密码。

所以采用“手动 SQL + 前置检查 + 跑完立刻降级”的流程；这是当前条件下最安全的做法。
