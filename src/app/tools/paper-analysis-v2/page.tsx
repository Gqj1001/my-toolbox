import ToolPageShell from "@/components/tool-page-shell";

export const metadata = {
  title: "全学科试卷分析工作台 | My Toolbox",
};

/**
 * 全学科试卷分析（v2）。
 *
 * ⚠️ 老数学版 `/tools/paper-analysis` **一个字节都没动**（只把纯逻辑脚本的
 *    引用路径改到 `js/core/`）；本工具是新的界面壳，底层解析/算分/导出
 *    都复用 `public/tools/paper-analysis/js/core/`。
 */
export default function PaperAnalysisV2Page() {
  return <ToolPageShell route="/tools/paper-analysis-v2" />;
}
