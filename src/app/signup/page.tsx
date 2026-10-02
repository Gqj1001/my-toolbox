import Link from "next/link";
import { signUp } from "@/app/auth/actions";
import AuthForm from "@/components/auth-form";

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            注册
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            创建一个账号，开始使用 My Toolbox。
          </p>
        </div>

        <AuthForm action={signUp} mode="signup" submitLabel="注册" pendingLabel="注册中…" />

        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          已经有账号了？{" "}
          <Link href="/login" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            去登录
          </Link>
        </p>
      </div>
    </main>
  );
}
