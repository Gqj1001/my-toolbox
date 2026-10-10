import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  deleteStudentByName,
  getHistoryFresh,
  getStudentsFresh,
  historyByStudent,
  importHistory,
  invalidateHistory,
  pickHistoryPatch,
  pickStudentPatch,
  studentsByName,
  upsertStudent,
} from "@/lib/feedback-db";
import { parseDisplayDate } from "@/lib/date-input";
import { getViewer } from "@/lib/viewer";

/**
 * 统一学生档案接口（阶段2 第3步）。
 *
 * 为什么要有它：三个工具（feedback / paper-analysis / math-plan）都要读写**同一份**
 * 学生档案与考试记录。feedback 已经有 `/api/feedback/data`，但那个接口的写法是
 * **整行覆盖**（PostgREST upsert，没带的列会被清成 NULL）—— 0014 之后同一行装了
 * 三个工具的字段，整行覆盖会**静默清掉别家工具的字段**。所以新接口用**合并语义**：
 *
 *   POST 只覆盖「真正传了的字段」，没传的一律保留原值。
 *   例：math-plan 存了 grade/campus/extra，被 feedback 保存一次后**不能丢**。
 *
 * 路由一览：
 *   GET    /api/students                  列出当前用户的全部学生档案
 *   GET    /api/students?name=张三         单查一个（返回 404 语义：ok:true, student:null）
 *   GET    /api/students?withHistory=1    同时带上历史（按姓名分组）
 *   POST   /api/students  { name, ... }                    upsert 一位（合并语义）
 *   POST   /api/students  { op:"import", items:[…] }        批量导入考试记录（幂等）
 *   DELETE /api/students?name=张三         删除档案（连同其历史）
 *   DELETE /api/students?id=<historyId>   删除**单条**历史记录（阶段3 补：以前只有
 *                                         /api/feedback/data 支持，统一接口这边缺）
 *
 * 隐私隔离：全部查询**不加 user_id 过滤**，靠 RLS（`user_id = auth.uid()`）隔离；
 *   进程内缓存的 key 里带 user_id（见 feedback-db 的 getStudents/getHistory 注释）。
 *   这一点有测试钉住：`tests/students-unified.test.mjs` 的跨账号隔离组。
 */

/** 与 `/api/feedback/data` 一致的守卫：未登录 401、封禁 403 */
async function requireUser() {
  const viewer = await getViewer();
  if (!viewer.user) return { ok: false as const, status: 401, message: "请先登录。" };
  if (viewer.membership.status === "banned") {
    return { ok: false as const, status: 403, message: "账号已被封禁。" };
  }
  return { ok: true as const, userId: viewer.user.id };
}

