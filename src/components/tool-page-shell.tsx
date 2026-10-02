import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import SiteHeader from "@/components/site-header";
import ToolIcon from "@/components/tool-icon";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getMembership } from "@/lib/membership";
import { getToolByRoute, resolveIframeSrc } from "@/lib/tools-db";

type ToolPageShellProps = {
  /** 数据库 tools 表中的 route，如 /tools/math-plan */
  route: string;
};

/**
 * 工具页公共外壳：统一处理访问控制，然后渲染工具内容。
 *
 * 守卫顺序：
 *   1. 未登录            -> /login（proxy 已处理，这里再兜一层）
 *   2. status='banned'   -> /banned
 *   3. min_plan='vip' 且非会员 -> /upgrade?tool=<slug>
 *   4. 通过 -> 渲染 iframe（public/tools/<slug>.html）或占位内容
 */
export default async function ToolPageShell({ route }: ToolPageShellProps) {
  const membership = await getMembership();

  if (!membership.user) {
    redirect(`/login?redirectTo=${encodeURIComponent(route)}`);
  }
  if (membership.status === "banned") {
    redirect("/banned");
  }

  const tool = await getToolByRoute(route);
  if (!tool) notFound();

  const slug = route.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
  const vipOnly = tool.min_plan === "vip";
  const locked = vipOnly && !membership.isVip;

  if (locked) {
    redirect(`/upgrade?tool=${encodeURIComponent(slug)}`);
  }

  const { user, role } = await getCurrentUserWithRole();
  const iframeSrc = resolveIframeSrc(slug);

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/dashboard" />

      {iframeSrc ? (
        // 单文件 HTML 工具：iframe 撑满剩余高度
        <main className="flex w-full flex-1 flex-col overflow-hidden">
          <iframe
            src={iframeSrc}
            title={tool.name}
            className="block h-full min-h-0 w-full border-0 bg-white"
            allow="clipboard-write"
          />
        </main>
      ) : (
        // 尚未接入具体实现的占位内容
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
          <Link
            href="/dashboard"
            className="w-fit text-sm text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← 返回百宝箱
          </Link>

          <header className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <ToolIcon name="shield" />
            </span>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                {tool.name}
              </h1>
              {tool.description ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{tool.description}</p>
              ) : null}
            </div>
          </header>

          <section className="rounded-xl border border-dashed border-zinc-300 bg-white/60 px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">功能开发中</p>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              该工具已在数据库中登记，但对应的页面实现尚未补充。
            </p>
            <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
              接入方式：把单文件 HTML 放到{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                public/tools/{slug}.html
              </code>
              ，本页会自动用 iframe 加载。
            </p>
          </section>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">路由</dt>
              <dd className="mt-0.5 font-mono text-zinc-800 dark:text-zinc-200">{tool.route}</dd>
            </div>
            <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">访问要求</dt>
              <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">
                {vipOnly ? "会员专属" : "所有登录用户"}
              </dd>
            </div>
          </dl>
        </main>
      )}
    </>
  );
}
