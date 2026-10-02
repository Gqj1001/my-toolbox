import Link from "next/link";
import { logIn } from "@/app/auth/actions";
import AuthForm from "@/components/auth-form";

function safeRedirectPath(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const redirectTo = safeRedirectPath(params.redirectTo);
  const error = typeof params.error === "string" ? params.error : undefined;

  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            登录
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            使用邮箱和密码登录你的 My Toolbox 账号。
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}

        <AuthForm
          action={logIn}
          mode="login"
          submitLabel="登录"
          pendingLabel="登录中…"
          redirectTo={redirectTo}
        />

        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          还没有账号？{" "}
          <Link href="/signup" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            立即注册
          </Link>
        </p>
      </div>
    </main>
  );
}
