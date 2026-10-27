"use client";

import { useRef, useState } from "react";

type Report = {
  ok?: boolean;
  total?: number;
  success?: number;
  failed?: number;
  errors?: { row: number; name: string; reason: string }[];
  error?: string;
};

export default function BatchImportPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setReport({ error: "请先选择文件。" });
      return;
    }
    setBusy(true);
    setReport(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import/students", { method: "POST", body: fd });
      const data = (await res.json().catch(() => null)) as Report | null;
      setReport(data ?? { error: "服务器没有返回结果。" });
    } catch {
      setReport({ error: "上传失败，请重试。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">批量导入学生档案</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        支持 .xlsx / .csv；第一行必须是表头。导入后自动关联到当前账号，存入学生档案。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href="/api/import/template"
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          ⬇ 下载标准模板
        </a>
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.csv"
            className="text-sm text-zinc-600 file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
          />
          <button
            type="submit"
            disabled={busy}
            className="h-9 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? "导入中…" : "开始导入"}
          </button>
        </form>
      </div>

      {report ? (
        <div className="mt-4 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          {"error" in report && report.error ? (
            <p className="text-red-600 dark:text-red-400">{report.error}</p>
          ) : (
            <>
              <p className="font-medium text-zinc-800 dark:text-zinc-100">
                共 {report.total ?? 0} 行：成功 {report.success ?? 0}，失败 {report.failed ?? 0}
              </p>
              {report.errors?.length ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-red-600 dark:text-red-400">
                  {report.errors.map((e) => (
                    <li key={`${e.row}-${e.name}`}>第 {e.row} 行{e.name ? `（${e.name}）` : ""}：{e.reason}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
