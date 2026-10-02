import Link from "next/link";
import { redirect } from "next/navigation";
import SiteHeader from "@/components/site-header";
import ToolIcon from "@/components/tool-icon";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getMembership } from "@/lib/membership";
import { PLAN_LABELS, remainingDays } from "@/lib/membership-types";
import { getActiveTools, slugFromRoute } from "@/lib/tools-db";

const BENEFITS = [
  "解锁全部会员专属工具（批量处理、高级报表等）",
  "会员工具不限次数使用",
  "后续新增的会员工具自动包含",
  "优先获得新功能与技术支持",
];

export default async function UpgradePage({ searchParams }: PageProps<"/upgrade">) {
  const membership = await getMembership();

  if (!membership.user) {
    redirect("/login?redirectTo=%2Fupgrade");
  }
  if (membership.status === "banned") {
    redirect("/banned");
  }

  const params = await searchParams;
  const toolSlug = typeof params.tool === "string" ? params.tool : null;

  // 已经是会员就不用再看升级页
  if (membership.isVip) {
    redirect("/dashboard");
  }

  const { user, role } = await getCurrentUserWithRole();
  const allTools = await getActiveTools();
  const vipTools = allTools.filter((t) => t.min_plan === "vip");

  const requestedTool = toolSlug
    ? (allTools.find((t) => slugFromRoute(t.route) === toolSlug) ?? null)
    : null;

  // 联系方式通过环境变量配置，避免把个人信息写进代码
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || null;
  const contactWechat = process.env.NEXT_PUBLIC_CONTACT_WECHAT?.trim() || null;
  const days = remainingDays(membership.expiresAt);

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/dashboard" />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 overflow-y-auto px-6 py-10">
        <Link
          href="/dashboard"
          className="w-fit text-sm text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← 返回百宝箱
        </Link>

        <header className="flex flex-col gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <ToolIcon name="lock" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {requestedTool ? "该工具为会员专属" : "升级为会员"}
          </h1>
          {requestedTool ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              你正在尝试打开
              <span className="mx-1 font-medium text-zinc-900 dark:text-zinc-100">
                {requestedTool.name}
              </span>
              ，该工具需要会员权限。
            </p>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              开通会员后即可使用全部会员专属工具。
            </p>
          )}
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            当前账号：{user?.email} ｜ 会员状态：{PLAN_LABELS[membership.plan]}
            {membership.plan === "vip" && days !== null ? `（剩 ${days} 天）` : ""}
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">会员权益</h2>
          <ul className="flex flex-col gap-2">
            {BENEFITS.map((benefit) => (
              <li
                key={benefit}
                className="flex items-start gap-2 rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-200"
              >
                <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-400">
                  ✓
                </span>
                {benefit}
              </li>
            ))}
          </ul>
        </section>

        {vipTools.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">会员专属工具</h2>
            <ul className="flex flex-wrap gap-2">
              {vipTools.map((tool) => (
                <li
                  key={String(tool.id)}
                  className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                >
                  {tool.name}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50/60 px-5 py-5 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">联系管理员开通</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            暂未接入在线支付。请联系管理员，由管理员在后台为你开通会员。
          </p>

          <div className="flex flex-wrap gap-3">
            {contactEmail ? (
              <a
                href={`mailto:${contactEmail}?subject=${encodeURIComponent("申请开通会员")}`}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                通过邮箱联系管理员
              </a>
            ) : null}

            {contactWechat ? (
              <span className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-zinc-300 px-4 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
                微信：<span className="font-medium">{contactWechat}</span>
              </span>
            ) : null}

            {!contactEmail && !contactWechat ? (
              <p
                role="alert"
                className="rounded-lg border border-amber-300 bg-white px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-zinc-900 dark:text-amber-300"
              >
                尚未配置联系方式。请在 <code className="font-mono">.env.local</code> 中设置
                <code className="mx-1 font-mono">NEXT_PUBLIC_CONTACT_EMAIL</code> 或
                <code className="mx-1 font-mono">NEXT_PUBLIC_CONTACT_WECHAT</code>。
              </p>
            ) : null}
          </div>
        </section>
      </main>
    </>
  );
}
