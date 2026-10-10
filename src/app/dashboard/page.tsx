import Link from "next/link";
import SignOutButton from "@/components/sign-out-button";
import SiteHeader from "@/components/site-header";
import ToolGrid from "@/components/tool-grid";
import { getViewer } from "@/lib/viewer";
import { PLAN_LABELS, remainingDays } from "@/lib/membership-types";
import { getActiveTools, toToolView } from "@/lib/tools-db";

const errorMessages: Record<string, string> = {
  admin_required: "该页面仅对 admin 角色开放，你没有访问权限。",
  self_demoted: "你已把自己降级为普通用户，管理后台的访问权限已收回。",
};

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  // 未登录到不了这里：src/proxy.ts 会重定向到 /login；
  // status='banned' 也会在 proxy 中拦到 /banned
  //
  // 性能：两层一起发车，不要写成瀑布。
  //   · getViewer() = 一次 getUser + 一次 user_roles（已合并、请求内去重）
  //   · getActiveTools() 本身不依赖会员信息 → 直接并发，不必等第一层
  //     （会员只用来决定卡片锁不锁，是后面映射阶段的入参）
  const [viewer, toolRows] = await Promise.all([getViewer(), getActiveTools()]);

  const membership = viewer.membership;
  const { user, role } = viewer;
  const tools = toolRows.map((row) => toToolView(row, membership));

  const params = await searchParams;
  const errorKey = typeof params.error === "string" ? params.error : "";
  const errorMessage = errorMessages[errorKey];

  const lockedCount = tools.filter((t) => t.locked).length;
  const days = remainingDays(membership.expiresAt);

  // 会员已过期时，界面上按免费用户呈现，避免用户误以为仍是会员
  const planExpired = membership.plan === "vip" && !membership.isVip;
  const planLabel = planExpired ? `${PLAN_LABELS[membership.plan]}（已过期）` : PLAN_LABELS[membership.plan];

  return (
    <>
      <SiteHeader role={role ?? "user"} current="/dashboard" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 overflow-y-auto px-6 py-10">
        {errorMessage ? (
          <p
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
          >
            {errorMessage}
          </p>
        ) : null}

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              百宝箱
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              已登录：
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{user?.email}</span>
            </p>
          </div>
          <SignOutButton />
        </header>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              membership.isVip
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : planExpired
                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {planLabel}
            {membership.isVip && days !== null ? `（剩 ${days} 天）` : ""}
          </span>
          <span className="text-zinc-500 dark:text-zinc-400">
            共 {tools.length} 个工具
            {lockedCount > 0 ? `，其中 ${lockedCount} 个为会员专属` : ""}
          </span>
          {!membership.isVip && lockedCount > 0 ? (
            <Link
              href="/upgrade"
              className="rounded-full bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-amber-600"
            >
              查看会员权益
            </Link>
          ) : null}
        </div>

        <ToolGrid tools={tools} />

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          工具清单来自数据库 tools 表（active=true，按 sort_order 排序），
          最小会员等级 min_plan=vip 的工具需要会员才能进入。
        </p>
      </main>
    </>
  );
}
