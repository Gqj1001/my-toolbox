/**
 * 百宝箱骨架屏。
 *
 * 存在的意义：这些页面要在服务端等好几次数据库往返，没有 loading.tsx 时整页
 * 必须等完才吐第一个字节（白屏）。有了它，切换/预取时先把壳和灰块画出来。
 *
 * 布局刻意与 src/app/dashboard/page.tsx 对齐（同样的 max-w-5xl / gap / 圆角），
 * 避免数据到达时元素跳位。纯占位，不含任何业务逻辑。
 */
export default function DashboardLoading() {
  return (
    <>
      {/* 顶栏占位：高度对齐 SiteHeader，避免内容上下跳 */}
      <div className="h-[57px] border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 overflow-y-auto px-6 py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="h-8 w-28 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-5 w-52 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/60" />
          </div>
          <div className="h-9 w-20 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="h-7 w-20 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800/60" />
          <div className="h-7 w-32 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800/60" />
        </div>

        {/* 工具卡片网格：3 列 × 4 张，与 ToolGrid 的栅格一致 */}
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

        <span className="sr-only">正在加载工具清单…</span>
      </main>
    </>
  );
}
