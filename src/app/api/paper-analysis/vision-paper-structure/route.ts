import { NextResponse, type NextRequest } from "next/server";
import { callVisionModel, visionAuthGuard } from "@/lib/vision-call";

/**
 * 试卷分析：**图片/试卷照片 → 题目结构**（不是抄文字，是"看懂这张卷子"）
 *
 * 与隔壁 `vision-paper` 的分工（两者**别混**）：
 *   · `vision-paper`           —— 学科网**报告**截图 → **逐字抄成文字** → 喂给现有的报告解析器；
 *   · `vision-paper-structure` —— **学校卷子**（空白卷/批改卷）→ **直接产出题目结构 JSON**
 *                                 （题型分块 + 逐题知识点 + 卷面印着的分值 + 批改卷的得分）。
 * 这条路由存在的理由（用户 2026-10 实测反馈）：学校卷子没有学科网那套
 * 「整体难度／细目表分析」段落，走报告解析器只会得到"没有解析到题目"。
 *
 * 鉴权与模型调用都走 `@/lib/vision-call`（**免费口径只有一份**：登录 + 未封禁）。
 *
 * 两种模式（同一个路由，避免"同一件事两个来源"）：
 *   · 默认（结构识别）：`{ image, page, totalPages }` → `{ ok, page, empty, structure }`
 *   · `{ mode:"difficulty", questions }`（**点了按钮才走**）→ `{ ok, difficulties:[{no,level}] }`
 *     ⚠️ 这是纯文本任务（不发图），但仍走同一个免费口径与护栏。
 *
 * ⚠️ 这条路由**只负责"看懂并给出结构"**，不做计算、不建 paper 对象：
 *    分值分配、知识点归类（KnowledgeClassifier）、逐题得分表都在前端用**现有机制**做。
 */

/** 与另两条视觉路由同口径：Vercel 请求体上限约 4.5MB，按 4MB 兜住 */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TOKENS = 6000;
/** 一次最多认多少道题（防模型返回一个超长 JSON；正常一份卷子 20–30 题） */
const MAX_QUESTIONS = 120;
/** 难度只能取这四档 —— 与 `paper-parser.js` 的 `DIFF_LEVELS` **同一套词**（报告里的标签就这几个） */
const DIFF_LEVELS = ["较易", "中等", "较难", "难"];

const STRUCTURE_PROMPT =
  "你是一位资深高中数学老师，正在**看懂一张试卷的照片/扫描件**，并把它整理成结构化数据，供程序使用。\n" +
  "用户会给你这张图（可能是**空白卷**，也可能是**批改过的卷子**；可能是整张卷子的一页）。\n" +
  "【只输出 JSON】不要输出任何解释文字、不要用 markdown 代码块包裹。JSON 结构如下：\n" +
  "{\n" +
  '  "title": "卷子上印的标题，例如 2026学年第一学期期中考试 高三数学（看不清就空字符串）",\n' +
  '  "totalScore": 150,            // 卷首写明的满分；没写就 null\n' +
  '  "blocks": [ { "type": "单选题", "count": 8, "perScore": 5 } ],   // 题型分块；perScore 是"每小题分值"，卷面没写就 null\n' +
  '  "questions": [ { "no": 1, "type": "单选题", "knowledge": ["集合的交集运算"], "score": 5, "got": null, "uncertain": false } ],\n' +
  '  "uncertainNotes": ["第 18 题第二问文字被裁掉"]\n' +
  "}\n" +
  "【硬性规则】\n" +
  "1. **type 只能取这五个之一**：单选题 / 多选题 / 填空题 / 判断题 / 解答题。" +
  "实在判断不出用「其他」。**不要**写「选择题」这类别名（程序只认这五个）。\n" +
  "2. **逐题都要列**（只要图上能看到这道题），题号用**卷面上印的编号**；小题（(1)(2)）不拆开，合并在同一题里。\n" +
  "3. `knowledge`：用**常见教材措辞**写这道题考的知识点，**每题 1–3 个**（如「导数与单调性」「椭圆的标准方程」）。" +
  "看不出考什么就少写或留空数组，**不要编**。\n" +
  "4. `score`：**卷面上印了分值才填**（例如题号后写「(5分)」或题头写「每小题5分」→ 每题都填那个值）。" +
  "卷面没印就填 **null**，**绝对不要自己猜一个数字填进去**（前端会按题型惯例补，并标成待核对）。\n" +
  "5. `got`：**只有卷面上有批改/得分痕迹时才填**（学生卷）。没批改就填 null。看不清就 null 并把该题 uncertain 设为 true。\n" +
  "6. `uncertain`：这道题有看不清、被裁切、遮挡、字迹难辨的地方 → true，并把情况写进 uncertainNotes。\n" +
  "7. 只报**你在这张图里能看到**的题：这是第几页由用户告诉你，**不要猜别的页上有什么**。\n" +
  "8. 卷子上的说明文字（考试时间、注意事项、分数栏）不要当成题目。";

