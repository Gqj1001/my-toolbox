import Link from "next/link";
import SignOutButton from "@/components/sign-out-button";
import { getMembership } from "@/lib/membership";
import { PLAN_LABELS, remainingDays } from "@/lib/membership-types";

type SiteHeaderProps = {
  email: string | null;
  role: "admin" | "user";
  current?: string;
};

export default async function SiteHeader({ email, role, current }: SiteHeaderProps) {
  const isAdmin = role === "admin";
  const membership = await getMembership();
  const days = remainingDays(membership.expiresAt);

  // 会员已过期时按免费用户呈现，避免误解
  const planExpired = membership.plan === "vip" && !membership.isVip;
  const planLabel = planExpired ? `${PLAN_LABELS[membership.plan]}（已过期）` : PLAN_LABELS[membership.plan];

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
          <span className="mr-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            My Toolbox
          </span>
          <Link href="/dashboard" className={linkClass("/dashboard")}>
            百宝箱
          </Link>
          <Link href="/tools" className={linkClass("/tools")}>
            工具列表
          </Link>
          {isAdmin ? (
            // prefetch={false}：减少「危险窗口」内的并发请求数，同时省掉多余的 RSC 预取。
            // 打开一个页面会并行预取十几个链接（/tools、/admin、/upgrade、每张工具卡片），
            // 每一条都要重跑中间件；实测 13 条预取。这两个目标不是高频点击对象，
            // 预取它们收益低、却贡献了其中 4 条。
            // ⚠️ 只关这两个：/dashboard、/tools 与工具卡片是高频目标，预取有价值，保持默认。
            <Link href="/admin" prefetch={false} className={linkClass("/admin")}>
              管理后台
            </Link>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
            {email}
          </span>

          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              membership.isVip
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : planExpired
                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
            title={membership.expiresAt ? `到期：${membership.expiresAt}` : undefined}
          >
            {planLabel}
            {membership.isVip && days !== null ? ` · 剩 ${days} 天` : ""}
          </span>

          {!membership.isVip ? (
            <Link
              href="/upgrade"
              prefetch={false}
              className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-medium text-white transition hover:bg-amber-600"
            >
              开通会员
            </Link>
          ) : null}

          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              isAdmin
                ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {role}
          </span>

          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
