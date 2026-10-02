import SiteHeader from "@/components/site-header";
import ToolGrid from "@/components/tool-grid";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getToolsForRole } from "@/lib/tools";

export default async function ToolsPage() {
  const { user, role } = await getCurrentUserWithRole();
  const tools = getToolsForRole(role);

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/tools" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            工具列表
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            当前角色 <span className="font-medium">{role}</span>，共 {tools.length} 个可用工具。
            本页与百宝箱使用同一份工具目录与权限规则。
          </p>
        </div>

        <ToolGrid tools={tools} />
      </main>
    </>
  );
}
