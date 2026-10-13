"use client";

import { useActionState, useEffect, useState } from "react";
import { setFeatureFlag, type FlagActionResult } from "@/app/admin/feature-actions";
import type { FeatureFlagView } from "@/lib/feature-flags";

/**
 * 管理后台「功能开关」列表（客户端组件）
 * ------------------------------------------------------------------
 * 每个开关一行：名字 + 说明 + 当前状态 + 一个「关掉 / 打开」按钮 + 最后改动人。
 * ⚠️ 真正生效靠服务端（Server Action 里 requireAdmin()），这里只负责呈现与提交。
 * ⚠️ 每个开关必须**各自一份 useActionState**，否则两个开关的 pending 会互相串
 *    （与 member-actions.tsx 里 30 天/90 天按钮同一个坑）。
 */

const initialState: FlagActionResult = { status: "idle" };

const buttonBase =
  "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

function FlagRow({ flag }: { flag: FeatureFlagView }) {
  const [state, action, pending] = useActionState(setFeatureFlag, initialState);

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800"
      data-flag={flag.key}
      data-flag-enabled={flag.enabled ? "1" : "0"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{flag.label}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            flag.enabled
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          }`}
        >
          {flag.enabled ? "已开启" : "已关闭"}
        </span>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">{flag.key}</span>
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">{flag.note}</p>

      <div className="flex flex-wrap items-center gap-3">
        <form action={action}>
          <input type="hidden" name="key" value={flag.key} />
          {/* 提交的是"目标状态"：当前开着 → 点一下就是关掉 */}
          <input type="hidden" name="enabled" value={flag.enabled ? "0" : "1"} />
          <button
            type="submit"
            disabled={pending}
            className={`${buttonBase} ${
              flag.enabled
                ? "border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                : "border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
            }`}
          >
            {pending ? "处理中…" : flag.enabled ? "关掉这个功能" : "打开这个功能"}
          </button>
        </form>

        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          {flag.updatedAt
            ? `最后改动：${flag.updatedAt.slice(0, 16).replace("T", " ")}${flag.updatedBy ? ` · ${flag.updatedBy}` : ""}`
            : "还没有改过"}
        </span>

        {state.status !== "idle" ? (
          <span
            role="status"
            className={`text-xs ${
              state.status === "success"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {state.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function FeatureFlagList({
  flags,
  ready,
  error,
}: {
  flags: FeatureFlagView[];
  ready: boolean;
  error: string | null;
}) {
  // 提示 8 秒后自动收起（与 member-actions 的 5 秒同一个做法，这里给迁移提示长一点）
  const [showNotice, setShowNotice] = useState(!ready);
  useEffect(() => {
    if (ready) return;
    setShowNotice(true);
    const timer = setTimeout(() => setShowNotice(false), 8000);
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <div className="flex flex-col gap-3" data-flags-ready={ready ? "1" : "0"}>
      {!ready && showNotice ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-medium">功能开关表还没建 —— 现在所有功能都保持开启</p>
          <p className="mt-1 text-xs">{error}</p>
        </div>
      ) : null}

      {flags.map((flag) => (
        <FlagRow key={flag.key} flag={flag} />
      ))}
    </div>
  );
}
