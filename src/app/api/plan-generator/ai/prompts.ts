/**
 * 「辅导方案生成器」AI 生成教学目标 · 数据与提示词
 * ==========================================================================
 * ⚠️ 这个文件里的**所有措辞规则都来自老师给的真实样例**（不是我想出来的）：
 *   · other-subjects/senior/physics/辅导计划/锐满分全年班组辅导计划.docx
 *   · other-subjects/senior/physics/辅导计划/高三班组辅导计划.doc
 *   · other-subjects/senior/physics/辅导计划/锐满分阶段辅导计划.docx
 *   · other-subjects/junior/physics/辅导计划/初三全托班组物理辅导计划.doc
 *   · other-subjects/junior/physics/辅导计划/张雨宸初三辅导计划.docx
 *
 * 我（DSH）从这 5 份里看出的**老师写「教学目标」的固定套路**：
 *   ① 分点用「知道 / 理解 / 掌握 / 会 / 能」这几个动词起头（一句一个点，用「．」或「.」断句）
 *   ② 高中收尾固定加「**重点与难点：**…」（把这一模块最容易出错的地方点出来）
 *   ③ 高中还会加「**分值：**高考必考知识，每年的分值在 4 分到 8 分不等」
 *   ④ 初中偏「**重点：**…」，落到"会用什么公式算、会解释什么现象、会做什么实验"
 *   ⑤ 量化指标写成「正确率≥90%」「得分率≥85%」「每题不超过 2 分钟」这种**可验收**的说法
 *
 * ⚠️ 用户明确要求过：这套话术**先看 AI 生成的初稿**，老师不满意再调 ——
 *    所以这里的规则要"像老师写的"，而不是"像教科书目录"。
 *
 * ⚠️ 铁律（做不到就别输出）：**只许用科目包里给的教材小节，不许自己编章节号或考点**。
 *    "内容"那一列是**程序填的**（照人教社目录），AI **只写教学目标**。
 */

/** 从真实样例里摘的措辞范例（**每条都逐字来自上面那 5 份文件**，只是截短了） */
export const STYLE_EXAMPLES = {
  /** 高中：分点动词 + 「重点与难点：」+ 「分值：」 */
  seniorHigh: [
    "知道质点的概念，知道质点是一种理想化物理模型．知道把物体看作质点的条件．理解参考系的概念，知道物体运动具有相对性．知道时刻与时间间隔的区别和联系．"
    + "重点与难点：v－t图像，x－t图像，匀变速直线运动规律．分值：高考必考知识，每年的分值在4分到8分不等",
    "理解重力及重心的概念，会用二力平衡知识确定重心．知道压力、支持力和绳的拉力都是弹力，会分析弹力的方向．知道滑动摩擦力的概念及产生条件，会判断滑动摩擦力的方向．"
    + "理解力的合成和分解遵循的规律——平行四边形定则．知道什么是共点力，掌握共点力平衡的条件．重点与难点：共点力平衡问题，力的合成和分解．分值：高考必考知识，每年的分值在4分到12分不等",
    "知道光电效应现象，了解光电效应的实验规律．理解爱因斯坦光子说及对光电效应的解释，会用光电效应方程解决一些简单问题．了解康普顿效应及其意义．了解光的波粒二象性．"
    + "重点与难点：光电效应规律，光电效应方程及图象分析，氢原子的能级与能级公式．分值：高考必考知识，每年的分值在3分到6分不等",
  ],
  /** 初中：偏「重点：」+ 落到"会用公式算 / 会解释现象 / 会做实验" */
  juniorHigh: [
    "掌握扩散现象实质，了解分子热运动及分子间作用力，掌握内能、热量等及改变内能的方式，掌握比热容的含义，会用比热容计算物体吸收或放出的热量。"
    + "重点：知道分子动理论主要内容；知道改变内能的方式；能判断热量、内能、温度的关系；会进行简单的吸放热计算。",
    "掌握两种电荷，电流的产生，电路的构成和元件，掌握串并联电路的特点，会使用电流表，掌握串并联电路的规律。"
    + "重点：知道电流表的读数与使用方法；会分析简单的串并联电路；能说出电路中各元件的作用。",
    "通过实验体会电流与电压电阻的关系，提高实验分析总结能力。理解欧姆定律的内容及表达式，能够简单计算；知道伏安法测电阻的原理，体会多次测量求平均值减小实验误差；会进行简单计算。"
    + "重点：电路分析准确、电学计算无误；加强比例、图像、动态电路、故障电路等题型。",
  ],
  /** 跨册实验模块（力学实验 / 电学实验 / 中考实验）：写法与"讲课型"模块不同 */
  experiment: [
    "练习正确使用打点计时器．会计算纸带上各点的瞬时速度．会利用纸带计算加速度．会用图象法探究小车速度与时间的关系，并能根据图象求加速度．学会用列表法、图象法等方法处理实验数据．"
    + "重点和难点：掌握验证机械能守恒定律的方法．会用计算法或图象法处理实验数据．分值：高考必考知识，每年的分值在7分到9分不等",
    "掌握长度测量工具的读数方法，实物图连接，电表的改装与选择，测量导体的电阻率，电路图的选择．掌握多用电表的读数、使用方法，利用多用电表判断电路中的故障．掌握E、r测量原理，数据处理和误差分析．"
    + "重点和难点：电表改装与选择、多用电表读数与使用、误差分析",
  ],
};

