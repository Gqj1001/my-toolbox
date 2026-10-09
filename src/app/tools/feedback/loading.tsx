import FeedbackSkeleton from "@/components/feedback-skeleton";

/**
 * `/tools/feedback` 的加载态。
 *
 * 为什么需要它：`tools/loading.tsx` **不会**套用到这条动态子路由，
 * 所以在服务端把页面壳（含 `getViewer()` / `getToolByRoute()` 两次库查询）渲染出来之前，
 * 浏览器看到的是**整屏空白**。这个文件把那段白屏盖住。
 *
 * ⚠️ 这里必须是纯静态内容：不能查库、不能读 cookie。
 *
 * ⚠️ 顶栏只放一个**灰条占位**，**不要**在这里（或骨架里）渲染真的 `SiteHeader`
 *    （2026-10 修的一处 bug）。原因：流式渲染会把 `loading` 与页面**都**放进首屏 HTML
 *    （各自包在 `<div hidden id="S:N">` 里，靠 JS 水合后移除），
 *    所以只要水合被拖慢，就会出现**两条导航栏** —— 一条真实的、一条占位的
 *    （占位那条 `email=null` / `role="user"`，看起来像「另一个账号」）。
 *    灰条占位与 `dashboard/loading.tsx`、`tools/loading.tsx` 的做法一致。
 */
export default function Loading() {
  return (
    <>
      {/* 顶栏占位：高度对齐 SiteHeader，避免内容上下跳 */}
      <div className="h-[57px] border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
      <FeedbackSkeleton />
    </>
  );
}
