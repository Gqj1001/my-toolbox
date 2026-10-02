import { fetchAllUsers } from "@/app/admin/actions";
import RoleSelect from "@/components/role-select";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";

function formatTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export default async function AdminPage() {
  // proxy.ts 已经拦截过一轮；这里再校验一次，避免守卫被绕过时页面仍然渲染
  const { user, role } = await getCurrentUserWithRole();

  if (role !== "admin") {
    return (
      <>
        <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：管理后台仅对 admin 角色开放。
          </p>
        </main>
      </>
    );
  }

  const result = await fetchAllUsers();

  const users = result.ok ? result.users : [];
  const adminCount = users.filter((item) => item.role === "admin").length;

  return (
    <>
      <SiteHeader email={user?.email ?? null} role="admin" current="/admin" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            用户与权限管理
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {result.ok
              ? `共 ${users.length} 位注册用户，其中 ${adminCount} 位管理员。修改下拉框后自动保存。`
              : "读取用户列表失败。"}
          </p>
        </div>

        {!result.ok ? (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            <p className="font-medium">无法读取用户列表</p>
            <p className="mt-1">{result.message}</p>
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              请确认已在 Supabase SQL Editor 中执行
              supabase/migrations/0001_user_roles.sql，并刷新本页。
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-3xl border-collapse text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">邮箱</th>
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="px-4 py-3 font-medium">邮箱状态</th>
                  <th className="px-4 py-3 font-medium">注册时间</th>
                  <th className="px-4 py-3 font-medium">最近登录</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {users.map((item) => {
                  const isSelf = item.user_id === user?.id;
                  return (
                    <tr key={item.user_id} className="align-top">
                      <td className="px-4 py-3">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {item.email ?? "(无邮箱)"}
                        </span>
                        {isSelf ? (
                          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            你自己
                          </span>
                        ) : null}
                        <div className="mt-0.5 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                          {item.user_id}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RoleSelect
                          userId={item.user_id}
                          email={item.email}
                          currentRole={item.role}
                          isSelf={isSelf}
                        />
                      </td>
                      <td className="px-4 py-3">
                        {item.email_confirmed ? (
                          <span className="text-emerald-600 dark:text-emerald-400">已确认</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">未确认</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                        {formatTime(item.created_at)}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                        {formatTime(item.last_sign_in_at)}
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                      暂无用户数据。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          权限判定以数据库 user_roles 表为准；读取用户列表通过 SECURITY DEFINER 函数
          admin_list_users() 完成，函数内部会再次校验管理员身份。
        </p>
      </main>
    </>
  );
}
