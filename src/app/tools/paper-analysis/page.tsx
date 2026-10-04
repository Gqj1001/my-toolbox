import ToolPageShell from "@/components/tool-page-shell";

export const metadata = {
  title: "试卷分析工作台 | My Toolbox",
};

/**
 * 试卷分析工作台。
 *
 * 工具本体是 public/tools/paper-analysis/（多文件结构：
 * index.html + css/ + js/ + templates/），用 iframe 承载目录入口 index.html。
 * 该工具在数据库 tools 表中的 min_plan = 'free'，因此所有登录用户可进入：
 *   - 未登录 → /login
 *   - 被封禁 → /banned
 * 这些判定统一由 ToolPageShell 处理（含 resolveIframeSrc 对目录入口的支持）。
 *
 * 运行模式（app.js 内判定）：
 *   · 挂在 /tools/paper-analysis 下（HTTP）→ 「云端模式」
 *       文件解析走 /api/paper-analysis/parse-file
 *       AI 建议段走 /api/paper-analysis/ai-advice（VIP 专属，服务端持有 Key）
 *       数据仍存 localStorage（Supabase 迁移留待后续）
 *   · 直接双击 HTML（file://）→ 「本机模式」，行为与原来完全一致
 */
export default function PaperAnalysisPage() {
  return <ToolPageShell route="/tools/paper-analysis" />;
}
