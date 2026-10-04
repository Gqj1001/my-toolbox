import { NextResponse } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";

/**
 * 试卷分析工作台的「模式探测」接口
 *
 * 前端 app.js 的 detectServer() 会 GET 这个地址来判断走「云端模式」还是「本机模式」。
 * 响应刻意与老 server.js 的 /api/mode 保持同构，这样 app.js 的适配层几乎不用改。
 *
 * 关键：config.hasKey 必须是真实的——前端靠它决定 AI 请求走服务端代理
 * 还是退回浏览器里用户自己填的 Key（BYOK）。报错了会让用户误以为"服务器没配 AI"。
 *
 * 安全：只回传「有没有 Key / 模型名 / 接口域名」，**绝不回传 Key 本身**，
 *      也不回传提示词（提示词固定在服务端）。
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

export async function GET() {
  const { user, role } = await getCurrentUserWithRole();

  // 被封禁的账号不给"云端模式"，让它退回本机模式（同时前端页面本身也会被门禁拦住）
  let banned = false;
  if (user) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("user_roles")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    banned = data?.status === "banned";
  }

  return NextResponse.json(
    {
      ok: true,
      mode: "next",
      // 新版不需要访问口令：站点登录本身已经是鉴权边界
      requiresPass: false,
      isAdmin: role === "admin",
      banned,
      config: {
        hasKey: Boolean(process.env.AI_KEY),
        apiBase: (process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ""),
        model: process.env.AI_MODEL ?? DEFAULT_MODEL,
        // 未配置视觉模型时给空串 —— 前端据此禁用「拍照识别」并给出友好提示
        visionModel: process.env.AI_VISION_MODEL ?? "",
        prompt: "",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
