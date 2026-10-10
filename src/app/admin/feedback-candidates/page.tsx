import Link from "next/link";
import CandidateReview, { type CandidateView } from "@/components/candidate-review";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "AI 关键词审核 | My Toolbox",
};

/**
 * 科目显示顺序：**不熟的科目优先**（化学/生物/政治/历史/地理 要重点核对），
 * 数学、物理放在最后（你熟悉，可抽检）。
 */
const SUBJECT_ORDER = [
  { code: "chemistry", name: "化学" },
  { code: "biology", name: "生物" },
  { code: "politics", name: "政治" },
  { code: "history", name: "历史" },
  { code: "geography", name: "地理" },
  { code: "chinese", name: "语文" },
  { code: "english", name: "英语" },
  { code: "math", name: "数学" },
  { code: "physics", name: "物理" },
];
const SUBJECT_RANK = new Map(SUBJECT_ORDER.map((s, i) => [s.code, i]));
const SUBJECT_NAME = new Map(SUBJECT_ORDER.map((s) => [s.code, s.name]));

const STAGE_LABEL: Record<string, string> = { senior: "高中", junior: "初中" };
const PAGE_SIZE = 50;

type SearchParams = Promise<{
  batch?: string;
  stage?: string;
  subject?: string;
  status?: string;
  book?: string;
  page?: string;
}>;

