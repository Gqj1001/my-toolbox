import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";

/**
 * 高中数学辅导方案生成器
 *
 * 工具本体是单文件 HTML，放在 public/tools/math-plan.html，
 * 这里用 iframe 承载；角色要求为 all（普通用户与管理员都可用）。
 *
 * 未登录用户到不了这里：src/proxy.ts 会重定向到 /login。
 * 直接访问 /tools/math-plan.html 同样受 proxy 保护（未登录会被拦到登录页）。
 *
 * 撑满方式：外层 main 用 flex-1 + min-h-0 占满 body 剩余高度，
 * iframe 用 h-full 跟随，不硬编码 header 高度（避免出现滚动条）。
 */
export default async function MathPlanPage() {
  const { user, role } = await getCurrentUserWithRole();

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/dashboard" />

      <main className="flex w-full flex-1 flex-col overflow-hidden">
        <iframe
          src="/tools/math-plan.html"
          title="高中数学辅导方案生成器"
          className="block h-full min-h-0 w-full border-0 bg-white"
          allow="clipboard-write"
        />
      </main>
    </>
  );
}
