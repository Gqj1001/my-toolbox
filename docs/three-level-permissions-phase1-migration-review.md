# Phase 1 权限迁移 · SQL 审阅说明（先别执行）

> 2026-10-24 · 按用户拍板的一期范围写的**审阅稿**。
> **0029/0031/0032 已执行；0030 已于 2026-10-26 执行（owner=1 / other_admin=0 / pending=0）。**

## 一、这次只给两份 SQL

| 文件 | 性质 | 是否改数据 | 建议 |
|---|---|---|---|
| `supabase/migrations/0029_permissions_phase1_schema.sql` | 只建表/加列/加索引/枚举 | **否** | ✅ 已执行 |
| `supabase/migrations/0031_permissions_phase1_rls.sql` | RLS + RPC scope + 建档快照触发器 | **否**（只改权限/函数/触发器） | ✅ 已执行；代码已全绿 |
| `supabase/migrations/0032_permissions_phase1_owner_self_only.sql` | 修正 Owner 个人直读边界（全量仍走 admin RPC） | **否** | ✅ 已执行 |
| `supabase/migrations/0030_permissions_phase1_backfill_REVIEW_ONLY.sql` | 回填老师/学生归属、补 `created_at`、Owner 切换、其他 admin 降级 | **是** | ✅ 已于 2026-10-26 执行（owner=1 / other_admin=0 / pending=0） |

> 为什么拆开：建表失败只影响新结构，回滚简单；Owner 切换/降级 admin 是**不可逆权限变更**，
> 必须单独审、单独执行、执行前备份。混在一起一旦回填有问题，事务虽然能回滚，但排查范围太大。

## 二、0029 做了什么（安全 DDL）

1. 新建 `regions`（大区）；
2. 新建 `campuses`（校区，`region_id` 必填；`(region_id,name)` 唯一）；
3. `user_profiles` 加 `region_id` / `campus_id`（老师**单校区**，不是多对多）；
4. `feedback_students` 加 `region_id` / `campus_id`（学生归属**快照**）/ `created_at`（可空，回填后再定非空）；
5. `user_roles` 加 `admin_scope`（owner/region/campus）/ `scope_id` / `campus_id`；
6. 加索引。

**不做**：
- 不插任何大区/校区（你在后台建）；
- 不改任何现有行；
- 不改 RLS/RPC/应用代码；
- 不加 `not null` 约束（回填后再加）。

**风险**：低。`add column if not exists`、`create table if not exists` 幂等；只增加结构，旧代码继续跑。

## 三、0030 做了什么（高风险，先别跑）

1. 老师资料：`user_profiles.campus` 文本 → `campuses.name` **精确匹配**；可另填临时别名映射表；
2. 学生档案：`extra.institutionCampus`（A2 手动纠正）优先 → 老师当前 `campus_id`；区域从校区带出；
3. `created_at`：最早历史记录时间，没有历史用档案 `updated_at`；
4. **Owner 切换**：
   - `1502569564@qq.com` → `role=admin, admin_scope=owner`；
   - 其他所有 `role=admin` → `role=user, admin_scope=null`；
5. 自检：Owner 恰好 1 个、其他 admin 为 0、待确认学生数量。

**风险**：
- 其他 admin 降级后，测试账号 `rolea` 会失去后台权限 → `admin-*` 测试会红；
  下一批代码必须给测试环境准备一个 **Test Owner** 账号，或把测试账号重新设 Owner（仅测试库）。
- 历史老师 `campus` 文本不统一（“燕郊”/“燕郊校区”）时，精确匹配会落空 → 进“待确认”，
  由 Owner 后台补；这符合你拍板的口径。
- 老师当前校区没回填时，学生也保持 null → 待确认，不会乱猜。
- 降级 admin 是**权限变更**，不是普通数据回填；执行前必须备份 `user_roles`。

## 四、建议执行顺序（确认后）

1. 备份三张表：`user_roles` / `user_profiles` / `feedback_students`；
2. 大区/校区已建（本次已用 SQL 建好廊坊大区 + 4 校区）；
3. `0029` **已执行**（安全 DDL）；
4. `0031` **已执行**（RLS + RPC scope + 建档快照触发器）、`0032` **已执行**（Owner 个人直读边界）；
   代码已写完、编译通过、`region-scope` 17/17、全套 57 套 / 1833 项回归全绿；
5. 跑待确认查询，先看有多少老师/学生匹配不上；
6. 在 `0030` 里填临时映射表（或先补老师资料），**最后**执行 `0030`（Owner 切换 + 降级其他 admin）；
7. **0030 之后（仅测试库）**：执行 `tests/test-owner-setup.sql`，把 rolea 设为 Test Owner；
   先跑 `tests/test-owner-preflight.test.mjs`，再跑全套（预期 57 套 / 1833 项全绿）；
8. 验证：
   - 真实 Owner 账号能进 `/admin`；
   - 原 rolea 测试账号在**生产**已降级（生产不要跑 test-owner-setup）；
   - `pending_students` 数量；
   - 大区管理员只读，不能改档案/角色。

## 五、RLS/RPC 已经写好了什么

`0031_permissions_phase1_rls.sql` 已包含：
1. `is_owner()` / `is_region_admin()` / `is_campus_admin()` / `has_archive_scope()` / `can_read_student()`；
2. `feedback_students` / `feedback_history` 的 SELECT 策略（老师本人策略保留；管理员只读）；
3. `admin_list_all_students()` / `admin_archive_stats()` / `admin_list_profiles()` 按 `auth.uid()` 的 scope 过滤；
4. `admin_set_student_campus()` 只 Owner 可调用；
5. `regions` / `campuses` / `user_profiles` 的 RLS；
6. 学生建档快照触发器（新学生自动带 region_id/campus_id/created_at）。
7. `0032` 修正：Owner 的**个人** `/api/students` / 档案页仍只看自己；全量只看走 admin RPC，
   避免同名学生被 Owner 的直读合并覆盖（`students-unified` 回归发现并修复）。

> 所以现在不会出现“只加 RLS、RPC 仍看全部”的假安全问题。

## 六、0030 执行前最后确认

1. `0030` 的 Owner 邮箱/降级范围确认无误吗？执行前是否先备份 `user_roles`？
2. 0030 执行后 `rolea` 会降级为普通 user：**生产**这是预期；
   **测试库**需执行 `tests/test-owner-setup.sql` 把 rolea 设为 Test Owner，否则所有 admin 测试会红。
3. `test-owner-preflight` 会先检查 rolea 是 admin + owner（或 0030 前 legacy）；
   不满足时它会明确提示跑 `tests/test-owner-setup.sql`，不会让你跑一半才红。
4. 0030 后的测试预期：
   - 测试库先跑 `tests/test-owner-setup.sql` → `test-owner-preflight` 3/3；
   - 全套 57 套 / 1833 项全绿；
   - 生产库只有真实 Owner，**不要**在生产跑 `test-owner-setup.sql`。
5. 大区/校区清单已建好；回填后“待确认”学生由 Owner 后台手动改。

> 0030 已于 2026-10-26 执行；0029/0031/0032 也已执行。应用代码本轮已 commit + push。
