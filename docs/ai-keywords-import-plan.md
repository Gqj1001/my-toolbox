# AI 教材关键词导入 · 结构评估与方案

> 状态：**SQL 与脚本已就绪，等待你执行**
> 数据来源：`C:\Users\郭庆杰\Doubao\chats\2026-10-03\new-chat\教材关键词_总表.json`（344 KB）
>
> ## 你的决定（已确认）
>
> | 问题 | 你的选择 | 落实方式 |
> |---|---|---|
> | Q1 三层结构 | ✅ 同意 | 新建 `feedback_sections`，现有 `feedback_chapters` 保持为知识点 |
> | Q2 人教A版 | ✅ 选 A（保持现状） | 94 个知识点当"未分章"，`section_id` 为 NULL，工具页行为不变 |
> | Q3 占位教材 | 选 B（先查再定） | **查完发现 35 本下面都有章节**，但那些"章节"其实是册次名占位，见 §7 |
> | Q4 分类 | ✅ 同时进两个分类 | 每个知识点写「课堂内容」「下节课内容」各一行 |
> | Q5 章名规范化 | ✅ 统一 | 去掉「第X章/第X节/专题N」前缀（正则已修正，见 §8） |
> | Q6 审核筛选 | ✅ 不熟科目优先 | 化学/生物/政治/历史/地理 排前，数学/物理排后；另有状态/学段/册次筛选 + CSV 导出 |


---

## 一、现状盘点

### 1.1 JSON 结构

顶层是**数组**，959 条记录，字段固定 6 个：

```json
{
  "stage": "senior",
  "subject": "math",
  "version": "人教B版",
  "book_name": "必修第一册",
  "chapter_name": "第一章 集合与常用逻辑用语",
  "keywords": ["集合及其表示方法", "集合的基本关系", "集合的基本运算",
               "命题与量词", "充分条件与必要条件"]
}
```

规模：

| 项 | 数量 |
|---|---|
| 记录数（= 章数） | **959** |
| 知识点总数 | **4184** |
| 维度组合（学段×科目×版本×册次） | **178** |
| 唯一章名 | 940 |
| 覆盖科目 | 数学、物理、化学、生物、语文、英语、政治、历史、地理 |
| 覆盖学段 | 高中 + 初中 |

### 1.2 数据库现状

```
feedback_categories   8 行   ← 8 个通用分类
feedback_textbooks   41 行   ← 教材（version=版本, name=册次）
feedback_chapters   272 行   ← 章节
feedback_keywords   658 行   ← 关键词
```

**关键点：`feedback_chapters.name` 存的是「知识点」，不是「章」。**

实测证据（人教A版 必修第一册，21 条）：

```
集合的概念与关系 / 集合的基本运算 / 充分条件与必要条件 / 全称量词与存在量词 /
等式与不等式性质 / 基本不等式 / 二次函数与方程、不等式 / 函数概念与表示 …
```

而人教A版必修第一册**真实只有 5 章**（集合与常用逻辑用语、一元二次函数方程和不等式、
函数的概念与性质、指数函数与对数函数、三角函数）。

→ 所以你说的没错：**现表在"知识点"层，JSON 的 `chapter_name` 在"章"层**。

### 1.3 两个必须处理的数据差异

**差异 A：册次名全部对不上（178/178）**

数据库 41 本教材里，**35 本的 `name` 是占位符 `-`**（当初 0006 迁移时，只有人教A版的 6 册
有真实册次名，其余科目的册次留待以后补）。JSON 的册次是具体的：

| 学段/科目/版本 | JSON 的册次 | 数据库的册次 |
|---|---|---|
| junior/math/人教版 | 七年级上册 / 七年级下册 / 八年级上册 / 八年级下册 / 九年级上册 / 九年级下册 | `-`（1 条占位） |
| senior/physics/人教版 | 必修第一册 / 必修第二册 / 必修第三册 / 选择性必修第一册 / … | `-`（1 条占位） |
| senior/english/人教版 | 必修第一册 / 必修第二册 / 必修第三册 / 选择性必修第一册 / … | `-`（1 条占位） |
| senior/math/人教B版 | 必修第一册 / 必修第二册 / 必修第三册 / 必修第四册 / … | `-`（1 条占位） |

→ 导入时需要**为这些册次新建教材行**（占位行可保留，也可归档）。

**差异 B：JSON 不包含「高中数学 人教A版」**

```
JSON 里有 senior|math 的：人教B版、北师大版、湘教版、苏教版
JSON 里没有：人教A版   ← 你现在实际在用的那套
```

→ 你现有的 6 册人教A版数据（94 个知识点）**不会被动到**，保持原样。
→ 如果你希望人教A版也升级成三层结构，需要另外补一份它的数据（见 §4）。

---

## 二、结构评估结论

