import Link from "next/link";
import { fetchAllUsers } from "@/app/admin/membership-actions";
import FeatureFlagList from "@/components/feature-flag-list";
import MemberActions from "@/components/member-actions";
import RoleSelect from "@/components/role-select";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getFeatureFlags } from "@/lib/feature-flags";
import { getProfiles } from "@/lib/user-profile-db";
import { subjectName } from "@/lib/user-profile";
import { PLAN_LABELS, STATUS_LABELS, remainingDays } from "@/lib/membership-types";

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
        <SiteHeader role={role ?? "user"} current="/admin" />
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
  const vipCount = users.filter((item) => item.vipActive).length;
  const bannedCount = users.filter((item) => item.status === "banned").length;

  // 功能开关（读不到表时 ready=false，功能一律保持开启）
  const flagState = await getFeatureFlags();

  // ★ 2026-10 第二十批（用户要求）：用户列表要能看**老师姓名与校区**等基本信息。
  //   一次批量查询取回所有资料（不是每人一次）—— 6 个用户一次请求。
  //   ⚠️ 读不到（迁移 0021 没跑 / 没填）就是空对象 ⇒ 那一列退回显示邮箱，页面照常。
  const profiles = await getProfiles(users.map((u) => u.user_id));

  return (
    <>
      <SiteHeader role="admin" current="/admin" />

      <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            用户与权限管理
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {result.ok
              ? `共 ${users.length} 位用户：${adminCount} 位管理员、${vipCount} 位有效会员、${bannedCount} 位已封禁。修改后立即生效。`
              : "读取用户列表失败。"}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Link
              href="/admin/archives"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              🗂 全机构档案总览 →
            </Link>
            <Link
              href="/admin/feedback-keywords"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              ✎ 反馈关键词管理 →
            </Link>
            <Link
              href="/admin/feedback-candidates"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              🤖 AI 关键词审核 →
            </Link>
          </div>
        </div>

        {!result.ok ? (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            <p className="font-medium">无法读取用户列表</p>
            <p className="mt-1">{result.message}</p>
          </div>
        ) : (
          <div className="min-h-[55vh] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-5xl border-collapse text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">姓名 / 邮箱</th>
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="px-4 py-3 font-medium">会员状态</th>
                  <th className="px-4 py-3 font-medium">会员操作</th>
                  <th className="px-4 py-3 font-medium">注册 / 最近登录</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {users.map((item) => {
                  const isSelf = item.user_id === user?.id;
                  const days = remainingDays(item.expires_at);
                  const p = profiles[item.user_id];
                  const prof = {
                    name: p?.teacherName ?? "",
                    subjectName: subjectName(p?.subject ?? ""),
                    campus: p?.campus ?? "",
                  };

                  return (
                    <tr key={item.user_id} className="align-top">
                      <td className="px-4 py-3">
                        {/* ★ 2026-10 第二十批（用户口径）：这一列改成显示**老师的姓名 + 校区**，
                            邮箱挪到下面小字，那串 UUID **隐藏**（用户："这一堆字符码是啥我也不知道，
                            可以直接隐藏掉"——它是 Supabase 的用户 ID，排障时才需要）。
                            ⚠️ 没填资料的账号**仍然显示邮箱**（不能让人看起来像没有账号），
                               并给一句"资料未填"的提示。 */}
                        {prof.name || prof.campus ? (
                          <>
                            <span className="font-medium text-zinc-900 dark:text-zinc-100">
                              {prof.name || "(未填姓名)"}
                            </span>
                            {prof.subjectName || prof.campus ? (
                              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                {[prof.subjectName, prof.campus].filter(Boolean).join(" · ")}
                              </div>
                            ) : null}
                            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {item.email ?? "(无邮箱)"}
                            </div>
                          </>
                        ) : (
                          <>
                            <span className="font-medium text-zinc-900 dark:text-zinc-100">
                              {item.email ?? "(无邮箱)"}
                            </span>
                            <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                              资料未填（姓名/校区）
                            </div>
                          </>
                        )}
                        {isSelf ? (
                          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            你自己
                          </span>
                        ) : null}
                        {/* UUID 保留在 HTML 里但**视觉隐藏**：排障时还能从页面源码拿到 */}
                        <div className="sr-only" data-user-id>{item.user_id}</div>
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
                        <div className="flex flex-col gap-1">
                          <span
                            className={`w-fit rounded-full px-2 py-0.5 text-xs font-medium ${
                              item.vipActive
                                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                            }`}
                          >
                            {PLAN_LABELS[item.plan]}
                            {item.vipActive && days !== null ? `（剩 ${days} 天）` : ""}
                          </span>
                          <span
                            className={`text-xs ${
                              item.status === "banned"
                                ? "font-medium text-red-600 dark:text-red-400"
                                : "text-zinc-500 dark:text-zinc-400"
                            }`}
                          >
                            状态：{STATUS_LABELS[item.status]}
                          </span>
                          <span className="text-xs text-zinc-400 dark:text-zinc-500">
                            到期：{formatTime(item.expires_at)}
                          </span>
                          <span className="text-xs text-zinc-400 dark:text-zinc-500">
                            邮箱{item.email_confirmed ? "已确认" : "未确认"}
                          </span>
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <MemberActions
                          userId={item.user_id}
                          isVipActive={item.vipActive}
                          banned={item.status === "banned"}
                          isSelf={isSelf}
                        />
                      </td>

                      <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                        <div>注册：{formatTime(item.created_at)}</div>
                        <div className="mt-0.5">登录：{formatTime(item.last_sign_in_at)}</div>
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

        {/* ⚙️ 功能开关：初版功能的"一键关掉"（关掉的是**入口**，代码与数据都不变）
            ⚠️ 页面上**只留管理员需要的一句**（关掉会发生什么 + 多久生效）。
            技术说明（开关清单登记在哪个文件、权限怎么校验）属于**开发者文档**，
            已挪进 `docs/admin-page-notes.md` —— 别再加回页面上：
            管理员不需要看文件路径与 SECURITY DEFINER 这类实现细节。 */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              功能开关
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              关掉后对应入口消失，<b>代码与数据都不变</b>，最多 30 秒全站生效（不用重新部署）。
            </p>
          </div>
          <FeatureFlagList ready={flagState.ready} error={flagState.error} flags={flagState.flags} />
        </section>
      </main>
    </>
  );
}
