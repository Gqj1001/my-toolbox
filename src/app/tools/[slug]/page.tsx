import ToolPageShell from "@/components/tool-page-shell";

type PageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * 工具动态路由。
 *
 * 工具的权限与内容统一由 ToolPageShell 处理，这里只负责把 slug 还原成
 * tools 表中的 route。注意：Next 会优先匹配更具体的静态路由，
 * 因此 src/app/tools/math-plan/page.tsx 这类显式页面仍然优先生效。
 */
export default async function ToolPage({ params }: PageProps) {
  const { slug } = await params;
  return <ToolPageShell route={`/tools/${slug}`} />;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  return { title: `${slug} | My Toolbox` };
}
