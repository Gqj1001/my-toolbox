import Link from "next/link";
import ResetPasswordForm from "@/components/reset-password-form";
import { createClient } from "@/lib/supabase/server";

/**
 * 「设置新密码」（重置邮件点进来之后的那一页）。
 *
 * ⚠️ 走到这里的人**一定已经有会话**了 —— 是 `/auth/confirm` 用邮件里的 token
 *    换出来的。所以这一页**不需要**放在 PUBLIC_PATHS 里：没会话的人被中间件弹回登录页
 *    才是对的（他本来就不该能直接打开这个页面）。
 *
 * ⚠️ 页面上**没有「当前密码」这一栏**：刚忘记密码的人填不出旧密码。
 *    表单里带一个 `reset=1` 的隐藏字段，服务端据此跳过验旧密码
 *    （见 `src/app/auth/password-actions.ts` 里 `isResetFlow` 的说明）。
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            设置新密码
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {data.user?.email ? `账号：${data.user.email}` : "请输入新密码。"}
            <br />
            设置成功后，用新密码重新登录即可。
          </p>
        </div>

        <ResetPasswordForm />

        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/login" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            返回登录
          </Link>
        </p>
      </div>
    </main>
  );
}
