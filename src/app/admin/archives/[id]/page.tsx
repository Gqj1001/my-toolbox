import Link from "next/link";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/site-header";
import AnalysisSummary from "@/app/dashboard/analysis-summary";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getStudentDetail } from "@/lib/admin-archives";
import type { HistoryRow, StudentRow } from "@/lib/feedback-db";
import { buildStudentReport, TOOL_LABELS } from "@/lib/student-report";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40";
const th = "px-3 py-2 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400";
const td = "px-3 py-2 align-top text-sm text-zinc-700 dark:text-zinc-200";

function fmt(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default async function AdminStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { role } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return (
      <>
        <SiteHeader role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：学生详情仅对管理员开放。
          </p>
        </main>
      </>
    );
  }

  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) notFound();

  const result = await getStudentDetail(id);
  if (!result.ok) {
    return (
      <>
        <SiteHeader role="admin" current="/admin" />
        <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
          <Link href="/admin/archives" className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            ← 返回全机构档案
          </Link>
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {result.message}
          </p>
        </main>
      </>
    );
  }

  const { student, history } = result.detail;
  const studentRow: StudentRow = {
    id: student.id,
    name: student.name,
    subject: student.subject || null,
    salutation: null,
    teacher: student.teacherName || null,
    type: null,
    notes: null,
    updated_at: student.updatedAt ?? new Date().toISOString(),
    grade: student.grade || null,
    gender: null,
    campus: student.school || null,
    manager: student.manager || null,
    class_name: student.className || null,
    attitude: student.attitude || null,
    extra: student.extra,
  };
  const rows: HistoryRow[] = history.map((h) => ({
    id: h.id,
    student_name: h.studentName,
    text: h.text,
    date: h.date,
    type_name: h.typeName,
    subject: h.subject,
    created_at: h.createdAt,
    tool: h.tool,
    title: h.title,
    score: h.score,
    full_score: h.fullScore,
  }));
  const report = buildStudentReport({ name: student.name, student: studentRow, rows });

  return (
    <>
      <SiteHeader role="admin" current="/admin" />
      <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <Link href="/admin/archives" className="w-fit text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          ← 返回全机构档案
        </Link>

        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{student.name}</h1>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">只读</span>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-300">
            管理员只读视图：可以查看这位学生的全部记录与学情统计，不能在这里修改档案正文。
          </p>
        </header>

        <section className={card}>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">基础信息</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-zinc-400">学校</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.school || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">年级</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.grade || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">机构校区</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.teacherCampus || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">任课老师</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.teacherName || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">学管师</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.manager || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">班级</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.className || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">负责人邮箱</dt><dd className="break-all text-zinc-800 dark:text-zinc-100">{student.ownerEmail || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">最近更新</dt><dd className="text-zinc-800 dark:text-zinc-100">{fmt(student.updatedAt)}</dd></div>
          </dl>
        </section>

        <AnalysisSummary report={report} />

        <section className={card}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">历史记录</h2>
            <span className="text-xs text-zinc-400">共 {history.length} 条</span>
          </div>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">这位学生还没有记录。</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr>
                    <th className={th}>日期</th>
                    <th className={th}>类型</th>
                    <th className={th}>标题</th>
                    <th className={th}>分数</th>
                    <th className={th}>正文</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className={td}>{h.date || fmt(h.createdAt)}</td>
                      <td className={td}>{TOOL_LABELS[h.tool] ?? h.tool}</td>
                      <td className={td}>{h.title || "—"}</td>
                      <td className={td}>{h.score != null && h.fullScore != null ? `${h.score} / ${h.fullScore}` : "—"}</td>
                      <td className={`${td} max-w-[520px] whitespace-pre-wrap break-words`}>{h.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
