# 清理测试脏数据：`roleb` 账号里的假资料

> 起因：`tests/profile.test.mjs` 有 **2 条**断言常年红（不是代码坏了）。
> 根因已经查清，见 §1。修法见 §2 的 SQL（**在 Supabase SQL Editor 里跑**）。

---

## 1. 根因（2026-10 已彻底查清：不是普通残留，是**测试的死结**）

`tests\profile.test.mjs` 报：

```
FAIL | ★★④ 资料没填时「教师」框为空（**不是**被塞了一个别人的名字） | stuTeacher="数学测试老师老师"
FAIL | ★④ 页头那行小字没填资料时是空的（不再写死名字） | brandWho="数学"
```

链条：

1. `public.user_profiles` 里 **roleb** 那一行存着
   `teacher_name=测试老师 / subject=math / campus=燕郊校区`，
   `updated_at = 2026-10-16T18:05:51Z` —— 是**第二十批**跑这套测试时写进去的；
2. 试卷分析页把资料填进「教师」框：`stuTeacher = resolveSignature(profile)`
   = `学科显示名 + 姓名 + "老师"` = 「数学」+「测试老师」+「老师」
   ⇒ **`数学测试老师老师`**（与报错一字不差）；
3. 页头小字 `brandWho` 取学科显示名 ⇒ `数学`。

⚠️ **为什么以前“清一次只能好一轮”**（这是本文件最早没写透的一层）：
旧版套件用「`/api/profile` 有没有返回资料」来判断「`user_profiles` 表建没建」。
但产品口径里：

| 状态 | `/api/profile` 返回 |
|---|---|
| 表没建（迁移 `0021` 没跑） | `profile: null`（读不到就兜底，不拦页面） |
| 表建了、但这人没填 | **也是 `profile: null`**（同上） |

所以你把资料删掉后，旧套件**误判「表没建」** → 走「提交表单验证提示」的分支；
而表其实是好的 ⇒ 保存**成功** ⇒ 又把「测试老师 / 数学 / 燕郊校区」**写回账号**
⇒ 下一次跑又读到这行假资料 ⇒ 两条假红回来。
**它会每次跑都重新制造脏数据**，所以“删一行”治不了根，看起来像永远修不好的假红。

✅ **2026-10 已修**：套件改成直接问 PostgREST「`user_profiles` 这张表在不在」
（200 哪怕空数组 = 表在；404 / `PGRST205` / `42P01` = 表不在）；**表在但没资料时只读不写**。
修好后，清一次就不会再回来。详见 `tests/profile.test.mjs` 文件头的「测试死结」说明、
以及 `docs/dsh-work-guide.md` 的**坑 23**。

⚠️ **为什么 anon key 删不掉**：`user_profiles` 的 delete 策略只给 admin；
用 anon（哪怕登录态）删自己那行返回 `200` 但**影响 0 行**；admin 策略也看不见别人的行。
所以测试**不能**自己清理写进去的资料 —— 唯一安全的做法是**根本不写**（已按此修）。

---

## 2. 要跑的 SQL（Supabase → SQL Editor，整段执行）

> ⚠️ **先确认测试已修**（`tests/profile.test.mjs` 里已有 `detectProfileTable()`）。
> 旧版套件会在你删完后**再次写回**，表现为「清了也没用」。修好后的套件只读不写。

```sql
-- ==========================================================
-- 清理 roleb 测试账号里遗留的「假资料」（修 profile 套件的 2 条假红）
-- 背景：旧版套件把「没有资料」误判成「表没建」，提交表单时把资料写了进去。
-- 安全性：只删 roleb 这一行，且**带 teacher_name 兜底条件**
--         （万一你后来给 roleb 填过真资料，它不会被误删）。
-- ==========================================================

-- ① 先看：应该只有 1 行（roleb）
select user_id, teacher_name, subject, campus, sig_teacher, updated_at
from public.user_profiles
where user_id = 'd2f00238-6927-4aea-afe7-04248a8d6818';

-- ② 删掉它（带上 teacher_name，防止误删真资料）
delete from public.user_profiles
where user_id = 'd2f00238-6927-4aea-afe7-04248a8d6818'
  and teacher_name = '测试老师';

-- ③ 复核：应该返回 0 行
select count(*) as remaining
from public.user_profiles
where user_id = 'd2f00238-6927-4aea-afe7-04248a8d6818';
```

> 如果 ① 返回 0 行，说明已经清过了（或者账号换过），第 ② 步什么都不会删，**可以放心跑**。

### 备选写法（按邮箱定位，不写死 uuid）

```sql
-- 只想按"测试账号邮箱"定位时用这个（SQL Editor 是 postgres 超级用户，能读 auth.users）
delete from public.user_profiles p
using auth.users u
where u.id = p.user_id
  and u.email like 'roleb-%@gmail.com'
  and p.teacher_name = '测试老师';
```

---

## 3. 跑完怎么验

```powershell
& <bundled node> tests\profile.test.mjs
```

应变成 **31/31**（**表已建、没资料**这个正常状态一共 31 条；如果表真的没建、走「提交并提示 0021」分支，则是 32 条）。
**再跑一次，仍应是 31/31**，并且下面这条 SQL 仍是 **0 行** ——
这才证明套件**不再把假资料写回去**（以前只能好一轮）：

```sql
select count(*) as remaining
from public.user_profiles
where user_id = 'd2f00238-6927-4aea-afe7-04248a8d6818';
```

如果还是红，先看日志里有没有这一行：

```
[profile] 资料表探测：HTTP 200（表在）；本次账号有资料行=false
```

- 仍是 `数学测试老师老师` ⇒ 删没生效，或者套件还是旧版（探测行会显示「表不在」/没有这行）
- 变成别的名字 ⇒ 说明账号里还有另一行资料，把 §2 ① 的 `select` 去掉 `where` 再看一遍

---

## 4. 想更彻底：换一对新测试账号

删资料只是一次性清理。**根治**是给测试用一对干净账号：

1. 在 Supabase Auth 里建两个邮箱（如 `rolea-<新stamp>@gmail.com` / `roleb-...`）；
2. 改 `.test-users.json` 的 `users` 与 `password`（格式见该文件，`readUsers()` 按 `rolea-` / `roleb-` 前缀找）；
3. rolea 需要在 `user_roles` 里是 admin（后台类测试要用）。

> ⚠️ 换账号会连带影响**所有**真服务套件（它们都从这里取账号），
> 所以换完要跑一遍全套回归。**不急的话，光删那一行就够了。**
