import SiteHeader from "@/components/site-header";
import ToolGrid from "@/components/tool-grid";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getMembership } from "@/lib/membership";
import { PLAN_LABELS } from "@/lib/membership-types";
import { getToolViewsForMembership } from "@/lib/tools-db";

export default async function ToolsPage() {
  const [membership, { user, role }] = await Promise.all([
    getMembership(),
    getCurrentUserWithRole(),
  ]);

  const tools = await getToolViewsForMembership(membership);
  const lockedCount = tools.filter((t) => t.locked).length;

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/tools" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
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
