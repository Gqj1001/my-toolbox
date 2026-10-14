"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { manualScoreHooks } from "@/lib/manual-score";

type Props = {
  /** 这条记录的 id（删不掉的话就根本不渲染本按钮） */
  id: number;
  /** 用来在确认框里说清楚删的是哪一条 */
  title?: string;
};

/**
 * 删掉**一条**记录（2026-10 第十四批）。
 *
 * 为什么要有它：手动补录的成绩是老师自己填的，**填错必须有后悔药** ——
 * 以前只能让老师去 Supabase 里删，那是我们不希望老师做的事。
 *
 * ⚠️ 走**已有的** `DELETE /api/students?id=<historyId>`（阶段3 就上线了，
 *    行为与 `/api/feedback/data` 一致：删完必须清历史缓存，否则那条记录
 *    会在 25 秒内从缓存里"复活"）。
 * ⚠️ 只删这一条，**不碰**这个学生的档案行、也不碰别家工具的记录：
 *    与「删除这位学生」（会连带记录）是两件不同的事，所以确认框里的措辞要分清。
 */
export default function RecordDeleteButton({ id, title }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onDelete() {
    if (busy) return;
    const what = title ? `「${title}」这条记录` : "这条记录";
    if (!window.confirm(`确定删除${what}吗？\n\n只删这一条，不影响这个学生的档案和其它记录。`)) return;

    setBusy(true);
    setErr("");
    try {
      const hook = manualScoreHooks().remove(id);
      const r = await fetch(hook.url, { method: hook.method });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (r.ok && j?.ok) {
        router.refresh();
      } else {
        setErr(j?.error || `删除失败（HTTP ${r.status}）`);
      }
    } catch (e) {
      setErr("网络错误：" + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-900 dark:hover:bg-red-950 dark:hover:text-red-300"
      >
        {busy ? "删除中…" : "删除"}
      </button>
      {err ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</span>
      ) : null}
    </span>
  );
}