/** 统一错误出口：不把数据库细节暴露给前端，但**服务端日志**要留全 */
function dbError(scope: string, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[students] ${scope} 失败:`, message);
  return NextResponse.json({ ok: false, error: "操作失败，请稍后重试。" }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.message }, { status: guard.status });
  }

  const sp = request.nextUrl.searchParams;
  const name = sp.get("name");
  const withHistory = sp.get("withHistory") === "1";

  try {
    // ⚠️ **用不缓存的直读**（`getStudentsFresh` / `getHistoryFresh`），不是带 25 秒 TTL 的
    //    `getStudents()` / `getHistory()`。原因（2026-10 实测，很难查）：
    //    这些写入口现在同时被 **Server Action**（学员档案页）调用，
    //    Server Action 里调的 `invalidateStudents()` **清不掉 Route Handler 这边的那份缓存**
    //    （两者不在同一个模块实例/执行上下文里传递失效信号）。
    //    症状：档案页里刚新建的学生，页面**显示正常**（它读的是直读），
    //    但 `/api/students` 返回 `count:0` —— 三个工具拉档案时**看不到这个学生**，
    //    最长 25 秒，看起来就是「保存了但没生效」。
    //    这个接口是三个工具读写学生档案的**唯一入口**，正确性优先于省一次往返。
    const rows = await getStudentsFresh();
    // 复用 feedback 的装配函数：**同一份返回结构**，三个工具与将来的统一首页只认这一种形状。
    // （不要在别处再写一套 {姓名: {...}} 的拼装，那种"第二个来源"是这个项目踩过的坑。）
    const all = studentsByName(rows);

    const payload: Record<string, unknown> = {
      ok: true,
      students: name ? (name in all ? { [name]: all[name] } : {}) : all,
      count: Object.keys(all).length,
    };

    if (withHistory) {
      const histRows = await getHistoryFresh();
      payload.history = historyByStudent(histRows);
    }
    if (name) {
      payload.student = name in all ? all[name] : null;
    }
    return NextResponse.json(payload);
  } catch (e) {
    return dbError("读取档案", e);
  }
}

/** 历史归属工具的白名单 —— 与 `feedback_history_tool_check` 约束**必须一致**。
 *
 *  ⚠️ 为什么要有这个白名单，而不是「不合法就按 paper 处理」：
 *     导入口原来写的是「缺省按 paper」—— 那会让**将来接进来的工具**（math-plan 等）
 *     把数据**静默标成 paper**：接口 200、行也进去了，但归属错了，
 *     「只看试卷分析」这类筛选会把它算进 paper，而且**没有任何报错**。
 *     静默写错归属比写不进去更糟（写不进去至少会被发现），所以这里明确拒绝。
 *
 *  ⚠️ 加新工具时**两步都要做**，只做一步的后果见上：
 *     ① 先在 Supabase 执行一条迁移，把 `tool in (...)` 的区间放宽到新工具；
 *     ② 再把新工具名加到这个数组里。
 *
 *  `math-plan` 是 2026-10 加进来的（迁移 `0016_history_tool_allow_math_plan.sql`，
 *  用户已在 Supabase SQL Editor 里执行）：辅导方案工具点「存入档案」时写它。 */
const ALLOWED_TOOLS = ["feedback", "paper", "math-plan"] as const;

/** 把一条外来记录规整成可写入的行（日期走与 feedback 同一个解析器） */
function normalizeHistoryItem(raw: Record<string, unknown>) {
  const patch = pickHistoryPatch(raw);
  const tool = typeof patch.tool === "string" ? patch.tool : "";
  // ⚠️ 复用 feedback 的同一个解析器（src/lib/date-input.ts）：
  //    paper 的 examDate 是「2026年10月7日」这种给人看的文本，直接写 date 列会被 PG 拒绝。
  const date = parseDisplayDate(patch.date);
  return {
    student_name: patch.student_name,
    text: patch.text,
    date,
    type_name: patch.type_name ?? null,
    subject: patch.subject ?? null,
    tool,
    title: patch.title ?? null,
    score: patch.score ?? null,
    full_score: patch.full_score ?? null,
  };
}

export async function POST(request: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.message }, { status: guard.status });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  // ---------------- 批量导入考试记录（幂等） ----------------
  if (body.op === "import") {
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) {
      return NextResponse.json({ ok: false, error: "缺少 items 数组。" }, { status: 400 });
    }
    if (items.length > 2000) {
      return NextResponse.json({ ok: false, error: "单次导入最多 2000 条。" }, { status: 400 });
    }
    const normalized = [];
    // 日期解析不出来的条数**必须如实报回去**（用户明确要求：不静默丢数据）
    let dateUnparsed = 0;
    // 归属工具不合法的条数：同样**明确拒绝**，不当成 paper 混进去（见 ALLOWED_TOOLS）
    let badTool = 0;
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = normalizeHistoryItem(raw as Record<string, unknown>);
      if (!item.student_name || !item.text) continue;
      if (!(ALLOWED_TOOLS as readonly string[]).includes(item.tool)) { badTool++; continue; }
      if (item.date === null && (raw as Record<string, unknown>).date) dateUnparsed++;
      normalized.push(item);
    }
    // ⚠️ 一条都不合法时直接报错：否则会返回 `ok:true, inserted:0`，
    //    前端会显示「已保存 0 条」——看起来像"保存成功但没数据"，最难查。
    if (badTool && !normalized.length) {
      return NextResponse.json(
        { ok: false, error: `记录的归属工具不合法（只允许 ${ALLOWED_TOOLS.join(" / ")}），已全部拒绝。` },
        { status: 400 },
      );
    }

    try {
      const result = await importHistory(normalized);
      return NextResponse.json({
        ok: true,
        ...result,
        received: items.length,
        accepted: normalized.length,
        // ⚠️ 前端必须把这个数展示给用户（「有 N 条日期没能识别」），不能吞掉
        dateUnparsed,
        // 被拒的条数也报出来（正常应是 0；不为 0 说明调用方传错了归属工具）
        rejectedTool: badTool,
      });
    } catch (e) {
      // ⚠️ 数据库的 CHECK 约束没跟上白名单时，必须给出**能照着做**的提示。
      //    2026-10 第一次跑就撞上了：白名单加了 math-plan，但迁移 0016 还没在线上执行，
      //    于是前端只看到一句「操作失败，请稍后重试」——完全没法定位。
      //    归属工具的合法值**唯一来源是迁移文件**，接口这边只能替它报错。
      const msg = e instanceof Error ? e.message : String(e);
      if (/feedback_history_tool_check|check_violation|23514/.test(msg)) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "数据库还不接受这个归属工具：请先在 Supabase SQL Editor 执行迁移 " +
              "supabase/migrations/0016_history_tool_allow_math_plan.sql（放宽 tool 的 CHECK 约束），再重试。",
            code: "tool_constraint",
          },
          { status: 409 },
        );
      }
      return dbError("导入记录", e);
    }
  }

  // ---------------- upsert 一位学生档案（合并语义） ----------------
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, error: "缺少学生姓名。" }, { status: 400 });
  }
  if (name.length > 100) {
    return NextResponse.json({ ok: false, error: "学生姓名过长。" }, { status: 400 });
  }

  const patch = pickStudentPatch(body);
  // extra 必须是 JSON 对象（0014 有 CHECK 约束，先在这里挡一下给出中文提示）
  if ("extra" in patch) {
    const ex = patch.extra;
    if (ex !== null && (typeof ex !== "object" || Array.isArray(ex))) {
      return NextResponse.json({ ok: false, error: "extra 必须是 JSON 对象。" }, { status: 400 });
    }
  }

  try {
    const row = await upsertStudent(guard.userId, name, patch);
    // 返回结构与本接口的 GET 一致（同一个装配函数），前端只认一种形状
    return NextResponse.json({ ok: true, student: studentsByName([row])[name] });
  } catch (e) {
    return dbError("保存档案", e);
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.message }, { status: guard.status });
  }

  // 删除**单条历史**（paper-analysis 的「删一条历史」需要它；原来只有
  // /api/feedback/data 支持，统一接口这边缺）。行为与那边保持一致：
  // 删完必须 `invalidateHistory()`，否则最长 25 秒内那条记录会从缓存里"复活"。
  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    const supabase = await createClient();
    const { error } = await supabase.from("feedback_history").delete().eq("id", Number(id));
    if (error) {
      console.error("[students] 删除历史失败:", error.code, error.message);
      return NextResponse.json({ ok: false, error: "删除失败。" }, { status: 500 });
    }
    invalidateHistory();
    return NextResponse.json({ ok: true });
  }

  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ ok: false, error: "缺少 name 参数。" }, { status: 400 });
  }
  try {
    await deleteStudentByName(name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbError("删除档案", e);
  }
}