### 能不能直接导入？**不能。**

| 问题 | 说明 |
|---|---|
| 层数不够 | JSON 是 册次→章→知识点 三层；数据库只有 册次→知识点 两层 |
| 字段语义冲突 | `feedback_chapters.name` 是知识点，JSON 的 `chapter_name` 是章名，直接塞进去会污染现有数据 |
| 册次对不上 | 178 组册次全部需要新建教材行（差异 A） |

### 改造 or 新建？

**结论：新建 `feedback_sections`（章）表，现有 `feedback_chapters` 保持不动。**

理由：

1. `feedback_chapters` 里已有 **272 行真实数据**，且工具页/管理页都在用
   （`getCategories`、`wireBookGrids`、`chapter_id` 过滤等），改造它要动一大片代码
2. 语义上它确实就是"知识点"（`keyword` 与它是一对一，`chapter_name` 还冗余存了一份）
3. 新增一张表**零风险**：不动现有行、不动 id、不动接口

于是形成三层：

```
feedback_textbooks   （册次）
   └── feedback_sections    （章）        ← 新增
          └── feedback_chapters （知识点）
                 └── feedback_keywords（分类下的具体词条，可挂到知识点上）
```

### 现有数据怎么兼容？

| 数据 | 处理 |
|---|---|
| 人教A版 6 册的 94 个知识点 | **保持原样**，`section_id` 为 `NULL`（表示"未分章"），工具页行为不变 |
| 其余科目的通用分类词 | 不受影响（它们本来就不挂章节） |
| 35 本占位教材（`name='-'`） | 保留；新导入的册次作为**新行**追加 |

---

## 三、SQL 方案（**待你确认后再执行**）

### 3.1 新增 `feedback_sections` 表

```sql
-- ============================================================
-- 0007：新增「章」层（册次 → 章 → 知识点）
-- 幂等；不动任何现有数据
-- ============================================================

create table if not exists public.feedback_sections (
  id          bigint generated always as identity primary key,
  textbook_id bigint not null references public.feedback_textbooks (id) on delete cascade,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (textbook_id, name)
);
create index if not exists feedback_sections_textbook_idx
  on public.feedback_sections (textbook_id, sort_order);

alter table public.feedback_sections enable row level security;

-- 读：所有登录用户
create policy "feedback_sections readable by authenticated"
  on public.feedback_sections for select to authenticated using (true);
-- 写：仅 admin（拆成三条，原因见 0006 的说明）
create policy "admins insert feedback_sections"
  on public.feedback_sections for insert to authenticated with check (public.is_admin());
create policy "admins update feedback_sections"
  on public.feedback_sections for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "admins delete feedback_sections"
  on public.feedback_sections for delete to authenticated using (public.is_admin());

revoke all on public.feedback_sections from anon;
grant select, insert, update, delete on public.feedback_sections to authenticated;

drop trigger if exists feedback_sections_touch on public.feedback_sections;
create trigger feedback_sections_touch before update on public.feedback_sections
  for each row execute function public.touch_updated_at();

-- feedback_chapters 增加归属章（可空，NULL = 未分章，兼容现有 272 行）
alter table public.feedback_chapters
  add column if not exists section_id bigint references public.feedback_sections (id) on delete set null;
create index if not exists feedback_chapters_section_idx
  on public.feedback_chapters (section_id, sort_order);
```

### 3.2 候选表（**AI 数据先进这里，绝不直接进正式表**）

```sql
create table if not exists public.feedback_section_candidates (
  id           bigint generated always as identity primary key,
  batch_id     text not null,               -- 每次导入一个批次号，用于整批回滚
  stage        text not null check (stage in ('senior','junior')),
  subject      text not null,
  version      text not null,
  book_name    text not null,
  section_name text not null,               -- JSON 的 chapter_name（章名）
  keywords     jsonb not null default '[]', -- 该章的知识点数组（审核时逐条看）
  source       text not null default 'ai',
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected')),
  note         text,                        -- 审核备注（比如"这章少了 XX"）
  reviewed_by  uuid references auth.users (id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists feedback_section_candidates_batch_idx
  on public.feedback_section_candidates (batch_id, status);
create index if not exists feedback_section_candidates_scope_idx
  on public.feedback_section_candidates (stage, subject, version, book_name, section_name);
create unique index if not exists feedback_section_candidates_uniq
  on public.feedback_section_candidates (batch_id, stage, subject, version, book_name, section_name);

-- RLS：同其他表（登录可读、仅 admin 可写）
```

### 3.3 三张表的关系

```
feedback_section_candidates   ← 候选（AI 生成，可审核、可整批删）
        │  审核通过
        ▼
feedback_textbooks （册次） → feedback_sections （章） → feedback_chapters （知识点）
```

---

## 四、导入流程设计