/**
 * 「让 AI 估每题难度」的提示词（★ 用户要求：**点了才走**，默认不估）。
 * ⚠️ 估出来的难度**会影响报告里的提分策略文案**，所以返回值一律标注「AI 估计」，且可改。
 */
const DIFFICULTY_PROMPT =
  "你是一位资深高中数学老师。用户会给你一份试卷的**题目清单**（题号、题型、知识点），" +
  "请你**估计每道题的难度**。\n" +
  "判断依据（按重要性）：知识点本身的难度层次、题型（解答题通常比选择题难）、" +
  "该知识点在高考中的常见考法（基础题/中档题/压轴题）。\n" +
  "【只输出 JSON】不要解释、不要 markdown 代码块，格式：\n" +
  '{"difficulties":[{"no":1,"level":"中等"}]}\n' +
  "【硬性规则】\n" +
  "1. `level` **只能取这四个之一**：较易 / 中等 / 较难 / 难（与试卷分析报告的难度标签一致）。\n" +
  "2. **每道题都要给**一个 level，题号必须与用户给的清单**完全对应**，不要新增或漏掉。\n" +
  "3. 拿不准就给「中等」——**不要**为了显得专业而把大多数题都标成「难」。\n" +
  "4. 这是**估计**，不是测量：不要输出任何解释或置信度。";

