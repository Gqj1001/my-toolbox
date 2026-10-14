"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EXAM_TYPES, manualScoreHooks } from "@/lib/manual-score";

const field =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const label = "flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400";

/** 本地日期，`YYYY-MM-DD`（不能用 `toISOString()`：那是 UTC，晚上会差一天） */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Props = {
  /** 学生姓名（服务端已经选中这一位，前端不用再选） */
  name: string;
};

/**
 * 「📝 补录一次成绩」（2026-10 第十四批）
 *
 * 干什么：老师**在别的地方**考的试（学校/别家机构）也想记进档案 ——
 * 那些成绩同样有参考价值，而且学情分析的趋势要一起看。
 *
 * ⚠️ 走的是**已有的统一接口** `/api/students`（`op:"manual"`），校验在
 *    `src/lib/manual-score.ts`（纯函数，服务端与测试共用一份）。
 *    这里**只负责界面**：不自己拼数据库字段、不自己算得分率。
 *
 * ⚠️ 保存成功后 `router.refresh()`：记录列表、本页顶部的条数、学情分析的
 *    「成绩趋势」都在**服务端**渲染（`getHistoryFresh()` 直读，不走 25 秒缓存），
 *    所以刷新一下就能看到 —— 不刷新的话老师会以为"没保存上"。
 *
 * ⚠️ 满分是**必填**（服务端也会拒）：没有满分就算不出得分率，
 *    `student-report.ts` 会把这种记录排除在趋势之外，老师会觉得"填了没用"。
 */
export default function ManualScoreForm({ name }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    // 地址与请求体形状从 `manualScoreHooks()` 取（唯一来源，测试也用它）
    const hook = manualScoreHooks().create(name, {
      title: String(fd.get("title") ?? ""),
      date: String(fd.get("date") ?? ""),
      score: String(fd.get("score") ?? ""),
      full_score: String(fd.get("full_score") ?? ""),
      type_name: String(fd.get("type_name") ?? ""),
      note: String(fd.get("note") ?? ""),
    });

    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(hook.url, {
        method: hook.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hook.body),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (r.ok && j?.ok) {
        setMsg({ kind: "ok", text: "已补录一条成绩，下面的记录与学情分析已更新。" });
        form.reset();
        router.refresh();
      } else {
        setMsg({ kind: "err", text: j?.error || `保存失败（HTTP ${r.status}）` });
      }
    } catch (err) {
      setMsg({ kind: "err", text: "网络错误：" + String((err as Error)?.message ?? err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">手动补录成绩</p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            在别处考的试（学校期中、别家机构模考…）也能记进来；补录后会自动进入下面的
            「成绩趋势」和 AI 学情报告。
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); setMsg(null); }}
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 px-3.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {open ? "收起" : "📝 补录一次成绩"}
        </button>
      </div>

      {open ? (
        <form onSubmit={onSubmit} className="mt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={`${label} sm:col-span-2`}>
              <span>考试名称 *</span>
              <input name="title" required maxLength={100} placeholder="如 学校期中考试" className={field} />
            </label>
            <label className={label}>
              <span>考试日期 *</span>
              <input type="date" name="date" required defaultValue={todayLocal()} className={field} />
            </label>
            <label className={label}>
              <span>得分 *</span>
              <input type="number" name="score" required min={0} step="0.5" placeholder="如 105" className={field} />
            </label>
            <label className={label}>
              <span>满分 *（没有它算不出得分率）</span>
              <input type="number" name="full_score" required min={1} step="0.5" defaultValue={150} className={field} />
            </label>
            <label className={label}>
              <span>考试类型</span>
              <select name="type_name" defaultValue="" className={field}>
                <option value="">（不填）</option>
                {EXAM_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className={`${label} sm:col-span-3`}>
              <span>备注（可选）</span>
              <input name="note" maxLength={500} placeholder="如 不在我们这考的，卷子难度偏大" className={field} />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {saving ? "保存中…" : "保存这条成绩"}
            </button>
            {msg ? (
              <span
                role={msg.kind === "err" ? "alert" : "status"}
                className={
                  "text-xs " +
                  (msg.kind === "err"
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-600 dark:text-emerald-400")
                }
              >
                {msg.text}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}
