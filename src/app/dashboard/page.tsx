import SignOutButton from "@/components/sign-out-button";
import ToolGrid from "@/components/tool-grid";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getToolsForRole, TOOLS } from "@/lib/tools";

const errorMessages: Record<string, string> = {
  admin_required: "该页面仅对 admin 角色开放，你没有访问权限。",
  self_demoted: "你已把自己降级为普通用户，管理后台的访问权限已收回。",
};

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  // 未登录用户到不了这里：src/proxy.ts 已经把它重定向到 /login
  const { user, role } = await getCurrentUserWithRole();

  const params = await searchParams;
  const errorKey = typeof params.error === "string" ? params.error : "";
  const errorMessage = errorMessages[errorKey];

  const tools = getToolsForRole(role);
  const isAdmin = role === "admin";
  const hiddenCount = TOOLS.length - tools.length;

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/dashboard" />

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
              isAdmin
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {isAdmin ? "管理员：可见全部工具" : "普通用户：仅可见已授权工具"}
          </span>
          <span className="text-zinc-500 dark:text-zinc-400">
            共 {tools.length} 个工具
            {!isAdmin && hiddenCount > 0 ? `（另有 ${hiddenCount} 个管理员专属工具已隐藏）` : ""}
          </span>
        </div>

        <ToolGrid tools={tools} />
      </main>
    </>
  );
}
