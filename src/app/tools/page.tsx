import MembershipCard from "@/components/membership-card";
import SiteHeader from "@/components/site-header";
import ToolGrid from "@/components/tool-grid";
import { getViewer } from "@/lib/viewer";
import { PLAN_LABELS } from "@/lib/membership-types";
import { getActiveTools, toToolView } from "@/lib/tools-db";

/** 从别处被踢回来时带的中文说明（`?error=xxx`）。
 * ⚠️ 「非管理员访问后台被送回」的落点是**这里**（见 src/proxy.ts）——
 *    以前落在 `/dashboard`；2026-10 起百宝箱要改成「学员档案」页，不该再兼兜底落地页。 */
const errorMessages: Record<string, string> = {
  admin_required: "该页面仅对 admin 角色开放，你没有访问权限。",
  self_demoted: "你已把自己降级为普通用户，管理后台的访问权限已收回。",
};

/**
 * 工具列表 = **个人中心**（2026-10 起）。
 *
 * 这页现在同时负责两件事：
 *   ① 「我是谁、我什么会员、怎么退出」→ 顶部会员状态卡（以前散在顶栏 + /dashboard）
 *   ② 有哪些工具、能不能用 → ToolGrid
 *
 * ⚠️ 为什么把会员信息收在这里：原来顶栏和 `/dashboard` 正文各显示一遍，
 *    同一个页面上同一件事出现两三遍，改一处要记着改几处。
 * ⚠️ 不要让这里再 fetch 会员数据：`getViewer()` 已经是服务端唯一来源（还有 30 秒缓存），
 *    多一个来源就会出现「顶栏说会员、正文说免费」这种自相矛盾。
 */
export default async function ToolsPage({ searchParams }: PageProps<"/tools">) {
  // 性能：getActiveTools() 不依赖会员信息，与 getViewer() 并发即可，不要串成两层
  const [viewer, toolRows] = await Promise.all([getViewer(), getActiveTools()]);

  const membership = viewer.membership;
  const { user, role } = viewer;
  const tools = toolRows.map((row) => toToolView(row, membership));
  const lockedCount = tools.filter((t) => t.locked).length;

  const params = await searchParams;
  const errorKey = typeof params.error === "string" ? params.error : "";
  const errorMessage = errorMessages[errorKey];

  return (
    <>
      <SiteHeader role={role ?? "user"} current="/tools" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        {errorMessage ? (
          <p
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
          >
            {errorMessage}
          </p>
        ) : null}

        <MembershipCard
          email={user?.email ?? null}
          role={role ?? "user"}
          plan={membership.plan}
          isVip={membership.isVip}
          expiresAt={membership.expiresAt}
        />

        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            工具列表
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            当前会员等级 <span className="font-medium">{PLAN_LABELS[membership.plan]}</span>，
            共 {tools.length} 个工具
            {lockedCount > 0 ? `，其中 ${lockedCount} 个需要会员` : ""}。
          </p>
        </div>

        <ToolGrid tools={tools} />
      </main>
    </>
  );
}
