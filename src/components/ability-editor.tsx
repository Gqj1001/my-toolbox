"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Dim = { key: string; name: string; count: number; score: number };

export default function AbilityEditor({ name, radar }: { name: string; radar: Dim[] }) {
  const router = useRouter();
  const [scores, setScores] = useState<Record<string, number>>(
    Object.fromEntries(radar.map((d) => [d.key, d.score])),
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const auto = (d: Dim) => Math.max(40, 100 - d.count * 6);

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, extra: { abilityScores: scores } }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg(data?.error || "保存失败，请重试。");
        return;
      }
      setMsg("已保存能力值。");
      router.refresh();
    } catch {
      setMsg("保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-200">
        调整能力值（老师可改）
      </summary>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        默认 100 分起，每条失分证据扣 6 分，最低 40；你可以在下面按学生实际情况微调，保存后会覆盖自动值。
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {radar.map((d) => (
          <label key={d.key} className="flex items-center justify-between gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <span>{d.name}</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                value={scores[d.key] ?? d.score}
                onChange={(e) => setScores((s) => ({ ...s, [d.key]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                className="h-8 w-16 rounded-lg border border-zinc-300 bg-white px-2 text-right text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => setScores((s) => ({ ...s, [d.key]: auto(d) }))}
                className="text-xs text-zinc-400 underline hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                自动
              </button>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="h-9 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "保存中…" : "保存能力值"}
        </button>
        {msg ? <span className="text-xs text-zinc-500">{msg}</span> : null}
      </div>
    </details>
  );
}