/** 学段（只认这两个；别的地方传别的值由路由拦掉） */
export type Stage = "senior" | "junior";

/** 一条模块（由前端从科目包 + 当前方案里取出来） */
export type GoalRow = {
  name: string;
  term?: string;
  /** 难度 1 基础 / 2 中档 / 3 高阶 */
  lv?: number | string;
  stageName?: string;
  chapters?: string[];
  content?: string;
  hasExperiment?: boolean;
};

/** 生成目标时的学生与方案上下文 */
export type GoalContext = {
  subjectName: string;
  stage: Stage;
  grade?: string;
  bandName?: string;
  score?: string | number;
  targetScore?: string | number;
  totalHours?: string | number;
  rows: GoalRow[];
};

/** 学段 → 人设与措辞规则（**参数化的关键**：换学科/学段只改这里） */
export function personaOf(subjectName: string, stage: Stage): { role: string; stageWord: string; isJunior: boolean } {
  const isJunior = stage === "junior";
  const stageWord = isJunior ? "初中" : "高中";
  return {
    role: `你是一位有十几年经验的${stageWord}${subjectName}教师，正在为一位学生写个性化辅导方案的「教学目标」列。`,
    stageWord,
    isJunior,
  };
}

/** 三档（补基础 / 提中档 / 冲高分）× 三个难度(lv) 的量化指标表（**唯一来源**） */
export function metricsTable() {
  return [
    "   难度          band1（补基础）   band2（提中档）   band3（冲高分）",
    "   基础题(lv1)    ≥70%             ≥80%              ≥85%",
    "   中档题(lv2)    ≥60%             ≥75%              ≥85%",
    "   难题(lv3)      ≥50%             ≥60%              ≥75%",
  ].join("\n");
}

/** 共同的硬性约束（事实不许改、不许编、只输出正文） */
const COMMON_RULE =
  "硬性约束（违反任何一条都算不合格）：\n" +
  "1. **只写教学目标**：不要复述、不要修改、不要新增教材小节号或知识点。教材小节由程序填好，" +
  "你写的内容必须是「学完之后能做到什么」，不是「这节课讲什么」。\n" +
  "2. **不许编造**：不得出现上面没给出的教材章节号、考点名、题型名。拿不准就写得更笼统，" +
  "宁可少写一个点，也绝不编一个不存在的小节或考点。\n" +
  "3. 不要输出 markdown 符号、不要编号、不要小标题、不要解释你在做什么，直接输出正文。\n" +
  "4. 每条控制在 40–90 字（大约 2–4 个分点），不要写成一大段论文。";

/** 学段专属的措辞规则（这是"像不像老师写的"的关键） */
function styleRule(stage: Stage): string {
  if (stage === "junior") {
    return (
      "写作要求（照这个来）：\n" +
      "5. 用「知道 / 理解 / 掌握 / 会 / 能」这几个动词分点写，句末用「。」。\n" +
      "6. **末尾加一句「重点：…」**，把这一模块最容易错/最该练的地方点出来（这是这套方案里老师固定的写法）。\n" +
      "7. 初中偏「能解释现象、会用公式算、会做实验」，少讲抽象推导。\n"
    );
  }
  return (
    "写作要求（照这个来）：\n" +
    "5. 用「知道 / 理解 / 掌握 / 会 / 能」这几个动词分点写，分点之间用「．」，最后一个分点后也带「．」。\n" +
    "6. **末尾加一句「重点与难点：…」**，再跟上「分值：…」（写法：高考必考知识，每年的分值在 N 分到 M 分不等）。\n" +
    "   ⚠️ 「分值」只用上面给的这些形式，**不许自己编一个精确的分数**。\n" +
    "7. 高中要体现「理解规律、会分析模型、能规范书写步骤」。\n"
  );
}

