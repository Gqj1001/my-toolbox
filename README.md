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

工具清单位于 `src/lib/tools.ts`，是**单一数据源**：

```ts
{ slug, name, description, icon, href, access: "all" | "admin" }
```

- `access: "all"` → 所有登录用户可见
- `access: "admin"` → 仅管理员可见

`proxy.ts` 的 `ADMIN_PATHS` 直接由该目录推导（`/admin` 加上所有 `access: "admin"` 工具的 `href`），
因此「声明权限」与「服务端拦截」不会脱节——新增管理员专属工具只需改 `tools.ts` 一处。

> 目前是**按角色**控制可见性。若后续要「按用户逐个授权」，
> 可在 `tools.ts` 基础上加一张授权表，把 `access` 换成用户列表，
> `ToolGrid` 与 `dashboard` 无需改动。

### 接入单文件 HTML 工具（以 math-plan 为例）

现成的单文件 HTML 工具可以直接挂进来，无需改动它的源码：

1. 把 HTML 放到 `public/tools/<slug>.html`（如 `public/tools/math-plan.html`）
2. 新建页面 `src/app/tools/<slug>/page.tsx`，用 iframe 承载：

   ```tsx
   <main className="flex w-full flex-1 flex-col overflow-hidden">
     <iframe src="/tools/<slug>.html" className="block h-full min-h-0 w-full border-0" />
   </main>
   ```

3. 在 `src/lib/tools.ts` 里加一条目录项（`access: "all"` 或 `"admin"`）
4. 若要新建示例工具页，复制 `src/components/tool-page-shell.tsx` 的用法即可

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
