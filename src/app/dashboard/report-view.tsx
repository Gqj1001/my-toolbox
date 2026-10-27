import { parseMarkdownTables, stripReportMarkup } from "@/lib/markdown-tables";

/** 把 AI 报告里的 Markdown 表格渲染成规整表格；其余文本保持换行。 */
export default function ReportView({ text }: { text: string }) {
  const blocks = parseMarkdownTables(stripReportMarkup(text));
  return (
    <div className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-zinc-50 px-3 py-2.5 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
      {blocks.map((b, i) =>
        b.type === "table" ? (
          <div key={i} className="my-3 overflow-x-auto">
            <table className="w-full min-w-[28rem] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-300 dark:border-zinc-700">
                  {b.headers.map((h, j) => (
                    <th key={j} className="px-2 py-1.5 font-medium text-zinc-600 dark:text-zinc-300">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri} className="border-b border-zinc-200 last:border-0 dark:border-zinc-800/70">
                    {row.map((c, ci) => (
                      <td key={ci} className="px-2 py-1.5 text-zinc-700 dark:text-zinc-200">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words">
            {b.text}
          </p>
        ),
      )}
    </div>
  );
}
