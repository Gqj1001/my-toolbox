/**
 * 工具列表骨架屏。
 *
 * 与 src/app/tools/page.tsx 的布局对齐（同样的 max-w-5xl / gap-6），
 * 纯占位、无业务逻辑。加它的原因见 dashboard/loading.tsx 的说明。
 */
export default function ToolsLoading() {
  return (
    <>
      {/* 顶栏占位：高度对齐 SiteHeader */}
      <div className="h-[57px] border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <div className="flex flex-col gap-2">
          <div className="h-8 w-32 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-5 w-64 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/60" />
        </div>

        {/* 工具卡片网格：与 ToolGrid 的栅格一致 */}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <li
              key={i}
              className="flex h-40 flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
            >
              <div className="h-11 w-11 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
              <div className="h-4 w-32 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-3 w-full animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/60" />
              <div className="mt-auto h-4 w-24 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/60" />
            </li>
          ))}
        </ul>

        <span className="sr-only">正在加载工具列表…</span>
      </main>
    </>
  );
}