export async function POST(request: NextRequest) {
  // ---------- 1. 鉴权：**免费口径**（见 vision-call 的说明，别改成 requireVip） ----------
  const guard = await visionAuthGuard();
  if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });

  // ---------- 2. 入参 ----------
  const lenHeader = Number(request.headers.get("content-length") ?? 0);
  if (lenHeader > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "图片太大，请压缩后重试。" }, { status: 413 });
  }

  let body: { image?: unknown; page?: unknown; totalPages?: unknown; mode?: unknown; questions?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  // ---------- 2b. 「让 AI 估每题难度」：**文本任务、没有图**，走同一个免费口径与护栏 ----------
  if (body.mode === "difficulty") {
    const list = Array.isArray(body.questions) ? (body.questions as Record<string, unknown>[]) : null;
    if (!list || !list.length) {
      return NextResponse.json({ ok: false, error: "缺少题目清单（questions）。" }, { status: 400 });
    }
    if (list.length > MAX_QUESTIONS) {
      return NextResponse.json({ ok: false, error: `一次最多估 ${MAX_QUESTIONS} 道题。` }, { status: 413 });
    }
    const brief = list.map((q) => ({
      no: Number.isFinite(Number(q.no)) ? Number(q.no) : q.no,
      type: normalizeType(q.type),
      knowledge: Array.isArray(q.knowledge) ? q.knowledge.map((k) => String(k)).slice(0, 5) : [],
    }));
    const r = await callVisionModel({
      label: "[paper-analysis/vision-paper-structure/difficulty]",
      system: DIFFICULTY_PROMPT,
      images: [],
      userText: JSON.stringify({ questions: brief }),
      maxTokens: 2000,
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

    const parsedDiff = parseJsonObject(r.text);
    const raw = parsedDiff ? (parsedDiff.difficulties as unknown) : null;
    const difficulties = (Array.isArray(raw) ? raw : [])
      .map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        const level = String(o.level ?? "").trim();
        return { no: Number(o.no), level: DIFF_LEVELS.includes(level) ? level : "" };
      })
      .filter((x) => Number.isFinite(x.no) && x.level);
    return NextResponse.json({
      ok: true,
      mode: "difficulty",
      difficulties,
      // ⚠️ 估不出来不是 5xx：前端会提示"AI 没给出可用难度"，不影响已识别的结构
      note: difficulties.length ? "" : "AI 没给出可用的难度，请手工填写。",
      raw: difficulties.length ? undefined : r.text.slice(0, 1000),
    });
  }

  // ---------- 3. 图片入参（结构识别） ----------
  const img = String(body.image ?? "");
  if (!img.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "图片格式不正确。" }, { status: 400 });
  }
  if (img.length > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "图片太大，请压缩后重试。" }, { status: 413 });
  }
  const page = Math.max(1, Math.floor(Number(body.page) || 1));
  const totalPages = Math.max(1, Math.floor(Number(body.totalPages) || 1));

  // ---------- 4. 调视觉模型 ----------
  const userText =
    `这是试卷的第 ${page} 页（共 ${totalPages} 页）。` +
    "请按约定输出 JSON：题型分块 + 逐题（题号/题型/知识点/分值/得分/是否不确定）。" +
    (page > 1 ? "注意：**只报这一页能看到的题**，不要重复前面页的题。" : "");

  const r = await callVisionModel({
    label: "[paper-analysis/vision-paper-structure]",
    system: STRUCTURE_PROMPT,
    images: [img],
    userText,
    maxTokens: MAX_TOKENS,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  // ---------- 5. 解析并**归一化**模型返回的 JSON ----------
  const parsed = parseJsonObject(r.text);
  if (!parsed) {
    // ⚠️ 解析不出来**不是 5xx**：模型没按格式答，前端要把原文摊开给老师复制（不能白花这次调用）
    return NextResponse.json({
      ok: true,
      page,
      empty: true,
      structure: null,
      raw: r.text.slice(0, 4000),
      note: "AI 返回的内容不是合法 JSON，已把原文返回给你手工整理。",
    });
  }

  const structure = normalizeStructure(parsed, page);
  return NextResponse.json({
    ok: true,
    page,
    empty: structure.questions.length === 0,
    structure,
    retried: r.retried,
  });
}

/** 从模型输出里抠出 JSON 对象（容忍 ```json 包裹、前后废话）。
 *  结构与难度两处都用它 —— **只有一份实现**。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const candidates = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const brace = t.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 把模型给的东西**归一到工具认识的形状**（防御性：模型不总是听话）。
 * ⚠️ 题型必须过与前端 `PaperParser.normType` **同一套口径**（这里只能做同义别名兜底，
 *    前端拿到后仍会再过一次白名单）—— 题型错了会连带分值分配与报告统计一起错。
 */
function normalizeType(raw: unknown): string {
  const s = String(raw ?? "").replace(/^[一二三四五六七八九十]+\s*[、.．,，:：]\s*/, "").replace(/[\s　]+/g, "").trim();
  const alias: Record<string, string> = {
    选择题: "单选题", 单选: "单选题", 单选题: "单选题",
    多项选择题: "多选题", 多选: "多选题", 多选题: "多选题",
    填空: "填空题", 填空题: "填空题",
    解答: "解答题", 大题: "解答题", 解答题: "解答题",
    判断题: "判断题",
  };
  return alias[s] ?? (s || "其他");
}

function normalizeStructure(v: Record<string, unknown>, page: number) {
  const num = (x: unknown): number | null => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

  const questions = arr<Record<string, unknown>>(v.questions)
    .slice(0, MAX_QUESTIONS)
    .map((q) => ({
      no: Number.isFinite(Number(q.no)) ? Number(q.no) : null,
      type: normalizeType(q.type),
      knowledge: arr<unknown>(q.knowledge).map((k) => String(k).trim()).filter(Boolean).slice(0, 5),
      /** 卷面印了才填；没印 null（**不许猜**，前端按题型惯例补并标待核对） */
      score: num(q.score),
      /** 批改卷的得分；没批改 null */
      got: q.got === null || q.got === undefined || q.got === "" ? null : Number(q.got),
      uncertain: q.uncertain === true,
    }))
    .filter((q) => q.no !== null || q.knowledge.length > 0);

  const blocks = arr<Record<string, unknown>>(v.blocks).map((b) => ({
    type: normalizeType(b.type),
    count: Number.isFinite(Number(b.count)) ? Number(b.count) : null,
    perScore: num(b.perScore),
  }));

  return {
    title: String(v.title ?? "").trim().slice(0, 120),
    totalScore: num(v.totalScore),
    blocks,
    questions,
    uncertainNotes: arr<unknown>(v.uncertainNotes).map((s) => String(s).trim()).filter(Boolean).slice(0, 20),
    page,
  };
}
