import Link from "next/link";
import SignOutButton from "@/components/sign-out-button";
import { PLAN_LABELS, remainingDays } from "@/lib/membership-types";

/**
 * 会员状态卡（个人中心用）。
 *
 * 为什么要有它：以前「我是谁 / 我什么会员 / 怎么退出」这三件事分散在**顶栏**和
 * `/dashboard` 正文里，同一个页面显示两三遍，改一处要记着改几处。
 * 2026-10 起集中到这一张卡上（`/tools` = 个人中心），顶栏只留导航。
 *
 * ⚠️ 数据只能从 **服务端** 传进来（`getViewer()` 的结果），不要在客户端 fetch ——
 *    那会变成「同一件事有两个来源」，而且会员状态还有 30 秒缓存，
 *    两处读出来的东西可能不一致。
 */
type MembershipCardProps = {
  email: string | null;
  role: "admin" | "user";
  plan: "free" | "vip";
  isVip: boolean;
  expiresAt: string | null;
};

export default function MembershipCard({ email, role, plan, isVip, expiresAt }: MembershipCardProps) {
  const days = remainingDays(expiresAt);
  // 会员已过期时按免费用户呈现，避免用户误以为仍是会员
  const planExpired = plan === "vip" && !isVip;
  const planLabel = planExpired ? `${PLAN_LABELS[plan]}（已过期）` : PLAN_LABELS[plan];
  const isAdmin = role === "admin";

  return (
    <section className="rounded-xl border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">当前账号</span>
          <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {email ?? "（未取到邮箱）"}
          </span>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                isVip
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  : planExpired
                    ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {planLabel}
              {isVip && days !== null ? ` · 剩 ${days} 天` : ""}
            </span>
            {isAdmin ? (
              <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                管理员
              </span>
            ) : null}
          </div>

          <span className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
            {expiresAt
              ? `到期时间：${expiresAt.slice(0, 10)}${planExpired ? "（已过期）" : ""}`
              : "免费版没有到期时间"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isVip ? (
            <Link
              href="/upgrade"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-amber-500 px-3 text-sm font-medium text-white transition hover:bg-amber-600"
            >
              查看会员权益
            </Link>
          ) : null}
          <SignOutButton />
        </div>
      </div>
    </section>
  );
}