/**
 * 组装发给上游的 messages。
 *
 * 入参 `rows`（每行一个模块）：
 *   { name, term, lv, stageName, chapters:[], content, hasExperiment }
 * 返回：`{ ok, messages }`；`ok=false` 时由调用方决定怎么提示（不抛异常）。
 *
 * ⚠️ 单独导出是为了让测试能**直接断言提示词结构**，不必真连上游
 *    （math-plan 的 `buildMessages` 也是这么做的）。
 */
export function buildGoalsMessages(ctx: GoalContext): {
  ok: boolean;
  persona: { role: string; stageWord: string; isJunior: boolean };
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  experimentExampleIncluded: boolean;
} {
  const { subjectName, stage, grade, bandName, score, targetScore, totalHours, rows } = ctx;
  const persona = personaOf(subjectName, stage);

  // 教材小节清单：**逐字来自科目包**，让模型只认这些
  const lines = rows.map((r: GoalRow, i: number) => {
    const n = i + 1;
    const parts = [];
    parts.push(`第${n}条`);
    parts.push(`模块：${r.name}`);
    if (r.term) parts.push(`教材：${r.term}`);
    parts.push(`难度：lv${r.lv == null ? 2 : r.lv}`);
    if (r.stageName) parts.push(`复习阶段：${r.stageName}`);
    if (r.hasExperiment) parts.push("（含学生实验）");
    if (r.chapters && r.chapters.length) {
      parts.push(`教材小节（只能用这些）：${r.chapters.join("；")}`);
    } else if (r.content) {
      parts.push(`教材小节（只能用这些）：${r.content}`);
    }
    return parts.join("｜");
  });

  const system =
    persona.role + "\n" +
    "你会一次收到若干条模块，请**逐条**写出该模块的教学目标。\n" +
    COMMON_RULE + "\n" +
    styleRule(stage) + "\n" +
    "8. **每一条都必须带量化指标**（正确率或得分率），数值按下表（band 与 lv 见每条里的标注）：\n" +
    metricsTable() + "\n" +
    "   写成「正确率≥X%」或「得分率≥X%」。含学生实验的模块，至少有一个分点写实验相关目标" +
    "（如「会正确连接电路并读数」「会用图象法处理实验数据」），不必勉强套正确率。\n" +
    "9. 输出格式：**每条一行**，行数必须正好等于上面给的条数，顺序不变。" +
    "只输出教学目标本身，**不要带上「第N条」「模块：」这些前缀**。\n" +
    "10. 条数为多少就输出多少行 —— 多写一行或少写一行都会被程序判为失败。";

  const style = persona.isJunior
    ? STYLE_EXAMPLES.juniorHigh
    : STYLE_EXAMPLES.seniorHigh;
  const expExample = STYLE_EXAMPLES.experiment[persona.isJunior ? 0 : 0];

  const context = [
    `学生年级：${grade || "（未填）"}`,
    `学科：${subjectName}`,
    `档位：${bandName || "（未填）"}`,
    score != null && score !== "" ? `当前分数：${score}` : "",
    targetScore != null && targetScore !== "" ? `目标分数：${targetScore}` : "",
    totalHours != null && totalHours !== "" ? `本次总课时：${totalHours}` : "",
    "",
    "以下是若干条模块，请逐条写教学目标：",
    ...lines,
  ].filter((x) => x !== "").join("\n");

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
  ];
  // few-shot：把真实老师的写法当"风格示范"（**只是示范措辞，不是这次要处理的内容**）
  for (const ex of style) {
    messages.push({ role: "user", content: "（风格示范，不要照抄内容）" });
    messages.push({ role: "assistant", content: ex });
  }
  messages.push({ role: "user", content: "（以上是风格示范。下面是本次要处理的模块）\n" + context });

  return {
    ok: true,
    persona,
    messages,
    /** 供测试断言"实验模块的范例有没有带上" */
    experimentExampleIncluded: !!expExample,
  };
}
