# 跨校区档案管理与权限升级方案（A2 已落地）

> 2026-10-24 · 用户提出「超级管理员能看所有校区的所有学生档案」。
> 本文回答三个问题：现在能不能直接让 admin 看全部？分级要动哪些表？风险和工作量多大？
> **结论先行：现在的 `role='admin'` 看不到别人的档案；要让 admin 看全部，不改表也能做（选项 A），
> 但「超级管理员 / 校区管理员」分级必须加校区维度和角色范围（选项 B）。建议先做 A 的“只读总览”，
> 再决定要不要上 B。**

> ✅ **2026-10-24 已按用户拍板落地 A2（只读总览）**：
> - 迁移 `0027_admin_archives_a2.sql`：`admin_list_all_students()`（只读、搜索/校区/老师筛选）
>   + `admin_set_student_campus()`（只纠正 `extra.institutionCampus` 归属标签，不改档案正文）；
> - 后台页面 `/admin/archives`（从 `/admin` 进入）；
> - 口径：老板**只看**；校区=**机构校区**；历史默认按**创建老师当前校区**推断；
>   推错可在总览最右列手动纠正；目前只有老板要超级权限；
> - **未动**现有 RLS、未改老师端、未加表/列。

---

## 一、现状（代码与数据库的真实行为）

| 层 | 现状 | 后果 |
|---|---|---|
| 角色 | `user_roles.role` 只有 `admin` / `user` 两个值；`is_admin()` 只判断 `role='admin'` | 没有“超级 / 校区”之分，所有 admin 等价 |
| 学生档案 `feedback_students` | RLS 四条策略都是 `user_id = auth.uid()`（0004 迁移） | **管理员也只能读自己创建的档案**，看不到别的老师的学生 |
| 历史 `feedback_history` | 同上，`user_id = auth.uid()` | 同上；管理员看别人的记录也会被 RLS 过滤 |
| 教师资料 `user_profiles` | RLS 只允许本人读；后台原本直接查全表 ⇒ 一直「资料未填」 | 本轮已用 `0026_admin_list_profiles()` 修（SECURITY DEFINER + `is_admin()`） |
| “校区”字段 | `user_profiles.campus` 是**老师所在机构校区**；`feedback_students.campus` 是**学生就读学校** | 两个“校区”同名不同义，**不能直接拿来按机构校区过滤** |
| 学生归属 | `feedback_students.user_id` 是创建者（老师） | 可按“老师 → 老师资料里的机构校区”间接归属；老师换校区会连带历史归属变化 |

> ⚠️ 所以第一个问题的答案是：**不能只靠改接口逻辑**。接口用的是用户会话，RLS 在数据库层
> 就把别人的行过滤掉了；必须在数据库层开一个受控读口（RLS 策略或 SECURITY DEFINER 函数/RPC），
> 或者在服务端用 `service_role`（本项目本地/线上都没有配，且不适合把 service_role 放页面请求里）。

---

## 二、选项 A：不新增角色，让现有 admin 看全部

### 做法（两种，任选其一）

**A1. 放宽 RLS（快，但所有 admin 都变成超级管理员）**

```sql
-- 示意，不是可执行迁移
create policy "admins read all students"
  on public.feedback_students for select to authenticated
  using (public.is_admin());

create policy "admins read all history"
  on public.feedback_history for select to authenticated
  using (public.is_admin());
```

- 工作量：**0.5–1 天**（迁移 + 回归 + 权限测试）。
- 优点：现有页面/接口几乎不用改，管理员打开 `/dashboard` 就能看到全部（如果页面查询不带 `user_id` 过滤）。
- 缺点：
  - **所有 admin 都是超级管理员**，没有校区边界；
  - 档案页的“写”仍是 owner-only，会出现“能看不能改”；
  - 列表会从“自己的几十个”变成“全机构几千个”，需要分页/搜索/校区筛选，否则页面会变慢；
  - RLS 里调用 `is_admin()` 是 SECURITY DEFINER，注意递归与性能（每行一次函数调用），大表要加索引/改 RPC。

**A2. 不改 RLS，加 SECURITY DEFINER 只读 RPC（推荐先做这个）**

```sql
-- 示意
create function public.admin_list_all_students()
returns table (...) language plpgsql security definer set search_path = ''
as $$ begin
  if not public.is_admin() then raise exception 'admin only' using errcode='42501'; end if;
  return query select ... from public.feedback_students order by updated_at desc;
end; $$;
```

- 工作量：**1–2 天**（RPC + 一个只读的“全机构档案”页面 + 搜索/校区筛选 + 测试）。
- 优点：不动现有 RLS，老师端完全不受影响；只读，误改风险低；以后要加校区过滤只改 RPC 参数。
- 缺点：需要新页面/接口；写操作仍要回到原老师账号；RPC 返回列要白名单，避免把敏感字段带出去。

### 结论

- **Q1：能直接通过修改 RLS 或接口逻辑让 `role='admin'` 看所有校区吗？**
  **能，但不是“只改接口”**：要么加 A1 的 RLS 策略，要么加 A2 的 SECURITY DEFINER RPC。
  现有 `role='admin'` 本身不够，因为 RLS 是 owner-only。
- 如果只是“老板一个人要看全部”，**A2 最稳**：不改角色、不改老师端 RLS，先上只读总览。

---

## 三、选项 B：超级管理员 / 校区管理员分级

### 需要动的表（这是最小集合）

