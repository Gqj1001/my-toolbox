import FeedbackSkeleton from "@/components/feedback-skeleton";

/**
 * `/tools/feedback` 的加载态。
 *
 * 为什么需要它：`tools/loading.tsx` **不会**套用到这条动态子路由，
 * 所以在服务端把页面壳（含 `getViewer()` / `getToolByRoute()` 两次库查询）渲染出来之前，
 * 浏览器看到的是**整屏空白**。这个文件把那段白屏盖住。
 *
 * ⚠️ 这里必须是纯静态内容：不能查库、不能读 cookie。
 *    所以顶栏的邮箱/身份用占位值（`email={null}`），不显示具体账号 ——
 *    骨架屏只负责「看起来有东西」，不负责真实数据。
 */
export default function Loading() {
  return <FeedbackSkeleton />;
}
