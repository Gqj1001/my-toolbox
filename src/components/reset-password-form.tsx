"use client";

import { useActionState } from "react";
import { changePassword, type PasswordFormState } from "@/app/auth/password-actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

const initialState: PasswordFormState = { status: "idle" };

const input =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100 dark:focus:ring-zinc-100/10";
const label = "text-sm font-medium text-zinc-700 dark:text-zinc-300";

/**
 * 「设置新密码」表单（**重置邮件点进来之后**用的，没有"当前密码"这一栏）。
 *
 * ⚠️ 复用 `changePassword` 这个服务端动作是**有意**的：
 *    重置流程走到这里时用户**已经有一个由邮件链接换出来的会话**，
 *    所以"已登录 + 改密码"这套逻辑完全一样。
 *    ⚠️ 但**页面会通过一个隐藏字段告诉它"这是重置流程"**，服务端据此**跳过"当前密码"校验** ——
 *    否则刚忘记密码的人会被要求填一个他正想不起来的旧密码（那就死锁了）。
 */
export default function ResetPasswordForm() {
  const [state, formAction, isPending] = useActionState(changePassword, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* 重置流程标记：服务端看到它就**不**验当前密码（见 password-actions.ts） */}
      <input type="hidden" name="reset" value="1" />

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className={label}>
          新密码
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          placeholder={`至少 ${MIN_PASSWORD_LENGTH} 个字符`}
          className={input}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="confirmPassword" className={label}>
          再输一遍新密码
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className={input}
        />
      </div>

      {state.status === "error" && state.message ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {state.message}
        </p>
      ) : null}

      {state.status === "success" && state.message ? (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="mt-2 inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {isPending ? "保存中…" : "设置新密码"}
      </button>
    </form>
  );
}
