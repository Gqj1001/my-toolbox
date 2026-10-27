import Link from "next/link";
import type { AdminScope } from "@/lib/viewer";

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
 * 2026-10-27：只有 Owner 显示 `/admin`；大区/校区管理员只显示 `/admin/archives`，
 * 避免普通 Admin 点进用户管理页后再被重定向。
 */
export default function SiteHeader({
  role,
  current,
  adminScope = null,
}: {
  role: "admin" | "user";
  current?: string;
  adminScope?: AdminScope;
}) {
  const isAdmin = role === "admin";
  const isOwner = isAdmin && (adminScope === "owner" || adminScope == null);
  const adminHref = isOwner ? "/admin" : "/admin/archives";
  const adminLabel = isOwner ? "管理后台" : "档案总览";
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
          <Link href="/dashboard" className={linkClass("/dashboard")}>
            学员档案
          </Link>
          {isAdmin ? (
            <Link href={adminHref} prefetch={false} className={linkClass(adminHref)}>
              {adminLabel}
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}
