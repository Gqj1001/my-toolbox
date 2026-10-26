# 三级权限架构升级方案（Owner / 大区 / 校区 / 教师）

> 2026-10-24 · **Phase 1 已完成并上线；0030 Owner 切换已于 2026-10-26 执行**。
> 用户拍板：作者（Owner）> 大区管理者 > 校区管理者 > 普通教师；
> **Owner 唯一 = `1502569564@qq.com`**；其他 admin 全部降级为普通 user；
> 老师一人只能属于一个校区；大区/校区清单由 Owner 在后台建；
> 一期只做 **Owner + 大区只读**，校区管理员二期；历史回填后“待确认”由 Owner 后台手动改；
> 学生归属用**快照**，不跟老师调动走；大区/校区管理者一期**只读**。
>
> 迁移状态：
> - `0029_permissions_phase1_schema.sql` ✅ 已执行（只建表/加列）
> - `0031_permissions_phase1_rls.sql` ✅ 已执行（RLS + RPC scope + 建档快照触发器）
> - `0032_permissions_phase1_owner_self_only.sql` ✅ 已执行（Owner 个人直读只自己；全量只走 admin RPC）
> - `0030_permissions_phase1_backfill_REVIEW_ONLY.sql` ✅ 已于 2026-10-26 执行（owner=1 / other_admin=0 / pending=0）
> - 0030 后**测试库**先跑 `tests/test-owner-setup.sql`（rolea = Test Owner），再跑全套；
>   `test-owner-preflight` 会检查，避免整套跑一半才红。
> - 审阅说明：`docs/three-level-permissions-phase1-migration-review.md`
>
> 本文在已上线的 A2（只读总览 + `extra.institutionCampus` 归属标签）基础上，
> 给出**真正的三级权限**需要动哪些表、RLS 怎么写、历史数据怎么迁、风险和工作量。

---

## 一、现状与差距

| 层 | 现状 | 差距 |
|---|---|---|
| 角色 | `user_roles.role` 只有 `admin` / `user`；`is_admin()` 只判断 `admin` | 所有 admin 等价，没有 Owner / 大区 / 校区 |
| 机构校区 | `user_profiles.campus` 是**自由文本**；A2 用 `extra.institutionCampus` 做学生级纠正 | 没有 `campuses` 表 / 稳定 ID；不能按校区建 RLS |
| 大区 | 无 | 没有 `regions` 表；校区无法归属大区 |
| 学生归属 | `feedback_students.user_id`（创建老师）+ 学生 `campus`（学生学校，**不是机构校区**） | 没有 `campus_id` / `region_id` 快照；老师调校区会改变历史推断 |
| 读取 | 老师 owner-only RLS；后台走 0026/0027/0028 SECURITY DEFINER 函数 | 函数只判 `is_admin()`，没有范围参数；不能按大区/校区过滤 |
| 写入 | 老师写自己的；管理员不能改别人档案 | “大区/校区管理者”是否可写未定义（建议一期只读） |

> 关键结论：**不要只给 `role='admin'` 加一个枚举值**。必须加“范围（大区/校区）”和“范围 ID”，
> 否则无法表达“大区管理者看本大区、校区管理者只看本校”。

---

## 二、目标角色模型

建议保留 `role` 兼容现有代码，新增 `admin_scope` + `scope_id`：

```
user_roles
  role          user_role       -- 'admin' | 'user'（保留，兼容）
  admin_scope   admin_scope     -- 'owner' | 'region' | 'campus' | null
  scope_id      uuid            -- region_id / campus_id；owner 为 null
  campus_id     uuid            -- 可选冗余，便于 RLS 直接判断
```

| 角色 | 判定 | 能看 | 能改 |
|---|---|---|---|
| **Owner（作者）** | `role=admin, admin_scope=owner` | 全部大区/校区/教师 | 全部（但建议界面仍以“只读总览”为主） |
| **大区管理者** | `role=admin, admin_scope=region, scope_id=region_id` | 本大区所有校区学生 | 一期**只读**；可看本大区大盘 |
| **校区管理者** | `role=admin, admin_scope=campus, scope_id=campus_id` | 本校区的学生 | 一期**只读**；可看本校区大盘 |
| **普通教师** | `role=user` | 自己创建的档案/历史 | 自己的档案/历史 |

