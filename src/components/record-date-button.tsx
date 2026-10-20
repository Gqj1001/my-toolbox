"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  /** 这条记录的 id */
  id: number;
  /** 现在库里的日期（ISO `2026-10-07`；没有就是空串 ⇒ 界面上显示「未填日期」） */
  date?: string | null;
  /** 用来在提示里说清改的是哪一条 */
  title?: string;
};

/**
 * 改**一条**记录的日期（2026-10 用户线上验收后加）。
 *
 * 为什么要有它：补录历史材料时日期原来只靠 AI 从原文抽，抽不到就存 NULL ——
 * 档案详情页显示「未填日期」、学情分析按时间排就排不进去。老师事后必须能自己补上。
 * 用户原话：**「在档案详情页的记录列表里，添加"修改日期"的功能（允许老师事后修正）」**。
 *
 * ⚠️ 走新增的 `POST /api/students { op:"setDate", id, date }`：
 *    只 update `date` 一列（**不是整行覆盖**），正文/分数/工具归属都不动。
 * ⚠️ 不用 `window.prompt/confirm` 让老师手打日期：日期要的是 `2026-10-07` 这种格式，
 *    手打容易错；用原生 `<input type="date">` 自带日历选择，也省一次校验。
 * ⚠️ 保存成功后 `router.refresh()`：让服务端重算记录列表**和**学情分析（同一个页面两处都用它）。
 */
export default function RecordDateButton({ id, date, title }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(date ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "setDate", id, date: value }),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (r.ok && j?.ok) {
        setOpen(false);
        // ⚠️ 必须 refresh：学情分析是**服务端**按日期算的，不刷新会显示老排序
        router.refresh();
      } else {
        setErr(j?.error || `改日期失败（HTTP ${r.status}）`);
      }
    } catch (e) {
      setErr("网络错误：" + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => { setOpen(true); setErr(""); }}
          title={title ? `改「${title}」的日期` : "改这条记录的日期"}
          className={`rounded-md border px-2 py-0.5 text-xs transition ${
            date
              ? "border-zinc-200 text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
              : "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          }`}
        >
          {date ? "改日期" : "补日期"}
        </button>
        {err ? <span role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</span> : null}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="记录日期"
        className="h-7 rounded-md border border-zinc-300 bg-white px-1.5 text-xs text-zinc-900 outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
      <button
        type="button"
        onClick={save}
        disabled={busy || !value}
        className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
      >
        {busy ? "保存中…" : "保存"}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setValue(String(date ?? "")); setErr(""); }}
        disabled={busy}
        className="rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500 transition hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        取消
      </button>
      {err ? <span role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</span> : null}
    </span>
  );
}
