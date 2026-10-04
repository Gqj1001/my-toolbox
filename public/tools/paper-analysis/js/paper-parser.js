/**
 * 学科网「试卷分析报告」解析器 + 难度换算
 * ------------------------------------------------------------------
 * 学科网导出的报告是「试卷元数据」，没有学生数据，格式固定：
 *
 *   2026年7月28日高中数学作业          ← 试卷标题
 *   整体难度：适中                      ← 整体难度
 *   考试范围：计数原理与概率统计,函数与导数
 *   试卷题型 / 题型|数量 表
 *   试卷难度 / 难度|题数 表
 *   细目表分析 / 题号|难度系数|详细知识点 表（含「一、单选题」这类分组行）
 *   知识点分析 / 序号|知识点|对应题号 表
 *
 * 本模块把它解析成结构化数据，并把难度系数换算成老师惯用的难度标签。
 * 纯函数、无依赖，可直接在浏览器或 Node 里用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperParser = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================ 难度换算 ============================ */
  /**
   * 学科网难度系数 → 难度标签
   * 阈值来源：对 14 份真实报告反推验证 —— 「容易 c≥0.80 / 适中 c≥0.50 / 困难 c<0.50」
   * 可 100% 精确复现学科网自己输出的题数分布（13/13 份三档 + 1 份五档）。
   * 边界证据：最小"容易"系数=0.80、最大"适中"系数=0.79 ⇒ 阈值唯一解 0.80；
   *           最小"适中"系数=0.54、最大"困难"系数=0.45 ⇒ 取整 0.50。
   * 输出标签用老师报告里的惯用词（较易／中等／较难／难）。
   */
  const DIFF_LEVELS = [
    { min: 0.80, label: '较易', grade: 'easy' },
    { min: 0.50, label: '中等', grade: 'mid'  },
    { min: 0.30, label: '较难', grade: 'hard' },
    { min: -1,   label: '难',   grade: 'vh'   }
  ];
  /** 学科网自己的三档词，用于核对与还原 */
  const XKW_BANDS = [
    { min: 0.80, label: '容易' },
    { min: 0.50, label: '适中' },
    { min: -1,   label: '困难' }
  ];
  function coeffToXkw(c) {
    const v = parseFloat(c);
    if (isNaN(v)) return '';
    for (const d of XKW_BANDS) if (v >= d.min) return d.label;
    return '困难';
  }

  function coeffToLabel(c) {
    const v = parseFloat(c);
    if (isNaN(v)) return '';
    for (const d of DIFF_LEVELS) if (v >= d.min) return d.label;
    return '难';
  }
  function coeffToGrade(c) {
    const v = parseFloat(c);
    if (isNaN(v)) return '';
    for (const d of DIFF_LEVELS) if (v >= d.min) return d.grade;
    return 'vh';
  }
  /** 老师写报告时还常用「简单/容易/一般」等词，统一归一化成 3 档 */
  const LABEL_ALIAS = {
    '较易': 'easy', '简单': 'easy', '容易': 'easy', '易': 'easy',
    '中等': 'mid', '一般': 'mid', '适中': 'mid', '中档': 'mid',
    '较难': 'hard', '难': 'hard', '困难': 'hard', '高': 'hard', '偏难': 'hard'
  };
  function labelToGrade(label) {
    return LABEL_ALIAS[String(label || '').trim()] || '';
  }

  /* ============================ 题型识别 ============================ */
  /** 由题号区间与分组标题推断题型（学科网的细目表里有「一、单选题」这样的分组行） */
  const TYPE_ALIAS = {
    '单选题': '单选题', '选择题': '单选题', '单选': '单选题',
    '多选题': '多选题', '多项选择题': '多选题', '多选': '多选题',
    '填空题': '填空题', '填空': '填空题',
    '解答题': '解答题', '解答': '解答题', '大题': '解答题',
    '判断题': '判断题'
  };
  function normType(t) {
    const s = String(t || '')
      .replace(/^[一二三四五六七八九十]+\s*[、.．,，:：]\s*/, '')   // 去掉「一、」「二.」这类前缀
      .replace(/[\s　]+/g, '')
      .trim();
    return TYPE_ALIAS[s] || s;
  }

  /* ============================ 文本解析 ============================ */
  /** 把整段文本切成行，去掉 BOM、全角空格、空行 */
  function toLines(text) {
    return String(text || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ')
      .split('\n')
      .map(l => l.trim());
  }

  /** 从「| 分隔」的表格片段里解析出二维单元格（合并单元格会重复，需折叠） */
  function splitRow(line) {
    if (line.indexOf('|') < 0) return null;
    const cells = line.split('|').map(s => s.trim());
    const dedup = [];
    cells.forEach(c => { if (!dedup.length || dedup[dedup.length - 1] !== c) dedup.push(c); });
    return dedup;
  }

  /**
   * 主解析函数
   * @param {string} text 学科网报告的纯文本（从 docx 复制出来即可）
   * @returns {object} { title, overallDifficulty, scope[], typeDist[], diffDist[], questions[], knowledgeGroups[], warnings[] }
   */
  function parse(text) {
    const lines = toLines(text);
    const warnings = [];
    const res = {
      title: '', overallDifficulty: '', scope: [],
      typeDist: [], diffDist: [], questions: [], knowledgeGroups: [],
      warnings
    };

    /* --- 1. 头部三行 --- */
    let i = 0;
    // 跳过空行与语料自带的 "=== FILE: ..." 分隔行，第一个有效行即试卷标题
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      if (/^={3,}\s*FILE/.test(l)) continue;
      if (/^<TABLE>$/i.test(l)) continue;
      res.title = l; i++; break;
    }
    // 继续向下找「整体难度」「考试范围」（可能被 <TABLE> 等行隔开）
    for (let guard = 0; i < lines.length && guard < 200; i++, guard++) {
      const l = lines[i];
      if (!l) continue;
      if (/^<\/?TABLE>$/i.test(l)) continue;          // 表格标记跳过，不终止
      let m = l.match(/^整体难度\s*[:：]\s*(.*)$/);
      if (m) { res.overallDifficulty = (m[1] || '').trim(); continue; }
      m = l.match(/^考试范围\s*[:：]\s*(.*)$/);
      if (m) { res.scope = m[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean); continue; }
      if (/^试卷题型$/.test(l.replace(/\s/g, ''))) break;   // 到了正文表格，头部结束
      if (/^试卷难度$/.test(l.replace(/\s/g, ''))) break;
      if (res.title === l) continue;
      break;
    }

    /* --- 2. 定位各段标题 --- */
    const idxOf = (kw) => lines.findIndex((l, k) => k >= i && l.replace(/\s/g, '') === kw);    const iType = idxOf('试卷题型');
    const iDiff = idxOf('试卷难度');
    const iDetail = idxOf('细目表分析');
    const iKnow = idxOf('知识点分析');

    /* --- 3. 试卷题型表 --- */
    if (iType >= 0) {
      const end = [iDiff, iDetail, iKnow].filter(x => x > iType).sort((a, b) => a - b)[0] || lines.length;
      for (let k = iType + 1; k < end; k++) {
        const c = splitRow(lines[k]);
        if (!c || c.length < 2) continue;
        if (c[0] === '题型' || c[0] === '<TABLE>' || c[0] === '</TABLE>') continue;
        const n = parseInt(c[c.length - 1], 10);
        if (!isNaN(n)) res.typeDist.push({ type: normType(c[0]), count: n });
      }
    }

    /* --- 4. 试卷难度表 --- */
    if (iDiff >= 0) {
      const end = [iDetail, iKnow].filter(x => x > iDiff).sort((a, b) => a - b)[0] || lines.length;
      for (let k = iDiff + 1; k < end; k++) {
        const c = splitRow(lines[k]);
        if (!c || c.length < 2) continue;
        if (c[0] === '难度' || c[0] === '<TABLE>' || c[0] === '</TABLE>') continue;
        const n = parseInt(c[c.length - 1], 10);
        if (!isNaN(n)) res.diffDist.push({ level: c[0], count: n });
      }
    }

    /* --- 5. 细目表分析表（核心） --- */
    if (iDetail >= 0) {
      const end = iKnow > iDetail ? iKnow : lines.length;
      let curSection = '';
      for (let k = iDetail + 1; k < end; k++) {
        const raw = lines[k];
        if (!raw || /^<\/?TABLE>$/i.test(raw)) continue;

        // ① 分组标题。三种来源写法都要认：
        //    · 合并单元格重复： 「一、单选题 | 一、单选题 | 一、单选题」
        //    · 单独一行：       「一、单选题」
        //    · 单个单元格的表格行
        //    关键：splitRow 会把「连续重复值」折叠掉，所以必须先看原始单元格是否全同，
        //    否则合并写法会被误当成"单行"，把整串「一、单选题一、单选题」当成题型名。
        const rawCells = raw.split(/[|｜]/).map(s => s.trim()).filter(s => s !== '');
        const allSame = rawCells.length > 1 && rawCells.every(x => x === rawCells[0]);
        const NUM_PREFIX = /^[一二三四五六七八九十]+\s*[、.．]/;
        if ((allSame && NUM_PREFIX.test(rawCells[0])) ||
            (rawCells.length === 1 && NUM_PREFIX.test(rawCells[0]))) {
          curSection = normType(rawCells[0]);
          continue;
        }

        const c = splitRow(raw);
        // ② 表头行
        if (c && c[0] === '题号') continue;

        // ③ 题目行：兼容「题号 | 系数 | 知识点」与「题号 | 系数」（缺知识点）两种
        //    也兼容系数写成百分数（85%）或省略前导 0（.85）
        let qno = null, coefStr = null, kpStr = '';
        if (c && c.length >= 2 && /^\d+$/.test(c[0].trim())) {
          qno = parseInt(c[0], 10);
          coefStr = c[1];
          kpStr = c.slice(2).join('；');
        } else {
          // 纯文本行再用正则兜一次（应对表格线没被识别的情况）
          const m = raw.match(/^\s*(\d{1,2})\s*[|｜,，\t]\s*([0-9.]+%?)\s*(?:[|｜,，\t]\s*(.*))?$/);
          if (m) { qno = parseInt(m[1], 10); coefStr = m[2]; kpStr = m[3] || ''; }
        }
        if (qno === null) continue;

        let coef = parseFloat(String(coefStr).replace('%', ''));
        if (/%$/.test(String(coefStr))) coef = coef / 100;      // 85% → 0.85
        if (isNaN(coef)) coef = null;

        const kps = String(kpStr).split(/[;；]/).map(s => s.trim()).filter(Boolean);
        res.questions.push({
          no: qno,
          section: curSection,
          coeff: coef,
          difficulty: coef === null ? '' : coeffToLabel(coef),
          grade: coef === null ? '' : coeffToGrade(coef),
          knowledge: kps
        });
      }

      // ④ 完全没有分组标题时，按题号区间回推题型（依据试卷题型表的顺序与数量）
      if (res.questions.length && !res.questions.some(q => q.section)) {
        let cursor = 0;
        const ranges = [];
        res.typeDist.forEach(t => { ranges.push({ type: t.type, from: cursor + 1, to: cursor + t.count }); cursor += t.count; });
        res.questions.forEach(q => {
          const r = ranges.find(r => q.no >= r.from && q.no <= r.to);
          if (r) q.section = r.type;
        });
      }
    }

    /* --- 6. 知识点分析表 --- */
    if (iKnow >= 0) {
      for (let k = iKnow + 1; k < lines.length; k++) {
        const c = splitRow(lines[k]);
        if (!c || c.length < 3) continue;
        if (c[0] === '序号' || c[0] === '<TABLE>' || c[0] === '</TABLE>') continue;
        const nos = (c[2] || '').split(/[,，、]/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (nos.length) res.knowledgeGroups.push({ name: c[1], questions: nos });
      }
    }

    /* --- 7. 校验与告警 --- */
    const typeSum = res.typeDist.reduce((a, x) => a + x.count, 0);
    const qCount = res.questions.length;
    if (typeSum && qCount && typeSum !== qCount)
      warnings.push(`试卷题型表的题数合计 ${typeSum} 与细目表的题目数 ${qCount} 不一致`);
    const diffSum = res.diffDist.reduce((a, x) => a + x.count, 0);
    if (diffSum && qCount && diffSum !== qCount)
      warnings.push(`试卷难度表的题数合计 ${diffSum} 与细目表的题目数 ${qCount} 不一致`);
    if (!res.questions.length)
      warnings.push('没有解析到细目表，请确认粘贴的是学科网「试卷分析报告」的完整内容');
    res.questions.forEach(q => { if (q.coeff === null) warnings.push(`第 ${q.no} 题缺少难度系数`); });
    if (!res.title) warnings.push('没有解析到试卷标题');
    // 题号连续性
    const gap = [];
    for (let k = 1; k < res.questions.length; k++)
      if (res.questions[k].no !== res.questions[k - 1].no + 1)
        gap.push(`${res.questions[k - 1].no}→${res.questions[k].no}`);
    if (gap.length) warnings.push('题号不连续：' + gap.join('、'));

    /* --- 8. 冗余校验：是否其实是老师写的报告（防止用户粘错） --- */
    if (/失分情况及原因分析|错题分析|教学辅导建议/.test(text) && !res.questions.length)
      res.warnings.push('这看起来是「学生试卷分析表」而不是学科网的「试卷分析报告」，两者格式不同');

    return res;
  }

  /* ============================ 其他工具 ============================ */
  /** 判断一段文本属于哪一类文档 */
  function detectDocType(text) {
    const t = String(text || '');
    if (/细目表分析/.test(t) && /难度系数/.test(t)) return 'xkw';      // 学科网试卷分析报告
    if (/错题分析/.test(t) && /失分情况及原因分析/.test(t)) return 'teacher'; // 老师的试卷分析表
    if (/失分情况及原因分析/.test(t) || /教学辅导建议/.test(t)) return 'teacher';
    return 'unknown';
  }

  /** 保留旧接口：转调 assignScores */
  function inferTypeScores(typeDist, totalScore) {
    const r = assignScores(typeDist, totalScore);
    return { name: r.preset, perType: r.perType, fullScore: r.fullScore, warnings: r.warnings };
  }

  /** 由题型分布 + 总分推算每种题型的每行分值
   *  学科网报告只给「题号+难度系数+知识点」，不含分值，必须另行补齐。
   *  策略：① 指定/自动匹配到题量完全一致的卷面预设 → 用预设的每题分值
   *        ② 否则按各题型常见单题分值估算（客观题固定、解答题吸收余额），
   *           并给出告警提醒老师在界面上核对
   *  dist 的语义：[题量, 每题分值, （可选）该题型块总分]
   */
  const TYPE_PRESETS = [
    { name:'新高考 I/II 卷',   total:150, dist:{ '单选题':[8,5],           '多选题':[3,6],        '填空题':[3,5], '解答题':[5,15.4,77] } },
    { name:'北京卷',           total:150, dist:{ '单选题':[10,4],                                  '填空题':[5,5], '解答题':[6,14.17,85] } },
    { name:'北京卷（19题）',   total:150, dist:{ '单选题':[8,4],           '多选题':[3,6],        '填空题':[3,5], '解答题':[6,14.17,85] } },
    { name:'全国甲/乙卷',      total:150, dist:{ '单选题':[12,5],                                  '填空题':[4,5], '解答题':[6,11.67,70] } },
    { name:'天津卷',           total:150, dist:{ '单选题':[9,5],                                   '填空题':[6,5], '解答题':[5,15,75] } },
    { name:'上海卷',           total:150, dist:{                                  '填空题':[12,4], '单选题':[4,5], '解答题':[5,14.6,73] } }
  ];
  /** 各题型的常见单题分值（用于没有匹配预设时的估算） */
  const DEFAULT_PER = { '单选题':5, '多选题':6, '填空题':5, '判断题':4, '解答题':12 };

  /** 从预设里取某题型的 [题量, 每题分值, 块总分] */
  function presetPerOf(preset, type){
    const d = preset && preset.dist ? preset.dist[type] : null;
    if(!d) return null;
    const [n, per, blockTotal] = d;
    return { count:n, per, total: (blockTotal != null ? blockTotal : Math.round(per * n)) };
  }

  /**
   * @param {Array}  typeDist   [{type, count}]
   * @param {number} totalScore 卷面总分（默认 150）
   * @param {string} presetName 指定卷面结构（可选）
   * @returns {{perType:Object, fullScore:number, preset:string, warnings:string[]}}
   */
  function assignScores(typeDist, totalScore, presetName) {
    const total = totalScore || 150;
    const warnings = [];
    const order = ['单选题', '多选题', '填空题', '判断题', '解答题'];
    const cnt = {};
    (typeDist || []).forEach(t => { cnt[t.type] = (cnt[t.type] || 0) + t.count; });
    const types = order.filter(t => cnt[t]);

    // ---- ① 预设精确匹配（题量与题型完全一致）----
    let preset = null;
    if (presetName) preset = TYPE_PRESETS.find(p => p.name === presetName) || null;
    if (!preset) {
      preset = TYPE_PRESETS.find(p => {
        const keys = Object.keys(p.dist);
        if (keys.length !== types.length) return false;
        return types.every(t => p.dist[t] && p.dist[t][0] === cnt[t]);
      }) || null;
    }
    if (presetName && preset && !types.every(t => preset.dist[t] && preset.dist[t][0] === cnt[t])) {
      warnings.push(`指定的结构「${preset.name}」与实际题量不符，已改用常见单题分值估算`);
      preset = null;
    }

    const perType = {};
    if (preset) {
      types.forEach(type => {
        const info = presetPerOf(preset, type);
        if(!info) return;
        perType[type] = {
          per: info.per,
          count: cnt[type],
          total: info.total,
          spread: Array.from({length: cnt[type]}, () => info.per)
        };
      });
      // 若卷面总分不是 150（预设按 150 定），按比例缩放并补齐尾差
      let sum = types.reduce((a,t)=> a + perType[t].total, 0);
      if(sum !== total && sum > 0){
        const k = total / sum;
        types.forEach(t => {
          const it = perType[t];
          it.per = Math.round(it.per * k * 100) / 100;
          it.total = Math.round(it.per * it.count);
          it.spread = Array.from({length: it.count}, () => it.per);
        });
        sum = types.reduce((a,t)=> a + perType[t].total, 0);
        if(sum !== total){
          const key = cnt['解答题'] ? '解答题' : types[types.length-1];
          perType[key].total += (total - sum);
          perType[key].per = Math.round(perType[key].total / perType[key].count * 100) / 100;
          perType[key].spread = Array.from({length: perType[key].count}, () => perType[key].per);
        }
      }
    } else {
      // ---- ② 按常见单题分值估算，解答题吸收余额 ----
      let fixed = 0;
      const objTypes = types.filter(t => t !== '解答题');
      objTypes.forEach(t => {
        const per = DEFAULT_PER[t] || 5;
        const tot = per * cnt[t];
        perType[t] = { per, count: cnt[t], total: tot };
        fixed += tot;
      });
      if (cnt['解答题']) {
        let rest = total - fixed;
        let per = rest / cnt['解答题'];
        if (per < 8) {                       // 客观题占比过高，等比压缩客观题
          objTypes.forEach(t => {
            const np = Math.max(3, Math.round(perType[t].per * 0.7));
            perType[t].per = np; perType[t].total = np * perType[t].count;
          });
          fixed = objTypes.reduce((a, t) => a + perType[t].total, 0);
          rest = total - fixed;
          per = rest / cnt['解答题'];
        }
        // 单题分值取整分配：保证「每题分值 × 题数 = 块总量」严格成立
        // （否则 9.38×8=75.04 这类尾差会污染整份报告）
        const n = cnt['解答题'];
        const base = Math.floor(rest / n), extra = Math.round(rest) - base * n;
        perType['解答题'] = { per: base + (extra > 0 ? 1 : 0), count: n,
                              total: Math.round(rest),
                              spread: Array.from({length:n}, (_, i) => base + (i < extra ? 1 : 0)) };
      }
      // 校正合计到总分（差额补进解答题，同时同步单题分值）
      let sum = types.reduce((a, t) => a + perType[t].total, 0);
      if (sum !== total) {
        const key = cnt['解答题'] ? '解答题' : types[types.length - 1];
        perType[key].total += (total - sum);
        const k = perType[key].count;
        const b2 = Math.floor(perType[key].total / k), e2 = Math.round(perType[key].total) - b2 * k;
        perType[key].per = b2 + (e2 > 0 ? 1 : 0);
        perType[key].spread = Array.from({length:k}, (_, i) => b2 + (i < e2 ? 1 : 0));
        sum = types.reduce((a, t) => a + perType[t].total, 0);
      }
      warnings.push('未能匹配到标准卷面结构，分值按常见单题分值估算，请在界面上核对每道题的分值');
    }

    // 次序整理
    const ordered = {};
    order.forEach(t => { if (perType[t]) ordered[t] = perType[t]; });

    // ③ 兜底：任何题型都必须有分值，否则后面排课/统计会缺项
    const missing = types.filter(t => !ordered[t]);
    if (missing.length){
      // 先按常见单题分值给出，再让解答题（或最后一个题型）吸收与总分的差额
      missing.forEach(t => {
        const per = DEFAULT_PER[t] || 5;
        ordered[t] = { per, count: cnt[t], total: per * cnt[t],
                       spread: Array.from({length: cnt[t]}, () => per) };
      });
      let sum = Object.keys(ordered).reduce((a,t)=> a + ordered[t].total, 0);
      if(sum !== total){
        const key = ordered['解答题'] ? '解答题' : Object.keys(ordered)[Object.keys(ordered).length-1];
        const it = ordered[key];
        const want = it.total + (total - sum);
        if(want > 0){
          const n = it.count;
          const base = Math.floor(want / n), extra = Math.round(want) - base * n;
          it.per = base + (extra > 0 ? 1 : 0);
          it.total = Math.round(want);
          it.spread = Array.from({length:n}, (_, i) => base + (i < extra ? 1 : 0));
        }
      }
      warnings.push('部分题型未在卷面结构预设里定义，已按常见单题分值补齐，请核对分值');
    }

    // 再按 order 排序一次
    const final = {};
    order.forEach(t => { if (ordered[t]) final[t] = ordered[t]; });
    Object.keys(ordered).forEach(t => { if(!final[t]) final[t] = ordered[t]; });

    const fullScore = Object.keys(final).reduce((a, t) => a + final[t].total, 0);
    if (fullScore !== total) warnings.push(`各题型分值和为 ${fullScore}，与总分 ${total} 不一致`);
    return { perType: final, fullScore, preset: preset ? preset.name : '按常见单题分值估算', warnings };
  }

  /** 汇总统计：按难度分档的得分情况、按题型的得分情况 */
  function summarize(paper, student) {
    const q = paper.questions || [];
    const rec = (student && student.records) || {};
    const out = {
      total: { n: q.length, full: 0, got: 0, rate: 0 },
      byType: {}, byDiff: {}, byKnowledge: {}, lost: [], blank: [], weak: []
    };
    const typeOf = (x) => x.section || '未分类';
    q.forEach(x => {
      const r = rec[x.no] || {};
      const full = num(r.full), got = num(r.got);
      out.total.full += full; out.total.got += got;
      const t = typeOf(x);
      out.byType[t] = out.byType[t] || { n: 0, full: 0, got: 0 };
      out.byType[t].n++; out.byType[t].full += full; out.byType[t].got += got;
      const d = x.difficulty || '未标注';
      out.byDiff[d] = out.byDiff[d] || { n: 0, full: 0, got: 0 };
      out.byDiff[d].n++; out.byDiff[d].full += full; out.byDiff[d].got += got;
      if (full > 0 && got < full) {
        out.lost.push(x.no);
        if (got === 0) out.blank.push(x.no);
      }
      // 知识点维度
      (x.knowledge || []).forEach(k => {
        out.byKnowledge[k] = out.byKnowledge[k] || { n: 0, full: 0, got: 0, qs: [] };
        out.byKnowledge[k].n++; out.byKnowledge[k].full += full;
        out.byKnowledge[k].got += got; out.byKnowledge[k].qs.push(x.no);
      });
    });
    out.total.rate = out.total.full ? out.total.got / out.total.full : 0;
    Object.values(out.byType).forEach(v => v.rate = v.full ? v.got / v.full : 0);
    Object.values(out.byDiff).forEach(v => v.rate = v.full ? v.got / v.full : 0);
    Object.values(out.byKnowledge).forEach(v => v.rate = v.full ? v.got / v.full : 0);
    return out;
  }
  function num(x) { const v = parseFloat(x); return isNaN(v) ? 0 : v; }

  return {
    parse, detectDocType, coeffToLabel, coeffToGrade, labelToGrade, coeffToXkw,
    normType, inferTypeScores, assignScores, TYPE_PRESETS,
    summarize, DIFF_LEVELS, XKW_BANDS, LABEL_ALIAS
  };
}));
