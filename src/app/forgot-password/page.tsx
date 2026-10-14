import Link from "next/link";
import ForgotPasswordForm from "@/components/forgot-password-form";

/**
 * 「忘记密码」（公开页，不需要登录）。
 *
 * 流程：填邮箱 → 服务端让 Supabase 发一封重置邮件 → 邮件里的链接回到
 * `/auth/confirm?type=recovery` （换出会话）→ 跳到 `/reset-password` 设新密码。
 *
 * ⚠️ 这个页面必须在 `src/proxy.ts` 的 `PUBLIC_PATHS` 里：忘了密码的人**恰恰是登不进来的人**，
 *    否则会被中间件弹回登录页，形成死循环。
 */
export default function ForgotPasswordPage() {
  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            忘记密码
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            填上注册时用的邮箱，我们会发一条重置链接给你。点开链接就能设置新密码。
          </p>
        </div>

        <ForgotPasswordForm />

        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          想起来了？{" "}
          <Link href="/login" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            返回登录
          </Link>
        </p>
      </div>
    </main>
  );
}
