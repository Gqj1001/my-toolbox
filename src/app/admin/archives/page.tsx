import Link from "next/link";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getArchiveStats, listAllStudents, type AdminArchiveRow } from "@/lib/admin-archives";
import ArchiveCharts from "./archive-charts";
import { setArchiveCampusAction } from "./actions";

export const dynamic = "force-dynamic";

const field =
  "h-9 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const cell = "px-3 py-2 align-top text-sm text-zinc-700 dark:text-zinc-200";
const th = "px-3 py-2 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400";

function one(v: string | string[] | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

function returnTo(q: string, campus: string, teacher: string, month: string): string {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (campus) sp.set("campus", campus);
  if (teacher) sp.set("teacher", teacher);
  if (month) sp.set("month", month);
  const s = sp.toString();
  return s ? `/admin/archives?${s}` : "/admin/archives";
}

export default async function AdminArchivesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return (
      <>
        <SiteHeader role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：全机构档案总览仅对 admin 角色开放。
          </p>
        </main>
      </>
    );
  }

  const params = await searchParams;
  const q = one(params.q);
  const campus = one(params.campus);
  const teacher = one(params.teacher);
  const month = one(params.month);
  const err = one(params.err);
  const saved = one(params.saved) === "1";

  // 一次取全量（上限 1000）用于“校区/老师”下拉选项；再按筛选条件取当前页。
  // 早期机构档案规模远小于 1000；超过时页面会明确提示。
  const [all, filtered, stats] = await Promise.all([
    listAllStudents({ limit: 1000 }),
    listAllStudents({ search: q, campus, teacher, month, limit: 500 }),
    getArchiveStats(),
  ]);

  if (!all.ok || !filtered.ok) {
    const message = !all.ok ? all.message : (!filtered.ok ? filtered.message : "读取全机构档案失败。");
    return (
      <>
        <SiteHeader role="admin" current="/admin" />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-8">
          <Link href="/admin" className="w-fit text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400">
            ← 返回管理后台
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">全机构档案总览</h1>
          <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {message}
          </p>
        </main>
      </>
    );
  }

  const campuses = [...new Set(all.rows.map((r) => r.institutionCampus).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const teachers = [...new Set(all.rows.map((r) => r.teacherName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const total = filtered.total;
  const tooManyOptions = all.rows.length >= 1000;

  return (
    <>
      <SiteHeader role="admin" current="/admin" />
      <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-7xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <Link href="/admin" className="w-fit text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          ← 返回管理后台
        </Link>

        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">全机构档案总览</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-300">
            只读总览：老板可以看所有校区的学生档案，但不能在这里改档案正文。
            “校区”指老师所在的机构校区（如燕郊 / 大厂）；默认按创建老师当前校区推断，
            推错时可在最右列单独纠正这个学生的归属标签。
          </p>
        </header>

        {stats.ok ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="总学员数" value={stats.stats.totalStudents} unit="人" hint="全机构档案总数" />
              <Kpi label="本月新增学员" value={stats.stats.newThisMonth} unit="人" hint="按最早一条记录日期" />
              <Kpi
                label="本月消耗课时（约）"
                value={stats.stats.estimatedHoursThisMonth}
                unit="课时"
                hint={`按本月 ${stats.stats.feedbackThisMonth} 条课后反馈 × 2 课时估算`}
              />
              <Kpi label="进行中方案" value={stats.stats.activePlans} unit="份" hint="近 90 天有辅导方案记录" />
            </div>
            <ArchiveCharts stats={stats.stats} />
          </>
        ) : (
          <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {stats.message}
          </p>
        )}

        {err ? (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {err}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            归属标签已保存。
          </p>
        ) : null}

        <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          {month ? <input type="hidden" name="month" value={month} /> : null}
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            搜索（学生 / 老师 / 学校 / 学管师 / 邮箱）
            <input name="q" defaultValue={q} placeholder="如：张三 / 郭老师 / 三河一中" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            机构校区
            <select name="campus" defaultValue={campus} className={field}>
              <option value="">全部校区</option>
              {campuses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            老师
            <select name="teacher" defaultValue={teacher} className={field}>
              <option value="">全部老师</option>
              {teachers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <button type="submit" className="h-9 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
            筛选
          </button>
          <Link href="/admin/archives" className="inline-flex h-9 items-center rounded-lg border border-zinc-300 px-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
            清除
          </Link>
        </form>

        {month ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-300">
            当前下钻月份：<b>{month}</b>
            <Link href={returnTo(q, campus, teacher, "")} className="ml-2 underline">
              清除月份
            </Link>
          </p>
        ) : null}

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            共 <b>{total}</b> 份档案{filtered.rows.length < total ? `（当前显示 ${filtered.rows.length} 份）` : ""}
          </p>
          {tooManyOptions ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">档案超过 1000 份，校区/老师下拉只基于前 1000 份；请用搜索缩小范围。</p>
          ) : null}
        </div>

        <div className="overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[1000px] border-collapse text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className={th}>学生</th>
                <th className={th}>年级</th>
                <th className={th}>学校</th>
                <th className={th}>学管师</th>
                <th className={th}>任课老师</th>
                <th className={th}>机构校区</th>
                <th className={th}>负责人邮箱</th>
                <th className={th}>更新时间</th>
                <th className={th}>归属纠正</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {filtered.rows.map((r) => (
                <ArchiveRow key={r.id} row={r} returnTo={returnTo(q, campus, teacher, month)} />
              ))}
              {filtered.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    没有匹配的档案。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function Kpi({ label, value, unit, hint }: { label: string; value: number; unit: string; hint: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {value}
        <span className="ml-1 text-sm font-normal text-zinc-500 dark:text-zinc-400">{unit}</span>
      </p>
      <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}

function ArchiveRow({ row, returnTo }: { row: AdminArchiveRow; returnTo: string }) {
  return (
    <tr className="align-top">
      <td className={`${cell} font-medium text-zinc-900 dark:text-zinc-100`}>{row.name}</td>
      <td className={cell}>{row.grade || "—"}</td>
      <td className={cell}>{row.school || "—"}</td>
      <td className={cell}>{row.manager || "—"}</td>
      <td className={cell}>{row.teacherName || "—"}</td>
      <td className={cell}>
        {row.institutionCampus || <span className="text-amber-600 dark:text-amber-400">未归属</span>}
        <span className="ml-1 text-xs text-zinc-400">
          {row.campusSource === "manual" ? "（手动）" : row.campusSource === "teacher" ? "（按老师）" : ""}
        </span>
      </td>
      <td className={`${cell} text-xs text-zinc-500 dark:text-zinc-400`}>{row.ownerEmail || "—"}</td>
      <td className={`${cell} text-xs text-zinc-500 dark:text-zinc-400`}>
        {row.updatedAt ? new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "—"}
      </td>
      <td className={cell}>
        <div className="flex flex-col gap-1.5">
          <form action={setArchiveCampusAction} className="flex items-center gap-1">
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input
              name="campus"
              defaultValue={row.institutionCampus}
              placeholder="纠正机构校区"
              className="h-8 w-28 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <button type="submit" className="h-8 rounded-lg border border-zinc-300 px-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              保存
            </button>
          </form>
          {row.campusSource === "manual" ? (
            <form action={setArchiveCampusAction}>
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="campus" value="" />
              <button type="submit" className="text-left text-xs text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
                恢复按老师校区
              </button>
            </form>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
