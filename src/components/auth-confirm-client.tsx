"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  authCallbackMessage,
  hasSessionPayload,
  parseAuthCallback,
  type AuthCallbackParams,
} from "@/lib/auth-callback";

/**
 * 邮件链接的客户端回调（2026-10 第十六批，**替换掉原来那个服务端路由**）
 *
 * 为什么必须是客户端：
 *   Supabase 现在把会话放在跳转地址的 `#` 片段里
 *   （`…/auth/confirm?next=/reset-password#access_token=…`），而 **`#` 永远不会发给服务器**。
 *   原来那个 `route.ts` 只能读 `?token_hash=`，于是**什么都读不到 → 一律跳登录页**
 *   ⇒ 老师点重置链接看到登录界面、没法重置密码（本轮修的 bug 就出在这里）。
 *
 * ⚠️ 会话**必须**由浏览器端 Supabase client 落成 Cookie（`@supabase/ssr` 的
 *    `createBrowserClient` 就是 cookie 存储），否则中间件与页面侧看不到会话，
 *    跳过去还是登录页。**不要**把会话只放进 localStorage。
 *
 * 四条路都认（按优先级）：片段里的会话 → `?code=`（PKCE）→ `?token_hash=&type=`（旧式）→ 报错。
 */
export default function AuthConfirmClient() {
  const [text, setText] = useState("正在验证，请稍候…");
  const [ok, setOk] = useState(true);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;   // React 严格模式会跑两次，别把一次性 token 用掉两遍
    started.current = true;

    const p: AuthCallbackParams = parseAuthCallback(window.location.href, window.location.hash);
    const verdict = authCallbackMessage(p);

    const fail = (msg: string) => {
      setOk(false);
      setText(msg);
      // ⚠️ 失败**必须**给出口：否则老师停在一个"什么都没有"的页面上，不知道下一步做什么。
      const target = `/login?error=${encodeURIComponent(msg)}`;
      setTimeout(() => { window.location.replace(target); }, 1500);
    };

    if (!verdict.ok) { fail(verdict.text); return; }
    if (!hasSessionPayload(p)) { fail(verdict.text); return; }

    const supabase = createClient();

    (async () => {
      try {
        if (p.accessToken && p.refreshToken) {
          // 新版邮件链接：会话直接放在片段里
          const { error } = await supabase.auth.setSession({
            access_token: p.accessToken,
            refresh_token: p.refreshToken,
          });
          if (error) return fail("会话未能建立，请重新申请一封重置邮件。");
        } else if (p.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(p.code);
          if (error) return fail("链接已失效或已使用过，请重新申请一封重置邮件。");
        } else if (p.tokenHash && p.type) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: p.tokenHash,
            type: p.type as "recovery" | "signup" | "email" | "email_change" | "invite" | "magiclink",
          });
          if (error) return fail("链接已失效或已使用过，请重新申请一封重置邮件。");
        }

        // 兜底核对：确实拿到会话再往下一步走（避免"以为成功、跳过去又被弹回登录页"）
        const { data } = await supabase.auth.getUser();
        if (!data.user) return fail("会话未能建立，请重新申请一封重置邮件。");

        setText("验证成功，正在跳转…");
        window.location.replace(p.next);
      } catch (e) {
        fail("验证时出错：" + String((e as Error)?.message ?? e).slice(0, 80));
      }
    })();
  }, []);

  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {ok ? "正在验证邮件链接" : "这个链接不能用"}
        </h1>
        <p
          role={ok ? "status" : "alert"}
          className={
            "mt-3 text-sm " +
            (ok ? "text-zinc-500 dark:text-zinc-400" : "text-red-600 dark:text-red-400")
          }
        >
          {text}
        </p>
      </div>
    </main>
  );
}
