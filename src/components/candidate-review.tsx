"use client";

import { useActionState, useEffect, useState } from "react";
import {
  promoteApproved,
  reviewCandidate,
  reviewCandidatesBulk,
  rollbackBatch,
  saveCandidateNote,
  type CandidateActionResult,
} from "@/app/admin/feedback-candidates/actions";

const initial: CandidateActionResult = { status: "idle" };

export type CandidateView = {
  id: number;
  batch_id: string;
  stage: string;
  subject: string;
  version: string;
  book_name: string;
  section_name: string;
  keywords: string[];
  status: "pending" | "approved" | "rejected";
  note: string | null;
  promoted_at: string | null;
};

const STAGE_LABEL: Record<string, string> = { senior: "高中", junior: "初中" };

function useResult(result: CandidateActionResult) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (result.status === "idle") return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 6000);
    return () => clearTimeout(t);
  }, [result]);
  if (!show || !result.message) return null;
  return (
    <span
      role={result.status === "error" ? "alert" : "status"}
      className={`text-xs ${
        result.status === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {result.message}
    </span>
  );
}

/** 一条候选（= 一章） */
function CandidateCard({ c, batchId }: { c: CandidateView; batchId: string }) {
  const [reviewState, reviewAction, reviewing] = useActionState(reviewCandidate, initial);
  const [noteState, noteAction, savingNote] = useActionState(saveCandidateNote, initial);
  const [open, setOpen] = useState(false);
  const reviewMsg = useResult(reviewState);
  const noteMsg = useResult(noteState);

  const statusStyle =
    c.status === "approved"
      ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40"
      : c.status === "rejected"
        ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60"
        : "border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20";

  return (
    <section className={`rounded-xl border ${statusStyle}`}>
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-xs text-zinc-400">{open ? "▼" : "▶"}</span>
          <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.section_name}</span>
          <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {c.keywords.length} 个知识点
          </span>
          {c.status === "approved" ? (
            <span className="shrink-0 text-xs text-emerald-700 dark:text-emerald-400">
              已通过{c.promoted_at ? " · 已提升" : ""}
            </span>
          ) : c.status === "rejected" ? (
            <span className="shrink-0 text-xs text-zinc-500">已拒绝</span>
          ) : null}
          {c.note ? <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">有备注</span> : null}
        </button>

        <form action={reviewAction} className="flex shrink-0 items-center gap-1">
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="action" value="approve" />
          <button
            type="submit"
            disabled={reviewing || c.status === "approved"}
            className="h-7 rounded-md border border-emerald-400 px-2 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-300"
          >
            通过
          </button>
        </form>
        <form action={reviewAction} className="shrink-0">
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="action" value="reject" />
          <button
            type="submit"
            disabled={reviewing || c.status === "rejected"}
            className="h-7 rounded-md border border-zinc-300 px-2 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200"
          >
            拒绝
          </button>
        </form>
        {c.status !== "pending" ? (
          <form action={reviewAction} className="shrink-0">
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="action" value="reset" />
            <button
              type="submit"
              disabled={reviewing}
              className="h-7 rounded-md border border-zinc-300 px-2 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700"
            >
              重置
            </button>
          </form>
        ) : null}
        {reviewMsg}
      </header>

      {open ? (
        <div className="border-t border-black/5 px-3 py-2 dark:border-white/5">
          <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
            {STAGE_LABEL[c.stage] ?? c.stage} · {c.version} · {c.book_name}
          </p>
          <ul className="mb-3 flex flex-wrap gap-1.5">
            {c.keywords.map((k, i) => (
              <li
                key={`${k}-${i}`}
                className="rounded-lg border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                {k}
              </li>
            ))}
            {c.keywords.length === 0 ? <li className="text-xs text-zinc-400">（无知识点）</li> : null}
          </ul>

          <form action={noteAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={c.id} />
            <input
              name="note"
              defaultValue={c.note ?? ""}
              placeholder="备注（如：这章少了「XX」）"
              className="h-7 min-w-[14rem] flex-1 rounded-md border border-zinc-300 px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="submit"
              disabled={savingNote}
              className="h-7 rounded-md border border-zinc-300 px-2 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700"
            >
              {savingNote ? "保存中…" : "保存备注"}
            </button>
            {noteMsg}
          </form>
        </div>
      ) : null}
    </section>
  );
}

type Props = {
  batchId: string;
  candidates: CandidateView[];
  /** 当前筛选 */
  filters: { stage: string; subject: string; status: string; book: string };
  /** 各科目的候选数与待审数（用于筛选栏与排序） */
  subjectStats: { subject: string; name: string; total: number; pending: number }[];
  /** 该批次已有多少条「已通过但未提升」 */
  approvedNotPromoted: number;
  /** 每本册次的候选数（用于册次筛选） */
  books: string[];
};

export default function CandidateReview({ batchId, candidates, filters, subjectStats, approvedNotPromoted, books }: Props) {
  const [promoteState, promoteAction, promoting] = useActionState(promoteApproved, initial);
  const [rollbackState, rollbackAction, rollingBack] = useActionState(rollbackBatch, initial);
  const [bulkState, bulkAction, bulking] = useActionState(reviewCandidatesBulk, initial);
  const promoteMsg = useResult(promoteState);
  const rollbackMsg = useResult(rollbackState);
  const bulkMsg = useResult(bulkState);

  const link = (next: Partial<typeof filters>) => {
    const p = new URLSearchParams();
    const merged = { ...filters, ...next };
    if (batchId) p.set("batch", batchId);
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/admin/feedback-candidates?${p.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 筛选栏 */}
      <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-zinc-500">科目</span>
          <a
            href={link({ subject: "" })}
            className={`rounded-lg px-2.5 py-1 text-xs ${
              !filters.subject ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300"
            }`}
          >
            全部
          </a>
          {subjectStats.map((s) => (
            <a
              key={s.subject}
              href={link({ subject: s.subject })}
              className={`rounded-lg px-2.5 py-1 text-xs ${
                filters.subject === s.subject
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : s.subject === "math" || s.subject === "physics"
                    ? "border border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400"
                    : "border border-amber-400 text-amber-800 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300"
              }`}
              title={s.subject === "math" || s.subject === "physics" ? "你熟悉的科目，可抽检" : "建议重点核对"}
            >
              {s.name} {s.pending}/{s.total}
            </a>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-zinc-500">状态</span>
          {[
            { v: "pending", label: "待审核" },
            { v: "approved", label: "已通过" },
            { v: "rejected", label: "已拒绝" },
            { v: "", label: "全部" },
          ].map((o) => (
            <a
              key={o.v}
              href={link({ status: o.v })}
              className={`rounded-lg px-2.5 py-1 text-xs ${
                filters.status === o.v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {o.label}
            </a>
          ))}
          <span className="ml-2 mr-1 text-xs text-zinc-500">学段</span>
          {[
            { v: "", label: "全部" },
            { v: "senior", label: "高中" },
            { v: "junior", label: "初中" },
          ].map((o) => (
            <a
              key={o.v}
              href={link({ stage: o.v })}
              className={`rounded-lg px-2.5 py-1 text-xs ${
                filters.stage === o.v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {o.label}
            </a>
          ))}
          <a
            href={`/admin/feedback-candidates/export?batch=${encodeURIComponent(batchId)}${filters.subject ? `&subject=${filters.subject}` : ""}${filters.status ? `&status=${filters.status}` : ""}`}
            className="ml-auto rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200"
          >
            ⬇ 导出 CSV
          </a>
        </div>

        {books.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-zinc-500">册次</span>
            <a
              href={link({ book: "" })}
              className={`rounded-lg px-2 py-0.5 text-xs ${!filters.book ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"}`}
            >
              全部
            </a>
            {books.slice(0, 30).map((b) => (
              <a
                key={b}
                href={link({ book: b })}
                className={`rounded-lg px-2 py-0.5 text-xs ${filters.book === b ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"}`}
              >
                {b}
              </a>
            ))}
          </div>
        ) : null}
      </div>

      {/* 批量操作 + 提升 + 回滚 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <form action={bulkAction} className="flex items-center gap-2">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="subject" value={filters.subject} />
          <input type="hidden" name="action" value="approve" />
          <button
            type="submit"
            disabled={bulking}
            className="h-8 rounded-md border border-emerald-400 px-3 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-300"
          >
            全部通过{filters.subject ? "（当前科目）" : ""}
          </button>
        </form>
        <form action={bulkAction} className="flex items-center gap-2">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="subject" value={filters.subject} />
          <input type="hidden" name="action" value="reject" />
          <button
            type="submit"
            disabled={bulking}
            className="h-8 rounded-md border border-zinc-300 px-3 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200"
          >
            全部拒绝{filters.subject ? "（当前科目）" : ""}
          </button>
        </form>
        {bulkMsg}

        <form action={promoteAction} className="ml-auto flex items-center gap-2">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="subject" value={filters.subject} />
          <button
            type="submit"
            disabled={promoting || approvedNotPromoted === 0}
            className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {promoting ? "提升中…" : `提升为正式数据（已通过未提升 ${approvedNotPromoted} 章，每次 20）`}
          </button>
        </form>

        <form action={rollbackAction} className="flex items-center gap-2">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="mode" value="soft" />
          <button
            type="submit"
            disabled={rollingBack}
            onClick={(e) => {
              if (!confirm("软回滚：归档本批次导入的全部关键词（知识点与章保留，可恢复）。确定？")) e.preventDefault();
            }}
            className="h-8 rounded-md border border-amber-400 px-3 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300"
          >
            {rollingBack ? "回滚中…" : "软回滚本批次"}
          </button>
        </form>
        {promoteMsg}
        {rollbackMsg}
      </div>

      {/* 候选列表 */}
      <div className="flex flex-col gap-2">
        {candidates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            没有匹配的候选条目。
          </p>
        ) : (
          candidates.map((c) => <CandidateCard key={c.id} c={c} batchId={batchId} />)
        )}
      </div>
    </div>
  );
}