export default async function FeedbackCandidatesPage({ searchParams }: { searchParams: SearchParams }) {
  const { user, role } = await getCurrentUserWithRole();

  if (role !== "admin") {
    return (
      <>
        <SiteHeader role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：该页面仅对 admin 角色开放。
          </p>
        </main>
      </>
    );
  }

  const sp = await searchParams;
  const supabase = await createClient();

  // ---------- 批次列表 ----------
  const { data: batchRows, error: batchErr } = await supabase
    .from("feedback_section_candidates")
    .select("batch_id, created_at, status")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (batchErr) {
    return (
      <>
        <SiteHeader role="admin" current="/admin" />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-10">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">AI 关键词审核</h1>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            <p className="font-medium">候选表还不存在</p>
            <p className="mt-1">
              请先在 Supabase SQL Editor 执行{" "}
              <code className="font-mono">supabase/migrations/0007_sections_and_candidates.sql</code>
              ，再执行 <code className="font-mono">supabase/import/0007_candidates_BATCH.sql</code> 导入候选数据。
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              （数据库返回：{batchErr.code} {batchErr.message}）
            </p>
          </div>
        </main>
      </>
    );
  }

  const batches = [...new Set((batchRows ?? []).map((b) => b.batch_id))];
  const batchId = sp.batch && batches.includes(sp.batch) ? sp.batch : (batches[0] ?? "");

  const filters = {
    stage: ["senior", "junior"].includes(String(sp.stage)) ? String(sp.stage) : "",
    subject: SUBJECT_RANK.has(String(sp.subject)) ? String(sp.subject) : "",
    status: ["pending", "approved", "rejected"].includes(String(sp.status)) ? String(sp.status) : "pending",
    book: String(sp.book ?? ""),
  };
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);

  // ---------- 统计 ----------
  const { data: allRows } = batchId
    ? await supabase
        .from("feedback_section_candidates")
        .select("id, subject, status, book_name, promoted_at")
        .eq("batch_id", batchId)
        .limit(5000)
    : { data: [] as Array<{ id: number; subject: string; status: string; book_name: string; promoted_at: string | null }> };

  const rows = allRows ?? [];
  const subjectStats = SUBJECT_ORDER.map((s) => {
    const list = rows.filter((r) => r.subject === s.code);
    return {
      subject: s.code,
      name: s.name,
      total: list.length,
      pending: list.filter((r) => r.status === "pending").length,
    };
  }).filter((s) => s.total > 0)
    .sort((a, b) => (SUBJECT_RANK.get(a.subject) ?? 99) - (SUBJECT_RANK.get(b.subject) ?? 99));

  const approvedNotPromoted = rows.filter((r) => r.status === "approved" && !r.promoted_at).length;
  const batchBooks = [...new Set(rows.map((r) => r.book_name))];

  // ---------- 候选列表 ----------
  let q = supabase
    .from("feedback_section_candidates")
    .select("id, batch_id, stage, subject, version, book_name, section_name, keywords, status, note, promoted_at")
    .eq("batch_id", batchId);
  if (filters.stage) q = q.eq("stage", filters.stage);
  if (filters.subject) q = q.eq("subject", filters.subject);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.book) q = q.eq("book_name", filters.book);

  const { data: candidatesRaw } = await q
    .order("subject", { ascending: true })
    .order("version", { ascending: true })
    .order("book_name", { ascending: true })
    .order("id", { ascending: true })
    .limit(5000);

  // 按「不熟科目优先」排序后分页
  const sorted = (candidatesRaw ?? []).slice().sort((a, b) => {
    const ra = SUBJECT_RANK.get(a.subject) ?? 99;
    const rb = SUBJECT_RANK.get(b.subject) ?? 99;
    if (ra !== rb) return ra - rb;
    if (a.version !== b.version) return String(a.version).localeCompare(String(b.version), "zh");
    if (a.book_name !== b.book_name) return String(a.book_name).localeCompare(String(b.book_name), "zh");
    return a.id - b.id;
  });
  const totalPages = Math.max(Math.ceil(sorted.length / PAGE_SIZE), 1);
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const candidates: CandidateView[] = pageRows.map((c) => ({
    id: c.id,
    batch_id: c.batch_id,
    stage: c.stage,
    subject: c.subject,
    version: c.version,
    book_name: c.book_name,
    section_name: c.section_name,
    keywords: Array.isArray(c.keywords) ? (c.keywords as string[]) : [],
    status: c.status as CandidateView["status"],
    note: c.note ?? null,
    promoted_at: c.promoted_at ?? null,
  }));

  const pageLink = (p: number) => {
    const params = new URLSearchParams();
    params.set("batch", batchId);
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (p > 1) params.set("page", String(p));
    return `/admin/feedback-candidates?${params.toString()}`;
  };

  return (
    <>
      <SiteHeader role="admin" current="/admin" />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <nav className="text-xs text-zinc-500 dark:text-zinc-400">
              <Link href="/admin" className="hover:underline">
                用户与权限管理
              </Link>
              <span className="mx-1">/</span>
              <span>AI 关键词审核</span>
            </nav>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              AI 关键词审核
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              候选 {rows.length} 章（待审 {rows.filter((r) => r.status === "pending").length}）。
              通过后到下方点「提升为正式数据」才会写入关键词库。
              <span className="ml-1 font-medium text-zinc-700 dark:text-zinc-300">不熟的科目排在前面</span>，建议先核对。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/admin/feedback-keywords"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              关键词库
            </Link>
            <Link
              href="/admin"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              ← 返回用户管理
            </Link>
          </div>
        </div>

        {batches.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-500">批次</span>
            {batches.map((b) => (
              <Link
                key={b}
                href={`/admin/feedback-candidates?batch=${encodeURIComponent(b)}`}
                className={`rounded-lg px-2.5 py-1 text-xs ${
                  b === batchId
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                {b}
              </Link>
            ))}
          </div>
        ) : null}

        {!batchId ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            还没有任何候选数据。请先执行 <code className="font-mono">supabase/import/0007_candidates_BATCH.sql</code>。
          </p>
        ) : (
          <>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              批次 <span className="font-mono">{batchId}</span>
              {filters.subject ? ` · ${SUBJECT_NAME.get(filters.subject)}` : ""}
              {filters.stage ? ` · ${STAGE_LABEL[filters.stage]}` : ""}
            </p>

            <CandidateReview
              batchId={batchId}
              candidates={candidates}
              filters={filters}
              subjectStats={subjectStats}
              approvedNotPromoted={approvedNotPromoted}
              books={batchBooks}
            />

            {totalPages > 1 ? (
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {page > 1 ? (
                  <Link href={pageLink(page - 1)} className="rounded-lg border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700">
                    ← 上一页
                  </Link>
                ) : null}
                <span className="text-xs text-zinc-500">
                  第 {page} / {totalPages} 页（共 {sorted.length} 章）
                </span>
                {page < totalPages ? (
                  <Link href={pageLink(page + 1)} className="rounded-lg border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700">
                    下一页 →
                  </Link>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          审核与提升都在 Server Action 里执行，首行 <code className="font-mono">requireAdmin()</code> 做服务端权威校验；
          数据库 RLS 是第二道防线。提升时每个知识点会写入「课堂内容」「下节课内容」两个分类，
          并带 <code className="font-mono">import_batch_id</code>，可整批回滚。
        </p>
      </main>
    </>
  );
}
