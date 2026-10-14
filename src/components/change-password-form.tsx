"use client";

import { useActionState } from "react";
import { changePassword, type PasswordFormState } from "@/app/auth/password-actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

const initialState: PasswordFormState = { status: "idle" };

const input =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100 dark:focus:ring-zinc-100/10";
const label = "text-sm font-medium text-zinc-700 dark:text-zinc-300";

/**
 * 「修改密码」表单（登录后可用）。
 *
 * ⚠️ 三个框都要填：**先验当前密码**再改（服务端做，见 `password-actions.ts` 的说明）——
 *    老师常在公共电脑上登录着，只靠会话的话，摸到那台电脑的人就能把密码改掉。
 * ⚠️ 长度规则来自 `@/lib/password-policy`（与注册页一致，**不要在这里另写一个数字**）。
 */
export default function ChangePasswordForm() {
  const [state, formAction, isPending] = useActionState(changePassword, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="oldPassword" className={label}>
          当前密码
        </label>
        <input
          id="oldPassword"
          name="oldPassword"
          type="password"
          required
          autoComplete="current-password"
          className={input}
        />
      </div>

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
        {isPending ? "保存中…" : "修改密码"}
      </button>
    </form>
  );
}