> 为什么不用 `role='owner'/'region_admin'` 直接加枚举：
> ① 现有 `is_admin()`、`requireAdmin()`、RLS 大量按 `role='admin'` 判断，直接改枚举会一次性打断；
> ② 大区/校区管理者仍需要“admin 后台入口”，保留 `role=admin` + scope 更平滑；
> ③ 以后加“只读审计员”只需加 scope 值，不动 `role`。

---

## 三、需要新增/修改的表

### 1. 新表 `regions`（大区）

```sql
create table public.regions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);
```

- 初期可只建“燕郊大区 / 大厂大区”等 2–4 条；
- 大区是**机构管理维度**，不是地理行政区的自动推导。

### 2. 新表 `campuses`（校区）

```sql
create table public.campuses (
  id         uuid primary key default gen_random_uuid(),
  region_id  uuid not null references public.regions(id) on delete restrict,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (region_id, name)
);
```

- 校区名允许跨大区重名（如两个“燕郊校区”在不同大区），所以唯一键是 `(region_id, name)`；
- 展示时用 `大区 / 校区`。

### 3. `user_profiles` 加两列（老师归属）

```sql
alter table public.user_profiles
  add column region_id uuid references public.regions(id),
  add column campus_id uuid references public.campuses(id);
-- 保留原 campus text 做显示/兼容；campus_id 是权威
```

- 老师资料页的“校区”从自由文本改成**下拉选择**（大区 → 校区）；
- 原 `campus` 文本保留只读/兼容，写新值时同步写 `campus_id`，避免老代码读空。

### 4. `feedback_students` 加两列（学生归属快照）

```sql
alter table public.feedback_students
  add column region_id uuid references public.regions(id),
  add column campus_id uuid references public.campuses(id),
  add column created_at timestamptz not null default now();
```

- **快照**：学生建档时把老师当时的 `region_id/campus_id` 写入；老师以后调校区，不自动改历史学生；
- 后台“归属纠正”从 A2 的 `extra.institutionCampus` 升级为写 `campus_id`（同时保留 extra 兼容）；
- `created_at` 补上后，大盘“本月新增”不再靠历史记录推断（也是技术债清理）。

### 5. `feedback_history` 不一定要加列

- 历史记录通过 `(user_id, student_name)` 关联学生；
- 按校区查历史用 `exists (select 1 from feedback_students s where ... and s.campus_id = ...)`；
- 如果大盘/列表经常按校区查历史，可加冗余 `region_id/campus_id`（写入时从学生快照带），但会增加写路径复杂度，**建议二期再做**。

### 6. `user_roles` 加 scope

```sql
create type public.admin_scope as enum ('owner', 'region', 'campus');

alter table public.user_roles
  add column admin_scope public.admin_scope,
  add column scope_id uuid,
  add column campus_id uuid references public.campuses(id);
```

- **不新增 `role` 枚举值**；`role='admin'` 仍是后台入口；
- Owner：`admin_scope='owner', scope_id=null`；
- 大区：`admin_scope='region', scope_id=regions.id`；
- 校区：`admin_scope='campus', scope_id=campuses.id`；
- 约束（建议用 CHECK）：
  - `admin_scope='owner'` 时 `scope_id is null`；
  - `admin_scope='region'` 时 `scope_id` 必须是 regions.id（SQL 里用触发器或应用层校验）；
  - `admin_scope='campus'` 时 `scope_id` 必须是 campuses.id。

---

## 四、RLS 重新设计

### 1. 范围判断函数（SECURITY DEFINER，避免递归）

```sql
-- 示意，不是可执行迁移
create function public.current_admin_scope() returns text ...
create function public.current_scope_id() returns uuid ...
create function public.is_owner() returns boolean ...
create function public.can_read_student(p_region_id uuid, p_campus_id uuid, p_owner_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select
    p_owner_id = (select auth.uid())
    or public.is_owner()
    or exists (
      select 1 from public.user_roles r
      where r.user_id = (select auth.uid())
        and r.role = 'admin'
        and r.admin_scope = 'region'
        and r.scope_id = p_region_id
    )
    or exists (
      select 1 from public.user_roles r
      where r.user_id = (select auth.uid())
        and r.role = 'admin'
        and r.admin_scope = 'campus'
        and r.scope_id = p_campus_id
    );
$$;
```

- 关键：函数内部查 `user_roles` 必须有 `security definer`，否则 RLS 递归；
- `search_path=''`，全部 `public.` 前缀；
- `is_owner()` 只认 `role=admin and admin_scope=owner`（**不再**“所有 admin 都是 owner”）。

### 2. `feedback_students` 策略