### 4.1 整体流程

```
JSON ──[脚本]──> ① 预览报告（数量 / 去向 / 异常，不动数据库）
                        │ 你看过没问题
                        ▼
                  ② 生成候选表 INSERT SQL（一个批次号）
                        │ 你在 SQL Editor 执行
                        ▼
                  ③ 后台逐章审核（通过 / 拒绝，可导出 CSV 在 Excel 里过）
                        │
                        ▼
                  ④ 「提升为正式数据」（Server Action，需 admin）
                        │
                        ▼
                  ⑤ 需要时按 batch_id 整批回滚
```

### 4.2 为什么要"章"这个审核粒度

| 粒度 | 问题 |
|---|---|
| 按知识点（4184 条） | 太多，你审不过来 |
| **按章（959 条）** | 每章显示"章名 + 知识点列表"，你一眼能判断这一章是否合理、有没有漏 ✅ |
| 按册次（178 条） | 太粗，一章错了整册都要回退 |

所以审核页**按章显示**，每章一行：章名、知识点（可展开）、来源、操作（通过/拒绝/备注）。

### 4.3 回滚能力（三个层次）

| 层次 | 操作 | 影响 |
|---|---|---|
| ① 未通过的候选 | 本来就只在候选表里 | 正式表零影响 |
| ② 整批回滚 | 按 `batch_id` 删除候选 | 只删候选 |
| ③ **已提升的数据回滚** | `feedback_chapters` / `feedback_keywords` 的导入行都带 `batch_id`（见下），一条 SQL 整批撤 | 撤销正式数据 |

**为了让 ③ 可行**，需要给正式表也记批次：

```sql
alter table public.feedback_chapters
  add column if not exists import_batch_id text;
alter table public.feedback_keywords
  add column if not exists import_batch_id text;
create index if not exists feedback_chapters_batch_idx on public.feedback_chapters (import_batch_id);
create index if not exists feedback_keywords_batch_idx on public.feedback_keywords (import_batch_id);
```

于是回滚就是：

```sql
-- 撤销某一批次的全部导入（先删关键词，再删知识点，再删章）
delete from public.feedback_keywords  where import_batch_id = 'BATCH_ID';
delete from public.feedback_chapters  where import_batch_id = 'BATCH_ID';
delete from public.feedback_sections  where id in (
  select distinct section_id from public.feedback_chapters where import_batch_id = 'BATCH_ID');
```

> 更稳的做法是**软回滚**（`archived_at`），我可以两者都给，默认软回滚。

### 4.4 提升为正式数据的逻辑

对每个 `approved` 候选：

```
1. 找/建教材行      feedback_textbooks (stage, subject, version, book_name)
2. 找/建章          feedback_sections  (textbook_id, section_name)
3. 每个知识点建一行  feedback_chapters (textbook_id, section_id, name=知识点, import_batch_id)
4. 每个知识点同时在 feedback_keywords 建「课堂内容」「下节课内容」两行
   （与现有数学人教A版的处理一致：两个分类都能选到）
```

全部在一个 Server Action 里事务性完成，任何一步失败则整批回滚。

---

## 五、需要你确认的 5 个问题

### Q1. 三层结构方案是否同意？

**新建 `feedback_sections`（章），现有 `feedback_chapters` 保持为"知识点"** —— 而不是改造现有表。

### Q2. 人教A版要不要也升级成三层？

JSON 里没有它。三个选项：

| 选项 | 说明 |
|---|---|
| **A（默认）** | 保持现状：人教A版的 94 个知识点当作"未分章"的知识点，工具页照常用 |
| B | 你再补一份人教A版的 JSON（格式同上），我一起导入 |
| C | 我按官方教材目录把现有 94 个知识点**归到章下**（需要我手工核对，工作量中等） |

### Q3. 35 本占位教材（`name='-'`）怎么处理？

导入会为真实册次新建教材行。占位行可以：

| 选项 | 说明 |
|---|---|
| **A（默认）** | 保留（不影响功能，只是后台列表里多几行空的） |
| B | 归档/删除它们（更干净，但要确认它们没有章节挂在下面——我可以先查） |

### Q4. 知识点要不要同时进「课堂内容」和「下节课内容」？

现在数学人教A版是这么做的（一个知识点在库里两行）。**建议保持一致**，这样老师两个分类里都能选。

### Q5. 审核粒度确认

按**章**审核（959 条待审），并提供 **CSV 导出**（列：学段/科目/版本/册次/章名/知识点/来源/状态/备注），
你在 Excel 里过一遍。这样可以吗？

---

## 六、下一步（等你回答 Q1–Q5）

我会：

