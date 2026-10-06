# My Toolbox

基于 Next.js（App Router）+ TypeScript + Tailwind CSS v4 的在线工具箱，使用 Supabase Auth 实现邮箱密码注册与登录。

## 快速开始

```bash
pnpm install
pnpm dev
```

打开 http://localhost:3000 即可。

### 环境变量

项目使用 `.env.local`（已被 `.gitignore` 忽略，不会提交）：

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```

> 注意：SDK 需要**项目根地址**，不能带 `/rest/v1/` 这类 REST 端点后缀。

## 页面与权限

| 路径 | 说明 | 访问要求 |
| --- | --- | --- |
| `/dashboard` | 百宝箱：工具卡片网格，顶部显示邮箱与退出登录 | 登录用户 |
| `/tools` | 工具列表（与百宝箱同一份目录与权限规则） | 登录用户 |
| `/tools/json-formatter` | JSON 格式化（示例占位） | 登录用户 |
| `/tools/password-generator` | 密码生成器（示例占位） | 登录用户 |
| `/tools/permission-console` | 权限控制台（示例占位） | 仅管理员 |
| `/tools/math-plan` | 高中数学辅导方案生成器（iframe 承载单文件 HTML） | 登录用户 |
| `/admin` | 管理后台：用户列表与角色修改 | 仅管理员 |
| `/login`、`/signup` | 登录 / 注册 | 公开 |
| `/` | 重定向到 `/dashboard` | — |

### 工具目录与角色可见性

工具清单存在数据库 `tools` 表（**单一数据源**），字段：

```
slug | name | description | icon | route | min_plan | sort_order | active
```

- `min_plan = 'free'` → 所有登录用户可打开
- `min_plan = 'vip'`  → 仅有效会员可打开，非会员点进去会跳到 `/upgrade?tool=<slug>`

读取逻辑在 `src/lib/tools-db.ts`（`getActiveTools` / `getToolByRoute` / `toToolView`），
图标名走 `src/lib/tool-icon-names.ts` 的白名单。

`proxy.ts` 的 `ADMIN_PATHS` 由 `/admin` 前缀控制，工具可见性则在
`src/components/tool-page-shell.tsx` 里按 `min_plan` 判定，两层不脱节。

### 课后反馈工作台的数据模型（学段 × 科目 × 教材 × 章节）

`public/tools/feedback.html` 是一个完整的单文件工具，被 `/tools/feedback` 用 iframe 承载。
它的关键词库按四个维度组织：

| 表 | 作用 |
| --- | --- |
| `feedback_categories` | 8 个通用分类（课堂表现、学情、建议、作业…），`stage` 留空 = 全学段通用 |
| `feedback_textbooks` | 教材：`stage` + `subject` + `name`（如「高中 / 数学 / 人教A版 必修第一册」） |
| `feedback_chapters` | 章节，挂在教材下 |
| `feedback_keywords` | 关键词，带 `stage / subject / category / textbook_id / chapter_id / archived_at` |

关键约定：

- **只有「课堂内容」「下节课内容」两个分类按教材章节区分**，其余 6 个分类所有科目共用
  （这些行的 `textbook_id` 与 `chapter_id` 为空）。
- 章节关键词在「课堂内容」「下节课内容」下**各存一行**（同一知识点两处可选），
  接口返回时按分类去重，前端不会看到重复项。
- `archived_at` 是**软删除**标记：归档的词不参与渲染与统计，但数据仍在，
  用 `update feedback_keywords set archived_at = null where ...` 即可恢复。
- 所有查询都必须带 `archived_at is null`（`getKeywords` 已强制）。

服务端口：

```
GET /api/feedback/mode                          → 轻量身份探测（只需 isAdmin 时用它）
GET /api/feedback/data?stage=&subject=          → 按学段/科目取（**维度参数必传**）
     &textbook=<id>&chapter=<id>                → 再限定教材/章节
     ⚠️ 不带维度参数 → 400 scope_required