```sql
drop policy if exists "students read by scope" on public.feedback_students;
create policy "students read by scope"
  on public.feedback_students for select to authenticated
  using (public.can_read_student(region_id, campus_id, user_id));

-- 写：老师只能写自己的；Owner 可以写全部；大区/校区管理者一期只读
create policy "students write own"
  on public.feedback_students for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_owner());
```

- 现有 `own students read/insert/update/delete` 要**替换**，不是叠加（旧策略 `using user_id=auth.uid()` 会把管理员挡掉）；
- `feedback_history` 同理：`using (exists (select 1 from feedback_students s where s.user_id=feedback_history.user_id and s.name=feedback_history.student_name and public.can_read_student(...)))`；
- 注意 RLS 子查询性能：给 `feedback_students (user_id, name)` 唯一索引已有；再补 `(campus_id, region_id)`。

### 3. 后台 RPC 改造

现有：
- `admin_list_profiles()`（0026）
- `admin_list_all_students()`（0027/0028）
- `admin_set_student_campus()`（0027）
- `admin_archive_stats()`（0028）

改造原则：
- 所有 RPC 不直接 `is_admin()` 放行全部，而是：
  ```sql
  if not public.is_owner() and not public.is_region_admin() and not public.is_campus_admin() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  ```
- `admin_list_all_students` 内部按当前 scope 过滤：
  - Owner：无过滤；
  - 大区：`s.region_id = current_scope_id()`；
  - 校区：`s.campus_id = current_scope_id()`；
- 大盘 `admin_archive_stats` 同样按 scope 聚合；校区管理者只看自己校区，大区看本大区；
- **不要**在 RPC 参数里让前端传 `region_id` 就信 —— 范围必须从 `auth.uid()` 查 `user_roles`，不能信请求体。

### 4. 权限函数/后台入口

- `requireAdmin()` 改成 `requireAdminScope()`：返回 `{scope, scopeId}`；
- 后台 `/admin` 用户管理只给 Owner；
- `/admin/archives` 对 Owner/大区/校区开放，但页面按 scope 显示“当前范围：大区/校区”；
- 普通教师访问 `/admin/*` 仍 307 到 `/tools`（现有中间件保留）。

---

## 五、历史数据迁移

### 1. 迁移顺序（必须分步，不能一把梭）

1. **建表**：`regions`、`campuses`；插入初期大区/校区；
2. **加列（可空）**：`user_profiles.region_id/campus_id`、`feedback_students.region_id/campus_id/created_at`、`user_roles.admin_scope/scope_id/campus_id`；
3. **回填老师资料**：把现有 `user_profiles.campus` 文本按人工映射表对应到 `campuses.id`；无法对应的列成“待确认”；
4. **回填学生快照**：按创建老师的 `campus_id` 回填；如果学生 `extra.institutionCampus` 有手动纠正，优先用它；
5. **回填 Owner**：指定唯一 Owner 的 `user_roles.admin_scope='owner'`；其余现有 admin 先置空 scope（后台只给 Owner，避免误授权）；
6. **加约束/非空**：确认无 null 后，再考虑 `campus_id not null`（建议先不加，保留“未归属”）；
7. **切换 RLS/RPC**：旧策略保留一个短窗口，验证后删除；
8. **回归 + 真实账号验收**。

### 2. 数据量/风险

| 数据 | 迁移方式 | 风险 |
|---|---|---|
| `user_profiles.campus` 自由文本 | 人工映射到 `campuses.id` | 写法不统一（“燕郊”/“燕郊校区”）、新校区无记录、老师多校区 |
| `feedback_students` 历史归属 | 按创建老师当前校区回填 | 老师已调校区 → 历史归属错；A2 的 `extra.institutionCampus` 可纠正 |
| 现有 admin | 只把指定账号设为 Owner，其余置空 | 现有测试 admin（rolea）会失去后台权限，测试需调整 |
| `feedback_history` | 不直接回填，靠学生关联 | 学生改归属后历史跟着变（快照在 student 上，可控） |
| `created_at` | 新列 default now，老数据回填 `updated_at` | “本月新增”老数据只能近似 |
| 老师调动 | 新学生按新校区，老学生保留快照 | 需要后台“批量调整归属”工具（二期） |

### 3. 回填 SQL 思路（示意）

