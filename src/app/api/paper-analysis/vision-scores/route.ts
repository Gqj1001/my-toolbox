import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import { getViewer } from "@/lib/viewer";
import { readContent, reasoningLength, truncatedByReasoning } from "@/lib/deepseek-thinking";

/**
 * 试卷分析：拍照识别答题卡得分（视觉模型，可选功能）
 *
 * ✅ **2026-10 更新：DeepSeek 已经支持图片输入** —— 官方文档
 *    （https://api-docs.deepseek.com/guides/vision/）原文：
 *    "The `deepseek-flash` model accepts images alongside text, so you can ask the model
 *     to describe pictures, read text from screenshots, analyze charts, and more."
 *    （旧注释写「deepseek-chat 不支持图片输入」已经过时。）
 *
 *    也就是说：**在 Vercel 上把 `AI_VISION_MODEL` 配成 `deepseek-flash` 即可启用**，
 *    不需要第三方多模态模型；`AI_KEY` 复用同一个。
 *
 *    官方对图片输入的要求与限制（本路由已满足）：
 *      · `content` 用数组块：text + image_url（data: URL 可用）—— 本路由就是这么写的
 *      · **图片只能放在 `user` 消息里**（放 system/assistant 会 400）—— 本路由 system 只放纯文本
 *      · 单图最大 32 MiB（base64/外链）、请求体 48 MiB、每请求最多 600 张
 *        —— 本路由另有更紧的 4 MiB body 上限
 *
 * 行为：
 *   · 未配置 AI_VISION_MODEL  → ok:false + 明确提示（前端引导改用 docx / 粘贴）
 *   · 已配置                  → 走 OpenAI 兼容的 chat/completions 多模态格式
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
  // ---------- 纵深防御：确认账号未被封禁 ----------
  // requireVip() 内部走的就是 getViewer()，已经包含了 status='banned' 判定
  // （viewer.ts 一次查询同时取 role/plan/status/expires_at）。
  // 从前这里又单独 select("status") 查了一遍 —— 重复，且白付一次 Supabase 往返。
  // 现在改为复用同一个 getViewer()（同一请求内 React.cache 去重，不会多查库）。
  {
    const viewer = await getViewer();
    if (viewer.membership.status === "banned") {
      return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
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

  /**
   * ⚠️ 护栏：**只有确认是 DeepSeek 才带 `thinking` 这个专有字段**。
   *
   * 本路由与另外三个不同 —— 它在设计上就是「任意 OpenAI 兼容多模态模型」：
   * 模型名来自 `AI_VISION_MODEL`，而且**前端还能覆盖它**（见上面的 `body.model`）。
   * 给一个不认识 `thinking` 的厂商（例如某些国产视觉模型）发这个字段，可能直接 400。
   *
   * 所以：模型名含 deepseek 才带；另外留 `AI_VISION_SUPPORTS_THINKING=0` 作为
   * 「不改代码就能摘掉」的紧急开关。
   */
  const supportsThinking =
    /deepseek/i.test(model) && process.env.AI_VISION_SUPPORTS_THINKING !== "0";

  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
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
        // 6000：DeepSeek 思考模式与正文共享 max_tokens，从前 1500 很容易被吃光。
        // 本路由的输出其实只有一小段 JSON，6000 是上限、按实际用量计费，没有额外成本。
        max_tokens: 6000,
        // 关闭 DeepSeek 思考模式（默认 enabled）。官方：
        // https://api-docs.deepseek.com/guides/thinking_mode/
        ...(supportsThinking ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();

    if (!res.ok) {
      console.error("[paper-analysis/vision-scores] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ ok: false, error: "识别服务暂时不可用，请稍后重试。" }, { status: 502 });
    }

    let data = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string; reasoning_content?: string };
      }>;
      usage?: Record<string, unknown>;
    };

    // ---------- 兜底重试：思考过程吃光预算 ----------
    // 同三个文本路由（根因同源：DeepSeek 视觉模型也默认开思考）。
    // 关掉 thinking 再跑一遍，JSON 解析逻辑跟第一次完全一样（下面照旧执行）。
    let retried = false;
    if (truncatedByReasoning(data)) {
      retried = true;
      console.warn(
        "[paper-analysis/vision-scores] 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:",
        JSON.stringify({
          model,
          supportsThinking,
          reasoningLen: reasoningLength(data),
          usage: data.usage ?? null,
        }),
      );
      res = await callUpstream();
      if (res.ok) {
        data = (await res.json()) as typeof data;
      } else {
        console.error(
          "[paper-analysis/vision-scores] 重试仍失败，上游返回",
          res.status,
          (await res.text()).slice(0, 300),
        );
      }
    }

    const out = readContent(data);
    // 从返回里抠出 JSON
    let scores: Array<{ no: number; got: number }> = [];
    try {
      const m = out.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m ? m[0] : out);
      scores = Array.isArray(parsed.scores) ? parsed.scores : [];
    } catch {
      // 空响应与「返回了但解析不出来」要分开记：前者是本次修复的目标，
      // 后者是模型没按 JSON 输出，两者排查方向不同。
      console.error(
        "[paper-analysis/vision-scores] 无法解析为 JSON:",
        JSON.stringify({
          model,
          retried,
          outLen: out.length,
          finish_reason: data.choices?.[0]?.finish_reason ?? null,
          reasoningLen: reasoningLength(data),
        }),
        out.slice(0, 200),
      );
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
