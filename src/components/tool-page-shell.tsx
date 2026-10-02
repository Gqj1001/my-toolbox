import { notFound } from "next/navigation";
import ToolPlaceholder from "@/components/tool-placeholder";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { canAccessHref, getToolBySlug } from "@/lib/tools";

type ToolPageShellProps = {
  slug: string;
};

/** 工具页公共外壳：读取当前用户、校验访问权限、渲染占位内容 */
export default async function ToolPageShell({ slug }: ToolPageShellProps) {
  const tool = getToolBySlug(slug);
  if (!tool) notFound();

  const { user, role } = await getCurrentUserWithRole();
  const authorized = canAccessHref(role, tool.href);

  return (
    <ToolPlaceholder
      tool={tool}
      email={user?.email ?? null}
      role={role ?? "user"}
      authorized={authorized}
    />
  );
}