```sql
-- 老师资料：按人工映射表
update public.user_profiles p
set campus_id = m.campus_id
from public._campus_mapping m
where p.campus = m.old_text and p.campus_id is null;

-- 学生：优先手动纠正，其次老师当前校区
update public.feedback_students s
set campus_id = coalesce(
  (select c.id from public.campuses c
    where c.name = s.extra ->> 'institutionCampus' limit 1),
  p.campus_id
)
from public.user_profiles p
where p.user_id = s.user_id and s.campus_id is null;

-- 学生 region_id 从 campus 带出
update public.feedback_students s
set region_id = c.region_id
from public.campuses c
where c.id = s.campus_id and s.region_id is null;
```

> 上面的 `_campus_mapping` 是**一次性人工确认表**，不要留在生产；回填完成即删。

---

## 六、风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **所有 admin 被误升级** | 现有 2 个 admin 都可能变成 Owner/大区 | 只把用户指定的一个账号设 Owner；其余 scope 置空；上线前核对 |
| **RLS 递归/性能** | 策略里查 `user_roles` 每行一次，可能慢/递归 | 全部用 SECURITY DEFINER 函数 + `(select auth.uid())`；加索引；压测 |
| **历史归属错** | 大区/校区管理者看到不该看的学生 | 先按老师当前校区回填 + 人工确认清单；保留手动纠正；不要静默猜 |
| **老师调校区** | 历史学生归属变化或错 | 学生存快照 `campus_id`，不随老师资料变；调校区只影响新学生 |
| **写权限扩大** | 大区/校区管理者改别人档案，责任不清 | 一期**只读**；写只给 Owner/本人；二期再讨论审计 |
| **旧 RLS 叠加** | 新策略加了但旧 `own` 还在，管理员仍看不到 | 迁移时**替换**旧策略，先 `drop policy` 再建；测试覆盖管理员读 |
| **测试账号失效** | 测试 admin 不是 Owner，后台 403 | 测试环境显式给 test admin scope；或保留一个测试 Owner 账号 |
| **迁移中断** | 列加了一半、RLS 切了一半 | 分阶段可空加列 → 回填 → 切 RLS；每步可回滚；先备份 |
| **A2 功能回退** | `/admin/archives` 依赖 0027/0028，改 RPC 可能断 | 保留旧函数签名兼容一个版本；新 RPC 加 scope 参数/内部判断；逐步切页面 |

---

## 七、工作量估算

| 阶段 | 内容 | 人日 |
|---|---|---:|
| 0 | 需求确认：大区/校区清单、Owner 账号、谁能写、历史归属确认人 | 0.5–1 |
| 1 | 建 `regions`/`campuses`，老师资料选择器 + 回填 | 2–3 |
| 2 | 学生 `region_id/campus_id/created_at` + 回填 + 归属纠正升级 | 2–3 |
| 3 | `user_roles` scope + 后台角色管理 + Owner 指定 | 1–2 |
| 4 | RLS 函数/策略重写 + 0026–0028 RPC scope 化 | 3–4 |
| 5 | 后台页面按 scope 显示 + 大区/校区大盘 | 2 |
| 6 | 全套回归 + 真实账号验收 + 文档 | 1.5–2 |
| **合计** |  | **12–17 人日**（不含历史数据人工确认） |

> 如果只做“Owner + 大区只读”，不做校区管理员，可压到 **7–9 人日**；
> 但表/字段仍建议一次设计到位，避免二次迁移。

---

## 八、建议落地顺序（等用户确认）

1. **先定清单**：大区名、校区名、每个老师归属、唯一 Owner 账号；
2. **只做“Owner + 大区只读”一期**：先验证 RLS 与大盘范围，不开放校区写；
3. **再加校区管理员**：只读，复用同一套 scope 函数；
4. **最后讨论写权限/审计**：不建议一期开放跨校区改档案；
5. A2 的 `/admin/archives` 保留，作为 Owner 的“全量只读总览”；大区/校区管理者看到的是**按 scope 过滤后的同一页面**。

---

## 九、需要用户拍板的问题

1. 大区/校区清单由谁提供？是否允许一个老师属于多个校区？
2. 唯一 Owner 账号是哪一个（邮箱）？现有其他 admin 是否降为普通教师/校区管理者？
3. 大区/校区管理者**只看**，还是也要改档案/改老师资料？
4. 历史学生归属：按“创建老师当前校区”回填后，谁负责核对“待确认”清单？
5. 老师调校区后，老学生是否跟着转？建议**不转**（快照），由后台按需批量调整。
6. 是否一期只做“Owner + 大区只读”，校区管理员二期？

> 本文**没有改任何表、没有写迁移、没有改代码**。等以上问题确认后，再按第七节分阶段实施。
