# 清理测试脏数据：`roleb` 账号里的假资料

> 起因：`tests/profile.test.mjs` 有 **2 条**断言常年红（不是代码坏了）。
> 根因已经查清，见 §1。修法见 §2 的 SQL（**在 Supabase SQL Editor 里跑**）。

---

## 1. 根因（已用数据 + 代码逐行对照确认）

`tests\profile.test.mjs` 报：

```
FAIL | ★★④ 资料没填时「教师」框为空（**不是**被塞了一个别人的名字） | stuTeacher="数学测试老师老师"
FAIL | ★④ 页头那行小字没填资料时是空的（不再写死名字） | brandWho="数学"
```

链条：

1. `public.user_profiles` 里 **roleb** 那一行存着
   `teacher_name=测试老师 / subject=math / campus=燕郊校区`，
   `updated_at = 2026-10-16T18:05:51Z` —— 是**第二十批**跑这套测试时写进去的，之后每次只是"读到它"；
2. 试卷分析页把资料填进「教师」柜：`stuTeacher = resolveSignature(profile)`
   = `学科显示名 + 姓名 + "老师"` = 「数学」+「测试老师」+「老师」
   ⇒ **`数学测试老师老师`**（与报错一字不差）；
3. 页头小字 `brandWho` 取学科显示名 ⇒ `数学`。

**这套断言的前提**是"登录账号**没填过**资料"，而 roleb 填过 ⇒ 假红。
`profile.test.mjs` 最后一次改动是上一批 `bd7fc7a`，与本次改动无关。

⚠️ **为什么 anon key 删不掉**：`user_profiles` 的 delete 策略只给 admin；
用 anon（哪怕登录态）删自己那行返回 `200` 但**影响 0 行**；admin 策略也看不见别人的行。

---

## 2. 要跑的 SQL（Supabase → SQL Editor，整段执行）

```sql
-- ==========================================================
-- 清理 roleb 测试账号里遗留的「假资料」（修 profile 套件的 2 条假红）
-- 背景：第二十批跑测试时在"表还没建"分支提交表单，把资料写进去后没清。
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

应变成 **31/31**（现在 29/31）。

如果还是红，先确认那两张红的具体值：
- 仍是 `数学测试老师老师` ⇒ 删没生效（检查是不是删了 rolea 那行）
- 变成别的名字 ⇒ 说明账号里还有另一行资料，把 §2 ① 的 `select` 去掉 `where` 再看一遍

---

## 4. 想更彻底：换一对新测试账号

删资料只是一次性清理。**根治**是给测试用一对干净账号：

1. 在 Supabase Auth 里建两个邮箱（如 `rolea-<新stamp>@gmail.com` / `roleb-...`）；
2. 改 `.test-users.json` 的 `users` 与 `password`（格式见该文件，`readUsers()` 按 `rolea-` / `roleb-` 前缀找）；
3. rolea 需要在 `user_roles` 里是 admin（后台类测试要用）。

> ⚠️ 换账号会连带影响**所有**真服务套件（它们都从这里取账号），
> 所以换完要跑一遍全套回归。**不急的话，光删那一行就够了。**