| 表 | 变更 | 为什么 |
|---|---|---|
| `public.campuses`（新） | `id uuid pk`、`name text unique`、`created_at` | 校区必须有稳定 ID；现在只有自由文本，改一个字就对不上 |
| `public.user_profiles` | 加 `campus_id uuid references campuses(id)` | 老师属于哪个机构校区；保留 `campus` 文本做显示/兼容 |
| `public.feedback_students` | 加 `campus_id uuid`（**创建时快照**） | 学生档案归属哪个校区；不能只靠“老师当前校区”，否则老师调校区会改变历史数据归属 |
| `public.feedback_history` | 可选加 `campus_id`，或通过 `student_name + user_id` 关联学生 | 按校区查历史时避免每次 join；不加也能用学生表过滤 |
| `public.user_roles` | 加 `admin_scope`（`super` / `campus`）+ `campus_id`；或把 `role` 枚举加 `campus_admin` | 表达“超级管理员”与“校区管理员”；**不建议只加枚举值**，因为还要存“哪个校区” |
| RLS 策略 | 学生/历史/资料各加一条“管理员按范围读” | 超级读全部；校区管理员只读本校；老师仍只读自己 |
| 现有数据 | 回填 `campus_id` | 最麻烦：历史档案的“机构校区”没有可靠来源，只能按创建老师资料推断或人工指定 |

> ⚠️ **不要**直接拿 `feedback_students.campus`（学生学校）当机构校区；这两个字段在 0021 里已经明确
> 不是一回事。分级必须新建 `campuses` + `campus_id`，否则“按校区”永远对不准。

### 角色模型建议

```
user_roles:
  role        admin | user          （保留，兼容现有代码）
  admin_scope super | campus | null （只有 role=admin 时有意义）
  campus_id   uuid null             （admin_scope=campus 时必填）
```

- 超级管理员：`role=admin, admin_scope=super` → 读全部；
- 校区管理员：`role=admin, admin_scope=campus, campus_id=X` → 只读 X 校区；
- 普通老师：`role=user` → 仍只读自己创建的档案；
- 写权限单独定义：建议一期“校区管理员只读”，避免跨老师改档案的责任问题。

### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **数据回填不准** | 历史档案没有“机构校区”字段，只能按创建老师当前资料推断；老师调动/多校区会错 | 先出一张“待确认归属”清单，让校长/学管人工确认；不要静默猜 |
| **RLS 递归/性能** | 策略里调 `is_admin()` / 查 `user_profiles`，每行一次；大表会慢 | 用 SECURITY DEFINER 函数 + `(select auth.uid())`；加 `(campus_id, updated_at)` 索引；压测 |
| **写权限模糊** | “能看”不等于“能改”；跨校区改档案会破坏“谁负责” | 一期只读；写操作保留给 owner，或加审计日志 |
| **老师调校区** | 用“老师当前校区”过滤会改变历史归属 | 学生表存 `campus_id` 快照，不随老师资料变 |
| **所有 admin 被误升级** | 现有两个 admin 都会变成 super | 迁移时显式指定谁是 super；其余 admin 默认 campus/null 并提示 |
| **API/测试面广** | `/api/students`、`/dashboard`、三个工具、学情分析都按 `user_id` 假设 | 先加只读总览页，不动现有写路径；分批回归 |
| **迁移不可逆** | 加列/加表可回滚，但回填与权限切换不可逆 | 先备份；迁移分两步（加列可空 → 回填 → 加约束） |

### 工作量（粗略）

| 阶段 | 内容 | 人日 |
|---|---|---|
| 0 | 需求确认：谁能看、谁能改、校区怎么划分、历史档案怎么归属 | 0.5 |
| A2 | 超级管理员只读总览（RPC + 页面 + 搜索/筛选 + 测试） | 1–2 |
| B1 | `campuses` + `user_profiles.campus_id` + 老师资料页选校区 + 回填 | 1–2 |
| B2 | `feedback_students.campus_id` 快照 + 历史回填/人工确认 | 1–2 |
| B3 | `admin_scope` + RLS + 后台角色管理 + 测试 | 2–3 |
| B4 | 全量回归（51 套）+ 真实账号验收 | 1 |
| 合计 |  | **6–10 人日**（不含历史数据人工确认） |

---

## 四、建议顺序（等用户拍板）

1. **先做 A2（超级管理员只读总览）**：不改角色、不动老师端 RLS；老板先能看全部，风险最低。
2. 观察 1–2 周：确认“按校区过滤”到底按**机构校区**还是**学生学校**，以及历史档案归属谁负责。
3. 再决定是否上 B：如果只有老板一个人看，A2 就够了；如果要给校长/学管分校区权限，再上 B。
4. **不要**在没有校区 ID 的情况下直接放宽 RLS 给所有 admin；那等于“所有管理员都是超级管理员”，以后很难收回。

---

## 五、需要用户拍板的问题

1. “超级管理员”是**只看**，还是也要能改/删别的校区的档案？
2. “校区”指**机构校区**（老师所属，如燕郊/大厂），还是**学生就读学校**（三河一中）？
3. 现有历史档案（没有校区字段）怎么归属：按创建老师当前校区自动推断，还是人工确认？
4. 除了老板，还要给哪些人“校区管理员”？他们能不能改档案？
5. 一期是否接受“只读总览”作为过渡（推荐）？

> 本文只做方案，**没有改任何表、没有写迁移、没有改代码**。等用户确认选项与范围后再动手。