1. 生成 `supabase/migrations/0007_sections_and_candidates.sql`（上面 §3 的完整可执行版本）
2. 生成 `scripts/import-textbook-json.mjs`，先跑一次**预览报告**（不改数据库），输出：
   - 959 条章 → 会新建多少教材行 / 多少章 / 多少知识点
   - 哪些册次名与数据库不同（178 组明细）
   - 重复检测（同一册次内章名重复、同一章内知识点重复）
   - 一个 `preview.csv` 供你抽查
3. 你确认预览报告后，再生成候选表 INSERT SQL

**你确认后我再执行**，或你直接在 SQL Editor 里跑。

### 交付清单

| 文件 | 作用 | 是否已生成 |
|---|---|---|
| `supabase/migrations/0007_sections_and_candidates.sql` | 建章表 + 候选表 + 关联列 | ✅ 已生成（校验通过） |
| `supabase/import/0007_candidates_BATCH.sql` | 959 条候选数据（批次 `ai-20261004-01`） | ✅ 已生成（242.6 KB，只写候选表） |
| `supabase/migrations/0008_cleanup_placeholder_chapters.sql` | 清理 178 条"册次名占位"章节（可选，见 §7） | ✅ 已生成 |
| `scripts/import-textbook-json.mjs` | JSON → 预览报告 / 生成候选 SQL | ✅ 已生成 |
| `src/app/admin/feedback-candidates/` | 审核页 + CSV 导出 | ✅ 已生成（构建通过） |
| `src/components/candidate-review.tsx` | 审核界面（按章、筛选、批量、提升、回滚） | ✅ 已生成 |
| `docs/ai-keywords-preview.csv` | 959 行 Excel 抽查清单 | ✅ 已生成 |

### 执行顺序

```
① 执行 0007_sections_and_candidates.sql     （建表，不动数据）
② 执行 0007_candidates_BATCH.sql            （写入 959 条候选）
③ 打开 /admin/feedback-candidates 逐章审核   （或先导 CSV 在 Excel 里过）
④ 点「提升为正式数据」                        （每次 20 章，可分批）
⑤ 需要时执行 0008 清理占位章节               （见 §7）
```

---

## 七、⚠️ 关于 Q3 的重要修正

你选了 B（先查占位教材下面有没有章节）。**查询结果：35 本下面全部有章节** —— 按字面规则应该"全部保留"。
但我进一步查证后发现，**那些"章节"其实是册次名占位**，不是真实章节：

```
senior/math/人教B版 → feedback_chapters: 必修第一册 / 必修第二册 / 必修第三册 /
                                          必修第四册 / 选择性必修第一册 / …
junior/math/人教版  → feedback_chapters: 七年级上册 / 七年级下册 / 八年级上册 / …
```

**成因**：`0005` 生成时还没有册次维度，我把册次名填进了 `feedback_chapters` 当占位。

**关键事实**：

| 项 | 数量 |
|---|---|
| 占位教材下的"章节" | **178** 个 |
| 其中被关键词引用 | **0** 个 |
| 属本次导入覆盖版本的 | 178 个（全部） |

**如果保留会怎样**：导入后同一个版本下会**同时存在**：
- `feedback_textbooks` 里的册次行（新的，如 "必修第一册"）← 工具页的「册次」下拉
- `feedback_textbooks` 里的占位行（旧的，name=`-`）+ 它下面 178 条"章节" ← 会**再次**出现在教材/章列表里

→ 后台与工具页会出现**重复条目**，需要你手动区分。

**我的建议**：执行 `0008_cleanup_placeholder_chapters.sql` 清掉它们。这个文件**只删「占位教材下 + 无关键词引用」的行**，人教A版的 94 个真实知识点（被 188 条关键词引用）不会被动。

> 我没有把它并进 0007，是为了让你先看清再决定；文件里自带"执行前查询"和自检。

---

## 八、修复记录：一个差点造成静默丢数据的缺陷

生成脚本第一版把「第X课」当成了「第X节」，**错误地合并进上一章**：

```
"第二课 只有社会主义才能救中国"  →  被并入 "社会主义从空想到科学、从理论到实践的发展"  ❌
```

原因：正则写成 `[节课]`，把"课"和"节"混为一谈。而政治教材的结构是 **单元 > 课 > 知识点**，课是正经的一级标题，合并会吞掉 51 个标题。

修正后：`第X课` 与 `第X章`/`专题N` 一样视为独立章层，`第X节` 才并入。

**修正前后对比**：

| | 修正前 | 修正后 |
|---|---|---|
| 章数 | 908（吞掉 51 个"课"） | **959** ✅ |
| 知识点 | 4235（补入被吞的节名，虚高） | **4184** ✅ 与 JSON 完全一致 |
| 「第X课」条目 | 被合并隐藏 | 58 条各自独立成章 ✅ |

**顺带修正的校验**：单字章名（「圆」「力」「光」「烃」）是合法的，不再报警。

