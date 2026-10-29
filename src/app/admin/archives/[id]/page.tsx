import Link from "next/link";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/site-header";
import PrintPdfButton from "@/components/print-pdf-button";
import AnalysisSummary from "@/app/dashboard/analysis-summary";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getStudentDetail } from "@/lib/admin-archives";
import type { HistoryRow, StudentRow } from "@/lib/feedback-db";
import { buildStudentReport, cleanHistoryTitle, TOOL_LABELS } from "@/lib/student-report";
import { stripReportMarkup } from "@/lib/markdown-tables";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40";

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
  const { role, adminScope } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return (
      <>
        <SiteHeader role={role ?? "user"} current="/admin" adminScope={adminScope} />
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
        <SiteHeader role="admin" current="/admin" adminScope={adminScope} />
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
  const latestAnalysis = history.find((h) => h.tool === "analysis");
  const sortKey = (h: (typeof history)[number]) => (h.date && /^\d{4}-\d{2}-\d{2}/.test(h.date) ? h.date : h.createdAt);
  const sortedHistory = [...history].sort((a, b) => String(sortKey(b)).localeCompare(String(sortKey(a))));
  const toolOrder = ["math-plan", "plan-generator", "paper", "feedback", "manual", "analysis"];
  const groups = toolOrder
    .map((tool) => ({ tool, items: sortedHistory.filter((h) => h.tool === tool) }))
    .filter((g) => g.items.length);
  for (const tool of [...new Set(sortedHistory.map((h) => h.tool))]) {
    if (!toolOrder.includes(tool)) groups.push({ tool, items: sortedHistory.filter((h) => h.tool === tool) });
  }

  return (
    <>
      <SiteHeader role="admin" current="/admin" adminScope={adminScope} />
      <main id="print-report" className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
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

        <div className="flex flex-wrap gap-2">
          <PrintPdfButton />
        </div>

        <section className={card}>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">基础信息</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-zinc-400">学校</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.school || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">年级</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.grade || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">机构校区</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.teacherCampus || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">任课老师</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.teacherName || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">学管师</dt><dd className="text-zinc-800 dark:text-zinc-100">{student.manager || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">负责人邮箱</dt><dd className="break-all text-zinc-800 dark:text-zinc-100">{student.ownerEmail || "—"}</dd></div>
            <div><dt className="text-xs text-zinc-400">最近更新</dt><dd className="text-zinc-800 dark:text-zinc-100">{fmt(student.updatedAt)}</dd></div>
          </dl>
        </section>

        <AnalysisSummary report={report} />

        {latestAnalysis ? (
          <details className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-200">
              AI 学情报告（点击展开）
              <span className="ml-2 text-xs font-normal text-zinc-400">{latestAnalysis.date || fmt(latestAnalysis.createdAt)}</span>
            </summary>
            <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              {stripReportMarkup(latestAnalysis.text)}
            </div>
          </details>
        ) : null}

        <section className={card}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">历史记录</h2>
            <span className="text-xs text-zinc-400">共 {history.length} 条 · 按标签分类、组内按时间倒序</span>
          </div>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">这位学生还没有记录。</p>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
              {groups.map((g) => {
                const label = TOOL_LABELS[g.tool] ?? g.tool;
                const shown = g.tool === "feedback" ? g.items.slice(0, 3) : g.items;
                const folded = g.tool === "feedback" ? g.items.slice(3) : [];
                const row = (h: (typeof sortedHistory)[number]) => (
                  <li key={h.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-zinc-400">{h.date || fmt(h.createdAt)}</span>
                          <span className="font-medium">{cleanHistoryTitle(h.title || "") || label}</span>
                          {h.score != null && h.fullScore != null ? <span className="text-xs text-zinc-400">{h.score} / {h.fullScore}</span> : null}
                        </span>
                        <span className="text-xs text-zinc-400">展开全文</span>
                      </summary>
                      <div className="border-t border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
                        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">{h.text}</div>
                      </div>
                    </details>
                  </li>
                );
                return (
                  <section key={g.tool}>
                    <h3 className="mb-1.5 flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{label}</span>
                      <span className="text-xs font-normal text-zinc-400">{g.items.length} 条</span>
                    </h3>
                    <ul className="flex flex-col gap-1.5">{shown.map(row)}</ul>
                    {folded.length ? (
                      <details className="mt-1.5 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                        <summary className="cursor-pointer text-xs text-zinc-500">展开全部（共 {g.items.length} 条）</summary>
                        <ul className="mt-2 flex flex-col gap-1.5">{folded.map(row)}</ul>
                      </details>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
