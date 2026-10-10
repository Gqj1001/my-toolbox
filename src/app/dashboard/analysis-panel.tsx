"use client";

import { useState } from "react";
import Link from "next/link";

type Props = {
  name: string;
  /** 当前用户是不是**有效会员**（服务端算好传进来；前端判断不构成安全边界） */
  isVip: boolean;
  /** 这位学生有没有可用的记录（没有就不该让点，AI 也没材料） */
  hasRecords: boolean;
};

/**
 * 学情分析 · AI 报告（会员专属）
 *
 * ⚠️ 下面那份**统计**（概览 / 成绩趋势 / 课时 / 薄弱与失分）是**服务端直接渲染**的，
 *    所有人都看得到、也不需要 AI。这个组件只负责「把统计交给 AI 组织成一份报告」，
 *    所以免费用户看到的是完整统计 + 一句「AI 报告是会员专属」。
 *
 * ⚠️ **每生成一次都会在档案里存一条记录**（用户明确要落库）。这一点必须写在按钮旁边 ——
 *    否则老师点几次就在档案里堆几条，事后会觉得"怎么多出来这么多"。
 *
 * ⚠️ 409（数据库那条 CHECK 还没放开）时接口会**连报告正文一起返回**，
 *    所以这里刻意先取 `j.report` 再判成功与否：**不能让用户白花一次 AI 调用**。
 */
export default function AnalysisPanel({ name, isVip, hasRecords }: Props) {
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function run() {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/students/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; report?: string; error?: string; saved?: boolean; title?: string }
        | null;
      // 报告优先：失败响应里也可能带着已经生成好的正文（见上面的说明）
      if (j?.report) setText(String(j.report));
      if (r.ok && j?.ok) {
        setMsg({
          kind: "ok",
          text: j.saved
            ? `已生成并存入档案（${j.title ?? ""}）`
            : "已生成。档案里已有一份同名记录，本次没有重复保存。",
        });
      } else {
        setMsg({ kind: "err", text: j?.error || `生成失败（HTTP ${r.status}）` });
      }
    } catch (e) {
      setMsg({ kind: "err", text: "网络错误：" + String((e as Error)?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          AI 整体学情报告
          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            会员专属
          </span>
        </p>
        {isVip && hasRecords ? (
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {loading ? "生成中…（约 10–30 秒）" : text ? "重新生成" : "生成学情报告"}
          </button>
        ) : null}
      </div>

      {!hasRecords ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          这位学生还没有记录，AI 没有材料可分析。先在「辅导方案 / 试卷分析 / 课后反馈」里存一条记录。
        </p>
      ) : !isVip ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          上面的统计所有人都能看；把统计交给 AI 写成一份报告是会员功能。
          <Link href="/upgrade" className="ml-1 underline">
            查看会员权益
          </Link>
        </p>
      ) : (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          AI 只依据上面这些<b>已经存在的记录</b>来写（材料里没有的不会编）。
          <span className="text-zinc-400 dark:text-zinc-500">
            ⚠️ 每生成一次都会在档案里存一条「学情报告」记录，可在下方记录列表里看到。
          </span>
        </p>
      )}

      {msg ? (
        <p
          role={msg.kind === "ok" ? "status" : "alert"}
          className={`mt-2 text-xs ${msg.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
        >
          {msg.text}
        </p>
      ) : null}

      {text ? (
        <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 px-3 py-2.5 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
          {text}
        </pre>
      ) : null}
    </section>
  );
}