```

> **为什么不带参数会 400**：从前 `/api/feedback/data` 不带参数会返回「全量关键词树」（号称向后兼容），
> 但 PostgREST 默认单次最多返回 **1000 行**，而 `feedback_keywords` 未归档已达 **8992 行** ——
> 那个分支**一直在静默丢约 89% 的数据**（既慢又错，且前端拿到的是残缺的树）。
> 现已移除：工具页启动时用 `/api/feedback/mode` 取身份，关键词一律按维度拉取。

管理页 `/admin/feedback-keywords` 用 URL 查询参数驱动级联选择
（`?stage=&subject=&textbook=&chapter=`），两种模式：
选到章节 → 编辑该章关键词；只选科目 → 编辑通用分类关键词。

> 免费用户能打开工具页并生成反馈；**AI 润色是 VIP 专属**（服务端 `requireVip` 返回 403）。

### 接入单文件 HTML 工具（以 math-plan 为例）

现成的单文件 HTML 工具可以直接挂进来，无需改动它的源码：

1. 把 HTML 放到 `public/tools/<slug>.html`（如 `public/tools/math-plan.html`）
2. 新建页面 `src/app/tools/<slug>/page.tsx`，用 `<ToolPageShell route="/tools/<slug>" />` 承载
   （它内部用 iframe 指向 `/tools/<slug>.html`，并做登录/封禁/VIP 三重判定）
3. 在数据库 `tools` 表里加一条目录项（`min_plan` 决定谁能打开）

**访问控制说明**：`public/tools/*.html` 由 Next 的静态文件服务直接返回，
但 `proxy.ts` 会在其之前执行，因此**未登录访问会被重定向到 `/login`**，
内容不会泄露；已登录用户可正常读取（iframe 需要）。

> 注意：不要把这些 HTML 路径加入 `PUBLIC_PATHS`，那会让它们变成免登录通道。

**布局约定**：根布局的 `<body>` 固定为视口高度且不滚动，
各页面的 `<main>` 自行负责滚动（带 `overflow-y-auto`）。
需要「撑满剩余高度」的页面（如 iframe 工具页）用 `flex-1` 即可正确计算高度，
不必硬编码导航栏高度。

## 鉴权设计

| 文件 | 作用 |
| --- | --- |
| `src/lib/supabase/client.ts` | 浏览器端客户端（Client Component 使用） |
| `src/lib/supabase/server.ts` | 服务端客户端（Server Component / Server Action / Route Handler） |
| `src/proxy.ts` | 每个请求刷新会话 + 路由守卫（Next.js 16 的 Proxy，等价于旧版 middleware） |
| `src/app/auth/actions.ts` | `signUp` / `logIn` / `logOut` 三个 Server Action，含中文错误映射 |
| `src/app/auth/confirm/route.ts` | 邮箱确认链接回调，校验 `token_hash` 并写入会话 |
| `src/app/login/page.tsx` | 登录页 |
| `src/app/signup/page.tsx` | 注册页 |
| `src/components/auth-form.tsx` | 登录/注册共用表单（`useActionState`） |

### 路由保护规则

- **公开路径**：`/login`、`/signup`、`/auth/*`
- **受保护路径**：其余全部（含首页 `/`）
- 未登录访问受保护路径 → `307` 重定向到 `/login?redirectTo=<原地址>`，登录成功后回到原地址
- 已登录访问 `/login` 或 `/signup` → 自动弹回 `/`

## Supabase 后台需要确认的配置

1. **Authentication → Sign In / Providers → Email**
   - 若保持 **Confirm email 开启**，邮箱确认链接模板需要改为：

     ```
     {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
     ```

     否则用户点击邮件里的链接会直接跳到 Supabase 域名，而不是回到本项目。
   - 若关闭 **Confirm email**，注册后即可直接登录（开发期推荐）。

2. **Authentication → URL Configuration**
   - `Site URL` 设为应用地址，并把生产/本地地址加入 `Redirect URLs`。

3. **内置邮件服务的发送限额**
   - 未配置自定义 SMTP 时，Supabase 内置邮件服务有严格的发送频率限制，
     频繁注册会返回 `over_email_send_rate_limit`（界面提示为「请求过于频繁」）。
   - 开发阶段建议关闭 Confirm email，或配置自己的 SMTP。

## 常见问题

- **重复邮箱注册时提示"确认邮件已发送"**：这是刻意行为。开启 Confirm email 时，
  Supabase 对已存在邮箱会返回混淆后的假用户对象，以避免账号枚举；前端沿用同样的
  友好提示，不会泄露某邮箱是否已注册。
