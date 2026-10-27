"use client";

export default function PrintPdfButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 px-3.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      📥 下载 PDF 报告
    </button>
  );
}
