/**
 * 试卷分析报告 · 叙事生成器
 * ------------------------------------------------------------------
 * 把「学科网试卷元数据 + 学生逐题作答 + 学情描述」组装成老师惯用的
 * 《锐满分教育试卷分析表》结构：
 *   学员基本信息 → 试卷分析（含题型分布） → 错题分析 → 教学辅导建议/安排 → 签字栏
 *
 * 三种建议段骨架（逆向自 16 份真实报告）：
 *   I  单段叙事式    低分 / 入学测，600–900 字
 *   II 多段带小标题  常规阶段测，1200–1500 字
 *   III 结课测分析式 结课测 / 综合卷，1600–2100 字，含逐题举证
 * 纯函数、无依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Narrator = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 小工具 ---------------- */
  const j = (a, sep) => (a && a.length ? a.join(sep || '、') : '');
  const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  /** 优势表述库：按模块名给出"该模块掌握较好"的说法 */
  const STRONG_PHRASE = {
    '三角函数与解三角形': '三角恒等变换与解三角形的公式应用熟练',
    '立体几何与空间向量': '立体几何的基础证明与体积计算能完成',
    '导数及其应用': '导数基础求导与切线方程掌握扎实',
    '数列': '等差等比的通项与求和公式记忆准确',
    '平面向量': '平面向量的坐标运算与数量积稳定',
    '平面解析几何': '圆与直线的基础运算准确，圆锥曲线第一问能拿分',
    '概率与统计': '概率统计模块完成度最高，分布列与期望能稳定得分',
    '等式与不等式': '基本不等式与一元二次不等式的解法掌握较好',
    '计数原理与二项式': '排列组合与二项式的基础题型能独立完成',
    '集合与常用逻辑用语': '集合运算与充要条件判断零失误',
    '复数': '复数四则运算与模的计算准确',
    '函数概念与性质': '函数定义域、值域与基础性质判断扎实',
    '其他': '基础题型的模仿与主干公式的直接调用较为熟练'
  };
  /** 短板表述库 */
  const WEAK_PHRASE = {
    '三角函数与解三角形': '解三角形的中档综合题方法不成体系',
    '立体几何与空间向量': '空间向量法解题流程未建立，证明题步骤不规范',
    '导数及其应用': '含参分类讨论与恒成立问题思路不清，知识体系尚未建立',
    '数列': '递推转化与错位相减、裂项求和等核心方法不熟练',
    '平面向量': '向量的几何转化与综合应用能力不足',
    '平面解析几何': '联立与韦达定理的运算能力不足，圆锥曲线综合题方法不成体系',
    '概率与统计': '事件设定与步骤书写不规范，复杂概型辨析不精准',
    '等式与不等式': '含参不等式的分类讨论不完整，边界条件考虑不全',
    '计数原理与二项式': '分类分步的计数逻辑不清晰，容易重复或遗漏',
    '集合与常用逻辑用语': '空集、端点等细节陷阱容易失分',
    '复数': '复数概念细节与分母实数化运算偶有失误',
    '函数概念与性质': '函数性质的综合迁移能力不足，多性质结合即卡壳',
    '其他': '基础概念记忆存在漏洞，中档综合题普遍畏难'
  };
  const strongOf = (n) => STRONG_PHRASE[n] || STRONG_PHRASE['其他'];
  const weakOf = (n) => WEAK_PHRASE[n] || WEAK_PHRASE['其他'];

  /* ==================== 一、逐题归因表（错题分析） ==================== */
  /**
   * 生成错题分析表的行：题号|题型|分值|得分|难度|考察知识点|失分情况及原因分析
   * 注意：老师是「全卷逐题过」，全对的行原因栏写"无"
   */
  function buildQuestionRows(paper, records, diags) {
    const byNo = {};
    (diags || []).forEach(d => byNo[d.no] = d);
    return (paper.questions || []).map(q => {
      const r = (records || {})[q.no] || {};
      const full = num(r.full), got = num(r.got);
      const d = byNo[q.no];
      return {
        no: q.no,
        type: q.section || '',
        full, got,
        difficulty: q.difficulty || '',
        knowledge: (q.knowledge || []).join('；'),
        reason: (full > 0 && got >= full) ? '无' : (d ? d.text : '无')
      };
    });
  }

  /**
   * 题型分布表的数据：统计「全卷」每一道题，而不是只统计错题
   * @returns [{type, n, full, got, lost, rate}]
   */
  function buildTypeSummary(paper, records) {
    const ORDER = ['单选题', '多选题', '填空题', '判断题', '解答题'];
    const map = {};
    (paper.questions || []).forEach(q => {
      const r = (records || {})[q.no] || {};
      const full = num(r.full), got = num(r.got);
      const t = q.section || '未分类';
      const m = map[t] || (map[t] = { type: t, n: 0, full: 0, got: 0, lost: 0 });
      m.n++; m.full += full; m.got += got; m.lost += (full - got);
    });
    const list = Object.values(map);
    list.forEach(m => m.rate = m.full ? m.got / m.full : 0);
    list.sort((a, b) => {
      const ia = ORDER.indexOf(a.type), ib = ORDER.indexOf(b.type);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return list;
  }

  /* ==================== 二、整卷证据链 ==================== */
  /** 从汇总里挑出"优势模块 / 薄弱模块 / 可提分模块" */
  function polarize(modules) {
    const strong = [], weak = [], mid = [];
    (modules || []).forEach(m => {
      if (m.rate >= 0.85) strong.push(m);
      else if (m.rate < 0.5) weak.push(m);
      else mid.push(m);
    });
    strong.sort((a, b) => b.rate - a.rate);
    weak.sort((a, b) => b.lost - a.lost);
    mid.sort((a, b) => b.lost - a.lost);
    return { strong, weak, mid };
  }

  /** 找出口径：全对/近满分的板块 */
  function perfectBlocks(typeAgg) {
    return (typeAgg || []).filter(t => t.full > 0 && t.lost === 0).map(t => t.type);
  }

  /* ==================== 三、建议段三骨架 ==================== */
  /**
   * @param {object} ctx
   *  ctx.name 学生姓名   ctx.score 得分   ctx.full 满分
   *  ctx.band 分数段对象 ctx.skeleton 骨架对象
   *  ctx.questionRows 逐题行   ctx.modules 模块聚合   ctx.typeAgg 题型聚合
   *  ctx.diags 归因列表   ctx.teacherNote 老师补充说明
   *  ctx.examType 考试类型   ctx.subject 科目
   */
  function buildAdvice(ctx) {
    const { name, score, full, band, questionRows, modules, typeAgg, diags } = ctx;
    // 称呼：直接用姓名，避免出现"XX同学同学"
    const N = name || '该生';
    const { strong, weak, mid } = polarize(modules);
    const lost = (full || 150) - score;
    const perfect = perfectBlocks(typeAgg);
    const weakNames = weak.slice(0, 4).map(m => m.name);
    const strongNames = strong.slice(0, 3).map(m => m.name);
    // 最该先动手的模块：可提分模块(中档)优先，其次薄弱模块
    const targetMods = mid.concat(weak);
    const L = [];

    /* ---------- 定性 + 优势 ---------- */
    const hasStrong = strongNames.length > 0;
    const strongTxt = hasStrong
      ? strongNames.map(m => `${m}（${strongOf(m)}）`).join('、') + '这几个板块掌握相对稳定'
      : '各模块都还存在不同程度的漏洞';
    const perfectTxt = perfect.length ? `，其中${j(perfect)}整块零失误` : '';
    const strongPrefix = hasStrong ? '从作答情况看，' : '从作答情况看，';

    L.push(`${N}本次${ctx.examType || '测试'}得分 ${score} 分（满分 ${full} 分），${band.stage}。`
      + `${strongPrefix}${strongTxt}${perfectTxt}，`
      + `主干知识的基本框架${hasStrong ? '已经具备' : '尚未成型'}，学习态度方面${ctx.attitude || '整体认真、愿意动笔'}，这是后续提分最重要的基础。`);

    /* ---------- 核心问题（按题型分块，老师习惯） ---------- */
    const typeLines = [];
    (typeAgg || []).forEach(t => {
      if (t.lost <= 0) return;
      const rate = (t.rate * 100).toFixed(0);
      // 注意：' 等' 前面的空格要留（题号列举后需要空格），后面的空格不能有；
      // 模板里也不能再写 `${qs} 题`，否则会输出"第 22 等 题"
      const qs = t.questions.length > 6 ? t.questions.slice(0, 6).join('、') + ' 等' : t.questions.join('、');
      const topTypes = Object.keys(t.types).sort((a, b) => t.types[b] - t.types[a]).slice(0, 2);
      typeLines.push(`${t.type}得分率仅 ${rate}%，失分 ${t.lost} 分（第 ${qs}题），主要归因为${j(topTypes, '与')}`);
    });
    if (typeLines.length) {
      L.push('');
      L.push('本次测试暴露的问题按题型看比较清晰：' + typeLines.join('；') + '。');
    }

    /* ---------- 逐模块短板（骨架 II/III 展开） ---------- */
    if (weak.length) {
      const items = weak.slice(0, 4).map((m, i) => {
        const qs = m.questions.length > 5 ? m.questions.slice(0, 5).join('、') + ' 等' : m.questions.join('、');
        return `${cn[i]}是${m.name}（失分 ${m.lost} 分，题号 ${qs}），${weakOf(m.name)}`;
      });
      L.push('');
      L.push('核心薄弱板块集中在以下 ' + Math.min(weak.length, 4) + ' 处：' + items.join('；') + '。');
    }

    /* ---------- 做题习惯（有证据才写） ---------- */
    const habit = [];
    const blank = (questionRows || []).filter(r => r.full > 0 && r.got === 0);
    if (blank.length >= 2) habit.push(`${blank.length} 道题（第 ${blank.slice(0, 6).map(r => r.no).join('、')} 题）完全没有动笔，属于直接的整题失分`);
    const asType = {};
    (diags || []).forEach(d => d.types.forEach(t => asType[t] = (asType[t] || 0) + 1));
    if (asType['运算失误']) habit.push(`有 ${asType['运算失误']} 处失分源于运算失误，"会做但算不对"是最可惜的丢分方式`);
    if (asType['审题与条件遗漏']) habit.push(`${asType['审题与条件遗漏']} 处失分与审题不细、条件遗漏有关`);
    if (asType['逻辑与分类讨论']) habit.push(`${asType['逻辑与分类讨论']} 处涉及分类讨论不完整或推导逻辑不严谨，步骤分流失明显`);
    if (asType['答题策略与节奏']) habit.push('多选题存在漏选、错选，逐项验证的意识还不足');
    if (asType['概念混淆']) habit.push(`${asType['概念混淆']} 处属于概念边界辨析不清`);
    if (habit.length) {
      L.push('');
      L.push('需要特别指出的作答习惯问题：' + habit.join('；') + '。这些属于非知识性失分，纠正起来见效最快。');
    }

    /* ---------- 下一步（分阶段） ---------- */
    L.push('');
    if (ctx.skeleton && ctx.skeleton.id === 'I') {
      // 单段叙事："首先…其次…第三…第四…最后…"
      const steps = [];
      steps.push(`首先要立足现有基础，优先补齐高频失分的基础模块，针对${j(targetMods.slice(0, 3).map(m => m.name)) || '基础模块'}这些单点知识集中开展专项基础训练，把送分题的正确率先提上来`);
      const tw = weak.length ? weak : targetMods;
      if (tw.length) steps.push(`其次重点突破${j(tw.slice(0, 2).map(m => m.name))}这两大性价比最高的板块，` + tw.slice(0, 2).map(m => m.advice).join('；'));
      steps.push(`第三要逐步克服畏难情绪，解答题从第一问基础设问入手，哪怕只写公式和第一步推导也要动笔，先积累"能拿步骤分"的信心`);
      steps.push(`第四要规范答题步骤，对照评分标准写全关键推导，杜绝跳步导致的步骤分流失`);
      steps.push(`最后把每次的错题按"概念没记住／方法没掌握／计算失误"分类整理，定期回看复盘，避免同一个知识点反复出错`);
      L.push('下一阶段学习，' + steps.map(s => s + '；').join('').replace(/；$/, '。'));
    } else {
      L.push('下一步的提升路径：');
      // 短期 / 中期 两段
      const short = [];
      if (targetMods.length) short.push(`优先补齐${j(targetMods.slice(0, 3).map(m => m.name))}的中档题型，把每道解答题的前两问分数拿满`);
      if (weak.length) short.push(`针对${weak[0].name}${weak[0].advice}`);
      if (asType['运算失误']) short.push('每天安排 10–15 分钟计算专项（求导、通分、联立、数列求和），关键步骤回代验算');
      if (asType['答题策略与节奏'] || asType['审题与条件遗漏']) short.push('用"审题三圈"法（圈关键词、圈约束条件、圈所求目标）并在解完回读题干，多选题强制写出每个选项的对错依据');
      short.push(`固定时间分配：选填控制在 40–45 分钟，留 5 分钟专查符号、区间与化简`);
      L.push(`短期（1–2 个月，补漏洞、稳基础）：${short.map((s, i) => `${cn[i]}是${s}`).join('；')}。`);

      const longTerm = [];
      if (weak.length > 1) longTerm.push(`逐个攻克${j(weak.slice(1, 4).map(m => m.name))}，每个模块建立标准化解题模板`);
      else if (mid.length) longTerm.push(`把${j(mid.slice(0, 3).map(m => m.name))}从"能做对"推进到"稳定拿满"`);
      longTerm.push('每类题型精练 5–8 道典型题并整理成模板卡，形成"看到题就知道走哪条路"的条件反射');
      longTerm.push('定期用限时套卷检验，把失分按"知识／方法／运算／规范／策略"五类统计，逐类清零');
      L.push(`中期（3–6 个月，攻中档、破压轴）：${longTerm.map((s, i) => `${cn[i]}是${s}`).join('；')}。`);
    }

    /* ---------- 预期 ---------- */
    L.push('');
    L.push(`${band.expect}。${band.forbid}。`
      + `按目前失分结构看，最直接的提分空间来自${j(targetMods.slice(0, 2).map(m => m.name)) || '中档题型'}，`
      + `把这一块的分拿稳，总分提升 ${lost >= 40 ? '20–30' : lost >= 20 ? '10–20' : '5–10'} 分是比较现实的目标。`);

    if (ctx.teacherNote) {
      L.push('');
      L.push(ctx.teacherNote);
    }
    return L.join('\n');
  }

  /* ==================== 四、整份报告 ==================== */
  function buildReport(ctx) {
    const { name, gender, grade, subject, paper, score, full, examDate, examName,
            duration, examScope, taughtContent, progress, band, questionRows,
            advice, teacher, manager } = ctx;
    // 题型分布用「全卷」统计（不是只统计错题）
    const typeAgg = ctx.typeSummary || buildTypeSummary(paper, ctx.records || {});
    const out = [];
    const P = (s) => out.push(s == null ? '' : String(s));
    const R = (x) => Math.round(num(x) * 100) / 100;      // 去掉浮点尾差
    const scoreR = R(score), fullR = R(full);

    /* ---- 标题 ---- */
    P('锐满分教育试卷分析表');
    P('学员基本信息');

    /* ---- 表1：学员基本信息 ---- */
    P('【学员基本信息】');
    P(`学生姓名：${name || '＿＿＿＿'}　　性别：${gender || '＿＿'}　　年级：${grade || '＿＿'}　　学校：＿＿＿＿　　班级：＿＿＿＿`);
    P(`学管师：${manager || '＿＿＿＿'}　　教师：${teacher || '郭庆杰'}　　辅导科目：${subject || '数学'}　　测试得分：${scoreR}`);
    P('能力维度：' + ['知识储备','学习规划','学习动力','学习习惯','学习能力','应试能力','自控能力','成绩趋势','补习频次'].join('　'));
    P('');

    /* ---- 表2：试卷分析 ---- */
    P('【试卷分析】');
    P(`考试时间：${examDate || '＿＿＿＿'}　　考试名称：${examName || '＿＿＿＿'}　　考试科目：${subject || '数学'}　　考试时长：${duration || '120min'}`);
    P(`试卷总分：${fullR}　　试卷得分：${scoreR}　　试卷难度：${paper.overallDifficulty || '中等'}　　试卷质量：＿＿　　试卷来源：＿＿`);
    P(`考试范围：${examScope || j((paper.scope || [])) || '＿＿'}`);
    P(`授课内容：${taughtContent || '＿'}`);
    P(`学生进步点：${progress || deriveProgress(ctx)}`);
    P('');
    P('题　型　分　布');
    P('题型 | 题目数量 | 难度 | 总分值 | 得分');
    typeAgg.forEach(t => {
      P(`${t.type} | ${t.n} | ${paper.overallDifficulty || '中等'} | ${R(t.full)} | ${R(t.got)}`);
    });
    P(`合计 | ${typeAgg.reduce((a, t) => a + t.n, 0)} | — | ${R(typeAgg.reduce((a, t) => a + t.full, 0))} | ${R(typeAgg.reduce((a, t) => a + t.got, 0))}`);
    P('');

    /* ---- 表3：错题分析（全卷逐题） ---- */
    P('【错题分析】');
    P('题号 | 题型 | 分值 | 得分 | 难度 | 考察知识点 | 失分情况及原因分析');
    (questionRows || []).forEach(r => {
      P(`${r.no} | ${r.type} | ${R(r.full)} | ${R(r.got)} | ${r.difficulty} | ${r.knowledge} | ${r.reason}`);
    });
    P('');

    /* ---- 教学辅导建议 / 安排 ---- */
    P('【教学辅导建议/安排】');
    P(advice);
    P('');

    /* ---- 签字栏 ---- */
    P(`分析人：${teacher || '郭庆杰'}　　学管师：${manager || '＿＿＿'}　　家长签字：＿＿＿＿＿＿`);
    return out.join('\n');
  }

  /** 自动推导"学生进步点"：全对板块 + 高得分率模块 */
  function deriveProgress(ctx) {
    const { typeAgg, modules } = ctx;
    const perfect = perfectBlocks(typeAgg);
    const { strong } = polarize(modules);
    const bits = [];
    if (perfect.length) bits.push(`${j(perfect)}全部得分`);
    if (strong.length) bits.push(`${j(strong.slice(0, 2).map(m => m.name))}得分率较高`);
    if (!bits.length) return '知识掌握较快，但需多加巩固，提升计算准确率';
    return bits.join('，') + '，学习态度端正，需继续巩固已会内容';
  }

  function num(x) { const v = parseFloat(x); return isNaN(v) ? 0 : v; }

  return { buildAdvice, buildReport, buildQuestionRows, buildTypeSummary, deriveProgress, polarize };
}));
