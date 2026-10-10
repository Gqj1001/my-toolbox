import Link from "next/link";

/**
 * 全站顶栏。
 *
 * ⚠️ 2026-10 起这里**只保留导航**（+ 管理后台入口）：
 *   邮箱、会员等级、退出登录**都搬到 `/tools` 的会员状态卡**上了。
 *   原因：原来顶栏和 `/dashboard` 正文各自显示一遍会员信息、各有一个「退出登录」按钮，
 *   同一个页面上同一件事出现两三遍。现在「我是谁、我什么会员、怎么退出」集中在个人中心。
 *
 * 所以本组件**不再需要** `email` 之类的会员数据 —— 它不再查库，
 * 也就顺手省掉了每页一次 `getMembership()`（以及它背后可能的一次外网往返）。
 * ⚠️ 但 `role` 必须留着：「管理后台」入口只有管理员看得见，去掉它等于把后台入口藏了。
 */
export default function SiteHeader({ role, current }: { role: "admin" | "user"; current?: string }) {
  const isAdmin = role === "admin";
  const linkClass = (href: string) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      current === href
        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
    }`;

  return (
    <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-1">
          <Link href="/tools" className="mr-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            My Toolbox
          </Link>
          <Link href="/tools" className={linkClass("/tools")}>
            工具列表
          </Link>
          {/* ⚠️ 「百宝箱」(/dashboard) 暂时**不放进导航**：它正在改造成「学员档案」页，
              改造完成前从这里点进去只会看到一个和本页几乎一样的列表。
              等学员档案上线后，在这里加回「学员档案」入口。 */}
          {isAdmin ? (
            // prefetch={false}：减少「危险窗口」内的并发请求数，同时省掉多余的 RSC 预取。
            // 打开一个页面会并行预取十几个链接（/tools、/admin、/upgrade、每张工具卡片），
            // 每一条都要重跑中间件；实测 13 条预取。管理后台不是高频点击对象，
            // 预取它收益低、却贡献了其中几条。
            <Link href="/admin" prefetch={false} className={linkClass("/admin")}>
              管理后台
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}
