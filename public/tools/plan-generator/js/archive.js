/**
 * 辅导方案生成器 · 学生档案（统一档案 /api/students）
 * ==========================================================================
 * 与 `math-plan.html` 的「阶段4」同一套口径，职责分两块：
 *   · **纯函数**：读身份 / 合 extra（保住别家工具的键）/ 拼方案正文 —— 可单测
 *   · **网络+界面**：拉档案、保存身份、存入方案记录 —— 由界面层注入 DOM 操作（本文件不绑页面）
 *
 * ⚠️ 四条硬口径（照 `docs/project-overview.md` 与数学版的踩坑记录）：
 *   1. **只存「学生是谁」**：name/grade/campus/teacher + extra 里的 book/stage。
 *      分数、目标分、课时、薄弱模块属于**这一次方案**，进档案会"换个学生就把上一位的分数写成他的"。
 *   2. **写档案只有一条路**（本文件的 `persistStudent`）：调用点不要自己 fetch
 *      —— "同一件事有两个来源"是这个项目反复踩过的坑。
 *   3. **extra 必须"先读旧行、展开、再盖自己的键"**：它是 jsonb，传了就是整块替换，
 *      不展开会把别家工具（paper 的 cls 等）的键抹掉。
 *   4. **存入档案时 `tool` 仍写 `'math-plan'`**（用户 2026-10 拍板，**零迁移**）：
 *      `feedback_history.tool` 的 CHECK 只允许 feedback/paper/math-plan/analysis/manual，
 *      新增值要跑迁移；而复用它 ⇒ 学情分析（SOURCE_TOOLS/TOOL_LABELS）**自动认**。
 *      学科靠 `subject='physics'` 区分，标题写「物理辅导方案」。
 *      ⚠️ 将来通用工具正式上线后，要为"物理与数学混在学情分析里分不出学科"跑一条迁移
 *         —— 详见 `docs/plan-generator-plan.md` §6。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanGenArchive = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ======================================================================
     常量
     ====================================================================== */

  /** 本工具在 `extra` 里**拥有**的键（白名单：别的工具的一律不碰） */
  var EXTRA_KEYS = ["book", "stage"];

  /**
   * ⚠️ **刻意复用数学版的 tool 值**（零迁移）。
   * 用户的原始要求：存档案写 `tool='math-plan'`，否则学情分析认不出来。
   */
  var ARCHIVE_TOOL = "math-plan";

  /** 学科 code（与 feedback.html 的 SUBJECTS、user_profiles.subject 同一套） */
  function subjectCode(pack) {
    var k = String((pack && pack.key) || "").trim();
    return k || "general";
  }

  /** 学科中文名：优先用调用方给的（界面有唯一来源），否则退回科目包里的名字 */
  function subjectNameOf(pack, fromUI) {
    var n = String(fromUI == null ? "" : fromUI).trim();
    if (n) return n;
    return String((pack && pack.name) || "").trim();
  }

  /** 本校部署才开云（双击 HTML / 别的服务器上跑 → 不联网） */
  function isHosted(loc) {
    var l = loc || (typeof location !== "undefined" ? location : null);
    if (!l) return false;
    try {
      return (l.protocol === "http:" || l.protocol === "https:");
    } catch (e) { return false; }
  }

  /* ======================================================================
     ① 纯函数：身份 / extra
     ====================================================================== */

  /** 服务器档案行 → 本工具内部形状（**不认识的键一个不带**） */
  function studentFromCloud(row) {
    var r = row || {};
    var ex = (r.extra && typeof r.extra === "object") ? r.extra : {};
    return {
      grade: r.grade || "",
      campus: r.campus || "",
      teacher: r.teacher || "",
      book: ex.book || "",
      stage: ex.stage || "",
      updated: r.updated || ""
    };
  }

  /**
   * 合并 extra：**先展开旧值，再盖上本工具有值的键**（没有值的键保持原样，不清空）。
   * @param oldExtra 服务器上那一行原来的 extra
   * @param mine     本工具这次的值 {book, stage}
   */
  function mergeExtra(oldExtra, mine) {
    var out = {};
    var old = (oldExtra && typeof oldExtra === "object") ? oldExtra : {};
    Object.keys(old).forEach(function (k) { out[k] = old[k]; });
    EXTRA_KEYS.forEach(function (k) {
      if (mine && mine[k]) out[k] = mine[k];
    });
    return out;
  }

  /** 把界面上的值整理成"身份"（**只含身份**，一个方案参数都不许进来） */
  function readIdentity(o) {
    var v = o || {};
    var out = {};
    if (v.grade) out.grade = String(v.grade);
    if (v.campus) out.campus = String(v.campus).trim();
    if (v.teacher) out.teacher = String(v.teacher).trim();
    out.book = v.book ? String(v.book) : "";
    out.stage = v.stage ? String(v.stage) : "";
    return out;
  }

  /**
   * 组装 POST /api/students 的 body（**合并语义**：只发有值的字段）。
   * ⚠️ `extra` 只有在"合并后非空"时才带；**绝不能传 null**（jsonb not null 列写 null 会撞 23502，
   *    而且症状很迷惑：新建行 500、更新已有行正常）。
   */
  function buildStudentBody(name, identity, oldExtra) {
    var n = String(name == null ? "" : name).trim();
    if (!n) throw new Error("学生姓名为空，无法保存档案");
    var id = identity || {};
    var body = { name: n };
    if (id.grade) body.grade = String(id.grade);
    if (id.campus) body.campus = String(id.campus).trim();
    if (id.teacher) body.teacher = String(id.teacher).trim();
    var extra = mergeExtra(oldExtra, { book: id.book, stage: id.stage });
    if (Object.keys(extra).length) body.extra = extra;
    return body;
  }

  /* ======================================================================
     ② 纯函数：把「这一次方案」拼成档案正文
     ====================================================================== */

  /**
   * 方案正文。
   *
   * ⚠️ **`【课时安排】共 N 课时` 这一句是关键**：学情分析统计"课时累计"靠的就是它
   *    （`src/lib/student-report.ts` 的 `parsePlanHours()`），少一句就统计不到。
   */
  function planText(o) {
    var v = o || {};
    var lines = [];
    var pack = v.pack || {};
    var subjectName = subjectNameOf(pack, v.subjectName);

    lines.push("【基本信息】" + subjectName + " · " + (v.stageName || "") + " · " + (v.grade || "")
      + (v.book ? " · " + v.book : ""));
    if (v.bandName) {
      lines.push("【学情档位】" + v.bandName
        + (v.score != null && v.score !== "" ? "（当前 " + v.score + " 分）" : "")
        + (v.targetScore != null && v.targetScore !== "" ? "（目标 " + v.targetScore + " 分）" : ""));
    }
    lines.push("【课时安排】共 " + (v.totalHours == null ? "" : v.totalHours) + " 课时"
      + (v.periodText ? "；辅导时间 " + v.periodText : "")
      + (v.hoursPerWeekText ? "；周课时 " + v.hoursPerWeekText : ""));

    var rows = v.rows || [];
    if (rows.length) {
      lines.push("【模块进度表】（一行一个模块）");
      rows.forEach(function (r) {
        lines.push([r.stageName || "", r.name || "", (r.hours == null ? "" : r.hours + " 课时"),
          r.goal || (r.content ? "内容：" + r.content : "")].join("｜"));
      });
    }
    if (v.note) lines.push("【学习特点】" + String(v.note).trim());
    return lines.join("\n");
  }

  /** 档案里的标题：`物理辅导方案（高三）` */
  function planTitle(o) {
    var v = o || {};
    var pack = v.pack || {};
    var subjectName = subjectNameOf(pack, v.subjectName) || "辅导";
    var g = String(v.grade || "").trim();
    return subjectName + "辅导方案" + (g ? "（" + g + "）" : "");
  }

  /** 今天的中文日期（服务端 `parseDisplayDate` 认「2026年10月7日」这种写法） */
  function todayCn(now) {
    var d = now instanceof Date ? now : new Date();
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  /**
   * 组装 `op:'import'` 的条目。
   * ⚠️ `tool` 写 `'math-plan'`（见文件头第 4 条）；`subject` 写真实学科 code。
   * ⚠️ 分数与满分按"档案列"存（方便以后看趋势），**但那是"这一次"的分数**——
   *    与"学生身份"分开：身份进 students 表，分数进 history 记录。
   */
  function buildImportItem(o) {
    var v = o || {};
    var pack = v.pack || {};
    var item = {
      student_name: String(v.student == null ? "" : v.student).trim(),
      text: String(v.text == null ? "" : v.text),
      date: v.date ? String(v.date) : todayCn(v.now),
      tool: ARCHIVE_TOOL,
      subject: subjectCode(pack),
      title: planTitle(v)
    };
    if (v.score != null && v.score !== "" && isFinite(Number(v.score))) {
      item.score = Number(v.score);
      if (v.fullScore != null && v.fullScore !== "" && isFinite(Number(v.fullScore))) {
        item.full_score = Number(v.fullScore);
      }
    }
    return item;
  }

  /* ======================================================================
     ③ 网络（只碰 /api/students）
     ====================================================================== */

  function makeStore(fetchImpl) {
    var f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

    async function loadAll() {
      var r = await f("/api/students", { credentials: "same-origin" });
      if (!r.ok) throw new Error("接口 /api/students 返回 " + r.status);
      var d = await r.json();
      if (!d || !d.ok) throw new Error((d && d.error) || "读取档案失败");
      return d.students || {};
    }

    async function post(body) {
      var r = await f("/api/students", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var d = null;
      try { d = await r.json(); } catch (e) { d = null; }
      if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || ("接口返回 " + r.status));
      return d;
    }

    // ⚠️ 用**具名函数**而不是对象方法：对象方法里一旦出现 `this.post(...)`，
    //    界面层把方法解构出来时 `this` 就没了（第一版就留了这么一处，被静态断言抓住）。
    async function importItems(items) {
      return post({ op: "import", items: items });
    }

    return { loadAll: loadAll, post: post, importItems: importItems };
  }

  /* ======================================================================
     ④ 组合层：给界面用（依赖注入 fetch，便于测试）
     ====================================================================== */

  function create(opts) {
    var o = opts || {};
    var store = makeStore(o.fetch);
    var enabled = false;
    var students = {};          // 姓名 → 身份（只从服务器来，本机不再存一份）
    var hosted = function () { return isHosted(o.location); };

    // ⚠️ 方法之间**不要用 `this`** 互相调用：界面层一旦把方法解构出来（`const {boot} = api`），
    //    `this` 就没了。第一版就是这么写的，属于"迟早会咬人"的写法。
    var api = {
      isHosted: hosted,
      get enabled() { return enabled; },
      get students() { return students; },

      /** 拉一次全部档案；**拉不到就明确报错**（不静默装作没有档案） */
      async boot() {
        if (!hosted()) { enabled = false; return { ok: false, reason: "not-hosted" }; }
        enabled = true;
        var all = await store.loadAll();     // 失败就让调用方去提示（这里不吞异常）
        students = {};
        Object.keys(all || {}).forEach(function (n) {
          students[n] = studentFromCloud(all[n]);
        });
        return { ok: true, count: Object.keys(students).length };
      },

      /** 保存/更新一位学生的**身份**（唯一的写档案入口） */
      async persistStudent(name, identity) {
        if (!enabled) throw new Error("当前不在网站上，无法保存档案");
        // ⚠️ 先读回旧行：extra 是整块替换，不读就会把别家工具的键抹掉
        var before = await store.loadAll();
        var row = before ? before[String(name).trim()] : null;
        var oldExtra = (row && typeof row.extra === "object") ? row.extra : {};
        var body = buildStudentBody(name, identity, oldExtra);
        var res = await store.post(body);
        students[String(name).trim()] = readIdentity(identity);
        return res;
      },

      /** 把「这一次方案」存进该学生的档案（**必须老师手点**，不自动存） */
      async savePlan(plan) {
        if (!enabled) throw new Error("当前不在网站上，无法存入档案");
        var v = plan || {};
        var name = String(v.student == null ? "" : v.student).trim();
        if (!name) throw new Error("请先填学生姓名（档案是按学生存的）");
        var item = buildImportItem(v);
        if (!String(item.text || "").trim()) throw new Error("没有可存的方案内容");
        return store.importItems([item]);
      },

      /** 删除一位学生的档案（连带历史 —— 服务端就是这样做的） */
      async removeStudent(name) {
        if (!enabled) throw new Error("当前不在网站上，无法删除档案");
        var f = o.fetch || (typeof fetch !== "undefined" ? fetch : null);
        var r = await f("/api/students?name=" + encodeURIComponent(name),
          { method: "DELETE", credentials: "same-origin" });
        if (!r.ok) throw new Error("删除接口返回 " + r.status);
        delete students[String(name).trim()];
        return r.json();
      }
    };
    return api;
  }

  /* ======================================================================
     导出（纯函数给测试用；create() 给界面用）
     ====================================================================== */
  return {
    EXTRA_KEYS: EXTRA_KEYS,
    ARCHIVE_TOOL: ARCHIVE_TOOL,
    // 纯函数
    subjectCode: subjectCode,
    subjectNameOf: subjectNameOf,
    isHosted: isHosted,
    studentFromCloud: studentFromCloud,
    mergeExtra: mergeExtra,
    readIdentity: readIdentity,
    buildStudentBody: buildStudentBody,
    planText: planText,
    planTitle: planTitle,
    todayCn: todayCn,
    buildImportItem: buildImportItem,
    makeStore: makeStore,
    create: create
  };
}));
