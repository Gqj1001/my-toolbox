import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { requireVip } from "@/lib/membership";
import { createClient } from "@/lib/supabase/server";

/**
 * 试卷分析：拍照识别答题卡得分（视觉模型，可选功能）
 *
 * 当前**未启用**：DeepSeek 的 deepseek-chat 不支持图片输入，需要一个多模态模型。
 * 因此本路由的行为是：
 *   · 未配置 AI_VISION_MODEL  → 返回 ok:false + 明确提示（前端会引导改用 docx / 粘贴）
 *   · 已配置                  → 走 OpenAI 兼容的 chat/completions 多模态格式
 *
 * 也就是说：路由结构已经完整，以后在 Vercel 上配好
 *   AI_VISION_MODEL（如某个支持视觉的模型名）
 *   AI_VISION_BASE_URL / 可复用 AI_BASE_URL
 *   AI_KEY
 * 就自动可用，不需要改代码。
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";

const VISION_PROMPT =
  "你是一位细心的老师，正在批改一张高中数学答题卡的扫描件/照片。\n" +
  "用户会给你这张图片，以及这份试卷的题目清单（题号、题型、满分）。\n" +
  "请识别每道题的得分（写在题目旁边或答题框上的分数、扣分标记）。\n" +
  "要求：\n" +
  "1. 只返回你能明确看清分数的题目，看不清的不要猜，直接省略；\n" +
  "2. 得分不能超过该题满分，不能小于 0；\n" +
  '3. 如果看到"×"或整题空白，按 0 分处理；\n' +
  '4. 严格只输出 JSON，不要任何解释文字，格式：{"scores":[{"no":1,"got":5},{"no":3,"got":0}]}';

const MAX_BODY = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export async function POST(request: NextRequest) {
  // ---------- 鉴权：与 AI 建议一致（会员专属）----------
  const guard = await requireVip();
  if (!guard.ok) {
    if (guard.reason === "unauthenticated") {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }
    if (guard.reason === "banned") {
      return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, error: "答题卡识别为会员专属功能，请先开通会员。" },
      { status: 403 },
    );
  }
  {
    // requireVip 已保证是有效会员；这里再确认账号未被封禁（纵深防御）
    const { user } = await getCurrentUserWithRole();
    if (user) {
      const supabase = await createClient();
      const { data } = await supabase
        .from("user_roles")
        .select("status")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data?.status === "banned") {
        return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
      }
    }
  }

  // ---------- 未启用视觉模型：明确告知 ----------
  const visionModel = process.env.AI_VISION_MODEL;
  const apiKey = process.env.AI_KEY;
  if (!apiKey || !visionModel) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "云端版未启用答题卡识别（需要额外的多模态模型）。" +
          "请改用 .docx 上传，或把分数直接填进题目列表。",
      },
      { status: 503 },
    );
  }

  // ---------- 入参 ----------
  const lenHeader = Number(request.headers.get("content-length") ?? 0);
  if (lenHeader > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "图片太大，请压缩后重试。" }, { status: 413 });
  }

  let body: { image?: unknown; questions?: unknown; model?: unknown };
  try {
    body = (await request.json()) as { image?: unknown; questions?: unknown; model?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const img = String(body.image ?? "");
  if (!img.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "图片格式不正确。" }, { status: 400 });
  }
  const list = Array.isArray(body.questions) ? body.questions.slice(0, 60) : [];
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : visionModel;

  const baseUrl = (process.env.AI_VISION_BASE_URL ?? process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");

  // ---------- 调用上游（OpenAI 兼容的多模态格式）----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: VISION_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "这是试卷的题目清单：\n" + JSON.stringify(list) + "\n\n请识别图片中每道题的得分，只返回 JSON。",
              },
              { type: "image_url", image_url: { url: img } },
            ],
          },
        ],
        max_tokens: 1500,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error("[paper-analysis/vision-scores] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ ok: false, error: "识别服务暂时不可用，请稍后重试。" }, { status: 502 });
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = data.choices?.[0]?.message?.content ?? "";

    // 从返回里抠出 JSON
    let scores: Array<{ no: number; got: number }> = [];
    try {
      const m = out.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m ? m[0] : out);
      scores = Array.isArray(parsed.scores) ? parsed.scores : [];
    } catch {
      console.error("[paper-analysis/vision-scores] 无法解析为 JSON:", out.slice(0, 200));
    }

    return NextResponse.json({
      ok: true,
      scores,
      raw: scores.length ? undefined : out.slice(0, 400),
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[paper-analysis/vision-scores] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "识别超时，请重试。" : "识别服务暂时不可用。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
