import Link from "next/link";
import { redirect } from "next/navigation";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole, isOwnerRole } from "@/lib/auth-role";
import { getScopeData } from "@/lib/admin-scopes";
import { assignManagerAction, createCampusAction, createRegionAction } from "./actions";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40";
const field = "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const btn = "inline-flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const th = "px-3 py-2 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400";
const td = "px-3 py-2 align-top text-sm text-zinc-700 dark:text-zinc-200";

function one(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function AdminScopesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role, adminScope } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return (
      <>
        <SiteHeader role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：大区与权限管理仅对 Owner 开放。
          </p>
        </main>
      </>
    );
  }
  if (!isOwnerRole(role, adminScope)) redirect("/admin/archives");

  const params = await searchParams;
  const ok = one(params.ok);
  const err = one(params.err);
  const data = await getScopeData();

  return (
    <>
      <SiteHeader role="admin" current="/admin" />
      <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <Link href="/admin" className="w-fit text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          ← 返回管理后台
        </Link>

        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">大区与权限管理</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-300">
            Owner 专用。上半部分维护大区/校区；下半部分按邮箱给老师分配 Owner、大区管理员或校区管理员。
            大区/校区管理员目前是只读。
          </p>
        </header>

        {ok ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">{ok}</p> : null}
        {err ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{err}</p> : null}

        {!data.ok ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {data.message}
          </p>
        ) : (
          <>
            <section className={card}>
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">大区与校区</h2>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <form action={createRegionAction} className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 text-xs text-zinc-500">
                    新建大区
                    <input name="name" required maxLength={40} placeholder="如：廊坊大区（三河区域）" className={`${field} mt-1`} />
                  </label>
                  <button type="submit" className={btn}>新建大区</button>
                </form>
                <form action={createCampusAction} className="flex flex-wrap items-end gap-2">
                  <label className="w-40 text-xs text-zinc-500">
                    所属大区
                    <select name="regionId" required className={`${field} mt-1`}>
                      <option value="">选择大区…</option>
                      {data.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                  <label className="flex-1 text-xs text-zinc-500">
                    新建校区
                    <input name="name" required maxLength={40} placeholder="如：燕郊中学校区" className={`${field} mt-1`} />
                  </label>
                  <button type="submit" className={btn}>新建校区</button>
                </form>
              </div>

              <div className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
                {data.regions.length === 0 ? (
                  <p className="py-2 text-sm text-zinc-500">还没有大区，先在上方新建。</p>
                ) : data.regions.map((r) => (
                  <div key={r.id} className="py-3">
                    <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{r.name}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {r.campuses.length ? r.campuses.map((c) => (
                        <span key={c.id} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{c.name}</span>
                      )) : <span className="text-xs text-zinc-400">这个区还没有校区</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={card}>
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">管理者分配</h2>
              <form action={assignManagerAction} className="mt-3 grid gap-3 md:grid-cols-4">
                <label className="text-xs text-zinc-500">
                  老师邮箱
                  <input name="email" type="email" required placeholder="teacher@example.com" className={`${field} mt-1`} />
                </label>
                <label className="text-xs text-zinc-500">
                  角色
                  <select name="scope" required className={`${field} mt-1`}>
                    <option value="">选择角色…</option>
                    <option value="region">大区管理员（只读）</option>
                    <option value="campus">校区管理员（只读）</option>
                    <option value="owner">Owner</option>
                    <option value="none">取消管理员（普通老师）</option>
                  </select>
                </label>
                <label className="text-xs text-zinc-500">
                  大区
                  <select name="regionId" className={`${field} mt-1`}>
                    <option value="">（大区管理员才选）</option>
                    {data.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                <label className="text-xs text-zinc-500">
                  校区
                  <select name="campusId" className={`${field} mt-1`}>
                    <option value="">（校区管理员才选）</option>
                    {data.regions.flatMap((r) => r.campuses.map((c) => (
                      <option key={c.id} value={c.id}>{r.name} / {c.name}</option>
                    )))}
                  </select>
                </label>
                <div className="md:col-span-4">
                  <button type="submit" className={btn}>保存权限</button>
                  <span className="ml-2 text-xs text-zinc-400">Owner 权限请谨慎分配；大区/校区管理员只能看本范围档案。</span>
                </div>
              </form>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left">
                  <thead>
                    <tr>
                      <th className={th}>账号</th>
                      <th className={th}>老师姓名</th>
                      <th className={th}>角色</th>
                      <th className={th}>范围</th>
                      <th className={th}>更新时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.managers.length === 0 ? (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-zinc-500">还没有管理员。</td></tr>
                    ) : data.managers.map((m) => (
                      <tr key={m.userId}>
                        <td className={`${td} break-all`}>{m.email}</td>
                        <td className={td}>{m.teacherName || "—"}</td>
                        <td className={td}>
                          {m.scope === "owner" ? "Owner" : m.scope === "region" ? "大区管理员" : m.scope === "campus" ? "校区管理员" : m.role === "admin" ? "管理员（旧）" : "普通老师"}
                        </td>
                        <td className={td}>{m.scope === "region" ? m.scopeName : m.scope === "campus" ? m.campusName || m.scopeName : "全部"}</td>
                        <td className={td}>{m.updatedAt ? new Date(m.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
