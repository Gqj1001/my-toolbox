/**
 * 失分归因引擎 + 报告叙事生成
 * ------------------------------------------------------------------
 * 逆向自老师 16 份手写《试卷分析》：
 *   · 显式写「失分类型为 X」的只有 4.5%，其余靠高度程式化的措辞承载 → 必须靠特征判定
 *   · 失分类型是「一级分类（可并列2个）+ 二级细化 + 严重度副词」三层结构
 *   · 归因随题型变化：单选/填空走"知识点+能力"短句；多选必带"漏选/逐项验证"；
 *     解答题必走"第一问…第二问…"分问复盘
 *   · 建议段有三种骨架，按分数段与卷型分派
 * 纯函数、无依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ErrorEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================================
     一、失分类型分类体系（11 类）
     key     程序内部标识
     name    写进报告的一级标签（老师原词）
     feat    判定特征（正则）
     root    是否更可能是"根本原因"（决定并列时的前后位）
     phrase  该类型的典型措辞（用于组句）
     advice  对应教学对策
     ====================================================================== */
  const TYPES = [
    { key:'knowledge', name:'知识漏洞', root:true, weight:3,
      feat:/不会|未掌握|没掌握|未建立|未形成|想不起来|记不清|记错|遗忘|模糊|残缺|零散|空白|不会做|完全没|未作答|未完成|不懂|概念不清|知识点不牢|体系未|基础不牢|未学|没学|不熟(?!练)/,
      phrase:'{topic}的知识体系尚未建立，基础概念与公式还存在漏洞',
      advice:'回归课本把{topic}的核心概念与公式逐条过关，每模块配套 10–15 道基础题巩固，错题重做' },

    { key:'concept', name:'概念混淆', root:true, weight:3,
      feat:/混淆|理解偏差|理解不透|边界|取值范围.*错|概念.*错误|误将|误认|判错|辨析|定义.*弄错|性质.*记错|边角|细节疏漏/,
      phrase:'对{topic}的概念边界理解不透彻，把相似定义弄混了',
      advice:'整理{topic}的概念辨析清单，每个考点写清"对的依据、错的反例"，配变式判断题' },

    { key:'calc', name:'运算失误', root:true, weight:2,
      feat:/计算|算错|运算|粗心|失误|笔误|符号错|化简.*错|通分|求导.*错|代入.*错|算不对|结果.*错|数值|口算|低级错误/,
      phrase:'思路方向是对的，但{topic}环节的运算出现失误，属于"会做但算不对"',
      advice:'每天 10–15 分钟计算专项（求导、通分、联立、数列求和），关键步骤回代验算，草稿纸分区标号' },

    { key:'logic', name:'逻辑与分类讨论', root:true, weight:3,
      feat:/分类讨论|讨论不完整|讨论不全|讨论不严谨|逻辑(?:不|混乱|链条|跳跃)|推导不(?:清|严|完整)|论证不严|严谨性|条件缺|不闭环|(?:出现|存在|有)断层|以偏概全|范围(?:考虑|讨论)?不(?:全|完整)/,
      phrase:'{topic}的分类讨论不完整、推导逻辑链条有断裂',
      advice:'把{topic}的讨论流程固化成模板（求导通分→找零点→比较定义域边界→分情况写结论），先写依据再写结论' },

    { key:'read', name:'审题与条件遗漏', root:true, weight:3,
      // 注意：用「不跨句号/分号」而不是「不跨逗号」——例如
      //   "忽略"夹角为锐角需点积大于 0 且向量不共线"的双重约束"
      // 这类表述中间带逗号，跨逗号才算命中
      feat:/审题|漏[^。；！？]{0,8}条件|漏条件|看错|没看清|未看清|忽略[^。；！？]{0,30}(?:约束|条件|限制|要求|范围)|多解[^。；！？]{0,8}舍|未结合范围|遗漏[^。；！？]{0,10}(?:条件|约束|解|情况)|陷阱|最小值[^。；！？]{0,6}最大值|把[^。；！？]{0,10}误(?:作|当)|条件(?:遗漏|看漏|未考虑)/,
      phrase:'{topic}的条件读漏了，导致解题方向或结果出现偏差',
      advice:'用"审题三圈"法（圈关键词、圈约束条件、圈所求目标），解完回读题干检查多解与范围' },

    { key:'method', name:'方法缺失', root:true, weight:3,
      feat:/方法.*缺|没有思路|无从下手|不知道.*怎么|未掌握通法|不成体系|思路.*断|框架.*缺|没.*模板|不会.*流程|找不到.*方法|想不到/,
      phrase:'{topic}缺标准化的解题流程，知道知识点但调不出方法',
      advice:'为{topic}固化"第一步…第二步…第三步…"的解题模板，每类题型精练 5–8 道并做模板卡' },

    { key:'fear', name:'畏难留白', root:false, weight:2,
      feat:/畏难|不敢|放弃|留白|空白|未动笔|没动笔|抵触|没写|空着|不敢尝试|心理|预设.*放弃|跳过/,
      phrase:'{topic}存在畏难情绪，整题留白或只写了开头',
      advice:'大题从第一问基础设问入手，强制"哪怕只写公式和第一步推导也要动笔"，分步给分及时鼓励' },

    { key:'practice', name:'训练量不足', root:false, weight:2,
      feat:/不熟练|熟练度|不扎实|训练|练习.*少|经验不足|做得慢|速度|做不完|时间不够|来不及|欠练|生疏/,
      phrase:'{topic}的方法知道但不够熟练，速度和稳定性都还不足',
      advice:'{topic}定时定量专项训练（每模块 5–8 道），加限时小题训练，同类变式反复练' },

    { key:'transfer', name:'综合迁移能力不足', root:false, weight:2,
      feat:/综合|迁移|结合|多考点|跨模块|灵活|变式.*不会|融合|联动|孤立|多结论|综合运用/,
      phrase:'单一考点能做对，{topic}多考点融合时就卡壳',
      advice:'做{topic}的跨模块综合训练，配合多选题"逐项独立验证 + 反例排除"，练一题多解' },

    { key:'prelim', name:'预科未学', root:false, weight:1,
      feat:/预科|未学|新学|刚接触|入门阶段|还没学|超前|进度未到|高一升高二/,
      phrase:'{topic}属于预科新学内容，目前尚处入门阶段，属于正常的初期状态',
      advice:'{topic}降级处理，先跟校内进度同步夯实，暑假/假期再安排专项巩固' },

    { key:'strategy', name:'答题策略与节奏', root:false, weight:2,
      feat:/策略|取舍|时间分配|答题顺序|漏选|错选|多选|保分|不敢选|犹豫|节奏|检查|验算|草稿|涂改|放弃.*最后|先做.*后做/,
      phrase:'{topic}的答题策略不够成熟，出现漏选/错选或时间分配失当',
      advice:'多选题按"先标确定项→再析犹豫项→综合取舍"操作；固定时间分配（选填 40–45 分钟），留 5 分钟专查符号与范围' }
  ];

  /* ======================================================================
     二、分数段口径（逆向自 16 份实测：满分 150）
     ====================================================================== */
  const BANDS = [
    { min: 0,   max: 49,  key:'weak',
      stage:'属于数学基础薄弱层级，知识体系整体处于未搭建完成的状态',
      level:'态度认真但基础薄弱，知识漏洞多、解题方法缺',
      strategy:'先补基础、死守送分题、强制动笔',
      order:['集合','复数','平面向量','三角函数与解三角形','计数原理与二项式'],
      forbid:'不要急于刷难题、套卷，先跟着一轮复习进度逐个模块补基础',
      expect:'把基础知识点逐个补牢、基础题正确率提上来后，分数会实现非常明显的稳步提升' },

    { min: 50,  max: 74,  key:'base',
      stage:'处于基础偏弱水平，知识体系存在多处明显断层，做题习惯与思维方式均有较大提升空间',
      level:'基础题有得分、中档题漏洞多、难题普遍放弃',
      strategy:'补基础漏洞 + 攻性价比最高的两道解答题 + 克服畏难',
      order:['立体几何与空间向量','三角函数与解三角形','计数原理与二项式','概率与统计'],
      forbid:'暂不接触压轴题，先把中档以下的分拿稳',
      expect:'守住基础分、攻下两道主力解答题后，总分会有明显台阶式提升' },

    { min: 75,  max: 99,  key:'mid',
      stage:'处于中等水平，正处于"基础能保、中档不稳、压轴全丢"的典型过渡期状态',
      level:'基础有框架、中档待突破、压轴未入门',
      strategy:'保基础、攻多选、破综合三位一体；中档题准确率优先，压轴只练第一问',
      order:['平面解析几何','导数及其应用','函数概念与性质','数列','计数原理与二项式'],
      forbid:'现阶段不急于攻压轴第三问，重点把每道解答题的前两问分数拿满',
      expect:'中档题准确率提升后，有望稳定进入 110 分以上区间' },

    { min: 100, max: 124, key:'good',
      stage:'处于中等偏上水平，主干知识框架已基本搭建完成，整体处于基础题稳定、中档题有疏漏、压轴题待突破的阶段',
      level:'基础题稳定、中档题有疏漏、压轴题待突破',
      strategy:'补全小题漏洞、提升中档题准确率、逐步攻坚压轴题（分短期/中期排期）',
      order:['导数及其应用','平面解析几何','立体几何与空间向量','概率与统计'],
      forbid:'不再重复刷大量基础题，把时间投到中档题准确率与压轴模板上',
      expect:'补全小题漏洞并攻克压轴常规问后，有望突破 125 分' },

    { min: 125, max: 999, key:'top',
      stage:'处于中上游水平，具备冲击高分段的扎实基础，整体属于"基础全对、中档满分、压轴有潜力、多选待突破"的阶段',
      level:'基础全对、中档满分、压轴有潜力、多选待突破',
      strategy:'不刷基础题；专攻多选题概念细节 + 压轴步骤分 + 非知识性失分管控',
      order:['计数原理与二项式','概率与统计','导数及其应用','平面解析几何'],
      forbid:'不再重复刷基础题',
      expect:'解决多选题细节与压轴步骤分后，有望稳定在 135 分以上' }
  ];

  function bandOf(score, full) {
    const f = full || 150;
    const norm = score / f * 150;
    for (const b of BANDS) if (norm >= b.min && norm <= b.max) return b;
    return BANDS[BANDS.length - 1];
  }

  /* ======================================================================
     三、报告骨架（3 种，按卷型与分数段分派）
     ====================================================================== */
  const SKELETONS = {
    I:  { id:'I',  name:'单段叙事式',
          when:'入学测 / 专题测，篇幅中等（600–900 字）',
          sections:['定性优势','核心问题','下一步（首先…其次…第三…第四…最后）'] },
    II: { id:'II', name:'多段带小标题式',
          when:'常规阶段测，篇幅较长（1200–1500 字）',
          sections:['整体定性','优势板块','核心薄弱板块','现存做题陋习','思维短板','分阶段建议'] },
    III:{ id:'III',name:'结课测分析式',
          when:'结课测 / 综合卷，篇幅最长（1600–2100 字），含逐题举证',
          sections:['整体定性','优势逐题举证','短板逐条举证','教学建议与提升方案','短期安排','常态化学习与家长配合','预期分数'] }
  };
  /**
   * 选择建议段骨架
   * 用 includes 而非精确相等 —— 老师填的可能是「10月月考·结课测」
   * 「结课测试」「高考模拟」这类带修饰的说法，精确匹配会漏掉。
   */
  function pickSkeleton(testType, score) {
    const t = String(testType || '');
    if (/结课|模考|模拟|综合卷|期末|联考/.test(t)) return SKELETONS.III;
    if (score >= 50) return SKELETONS.II;
    return SKELETONS.I;
  }

  /* ======================================================================
     四、归因判定
     ====================================================================== */
  /**
   * 严重度副词
   * 判定次序（关键）：
   *   ① 老师写了原因原文 → 以原文措辞为准（"完全/明显/轻度"这类词最可信）
   *   ② 没有原因原文 → 只看得分率分档，不看措辞（否则会把"没有明显问题"之类的
   *      中性描述误判成"明显"）
   *        rate === 0            → completely（整题零分）
   *        rate <  0.34          → obvious   （得分不足三分之一）
   *        其余                   → mild
   */
  function severity(text, rate) {
    const t = String(text || '');
    if (t) {
      if (/完全|根本|大面积|系统性|极其|严重|全部/.test(t)) return 'completely';
      if (/明显|较为|较大|比较/.test(t)) return 'obvious';
      if (/轻度|略有|偶发|偶有|稍微/.test(t)) return 'mild';
    }
    // 无原文（或原文里没有程度词）→ 纯按得分率
    if (rate === 0) return 'completely';
    return rate < 0.34 ? 'obvious' : 'mild';
  }
  const SEV_WORD = {
    completely:{ pre:'完全', suf:'严重不足' },
    obvious:   { pre:'明显', suf:'较为薄弱' },
    mild:      { pre:'轻度', suf:'略有欠缺' }
  };

  /**
   * 对一道题判定失分类型
   * @param {object} q    题目 {no, section, difficulty, knowledge[]}
   * @param {object} r    作答 {full, got, note}
   * @param {string} subject 科目（暂只做数学）
   * @returns {object} {types[], main, second, severity, rate, text}
   */
  function diagnoseOne(q, r, opts) {
    opts = opts || {};
    const full = num(r && r.full), got = num(r && r.got);
    const rate = full ? got / full : 0;
    const note = String((r && r.note) || '');
    const topic = (q.knowledge && q.knowledge[0]) || (q.section || '该模块');
    const isMC  = /多选/.test(q.section || '');
    const isFb  = /填空/.test(q.section || '');
    const isSa  = /解答/.test(q.section || '');

    // 1) 若有老师填的原因，直接以它为准做判定（最可靠）
    //    注意 severity 的第 2 个参数：没写原因时传空串，让它纯按得分率分档，
    //    避免把题干里的中性措辞误当成严重度副词。
    const hay = note || '';
    const hits = [];
    TYPES.forEach(t => {
      const m = hay.match(t.feat);
      if (m) {
        // 排序原则（对齐老师的写法）：根本原因优先 → 权重高者优先 → 文中出现更早者优先
        hits.push({ t, idx: m.index, root: t.root ? 1 : 0, w: t.weight });
      }
    });
    hits.sort((a, b) => b.root - a.root || b.w - a.w || a.idx - b.idx);

    // 2) 没填原因时，按"得分率 + 题型 + 难度"推断
    let types = hits.map(h => h.t);
    let inferred = false;
    if (!types.length) {
      inferred = true;
      const coef = q.coeff == null ? null : q.coeff;
      if (rate === 0) {
        // 全错：难题 + 解答题 更可能是畏难/未学；简单题更可能是知识漏洞
        if (isSa && (coef != null && coef < 0.45)) types.push(byKey('fear'));
        if (isSa && (coef != null && coef < 0.30)) types.push(byKey('prelim'));
        types.push(byKey('knowledge'));
        if (coef != null && coef >= 0.60) types.push(byKey('concept'));
      } else if (rate < 0.5) {
        types.push(byKey('method'));
        types.push(byKey('knowledge'));
      } else {
        types.push(byKey('calc'));
        if (isMC) types.push(byKey('strategy'));
      }
      if (isMC && !types.some(t => t.key === 'strategy')) types.push(byKey('strategy'));
    }
    // 去重
    const seen = {};
    types = types.filter(t => t && !seen[t.key] && (seen[t.key] = 1));

    const sev = severity(hay, rate);
    const main = types[0] ? types[0].name : '知识漏洞';
    const second = types[1] ? types[1].name : '';

    return {
      no: q.no, section: q.section, full, got, rate,
      knowledge: q.knowledge || [],
      difficulty: q.difficulty, coeff: q.coeff,
      types: types.map(t => t.name),
      typeKeys: types.map(t => t.key),
      main, second, severity: sev, severityWord: SEV_WORD[sev],
      topic, inferred,
      note,
      text: buildQuestionText({ q, full, got, rate, topic, types, sev, isMC, isFb, isSa, note, inferred, opts })
    };
  }
  function byKey(k) { return TYPES.find(t => t.key === k); }

  /**
   * 生成单题原因描述 —— 按题型套用不同句式长度与内容
   * 单选/填空：20–35 字，知识点定向
   * 多选：40–50 字，必含漏选/错选/逐项验证
   * 解答：40–60 字，必含分问复盘
   */
  function buildQuestionText(a) {
    const { q, full, got, rate, topic, types, sev, isMC, isFb, isSa, note, inferred } = a;
    if (rate >= 1) return '无';                       // 全对，老师的写法就是"无"
    if (note && note.trim() && note.trim() !== '无') return note.trim();   // 老师已填则原样用

    const sw = SEV_WORD[sev];
    const t0 = types[0], t1 = types[1];
    const label = t0 ? t0.name + (t1 ? ' + ' + t1.name : '') : '知识漏洞';
    const detailOf = (t) => t ? t.phrase.replace(/\{topic\}/g, topic) : '';
    const detail = [detailOf(t0), t1 ? detailOf(t1) : ''].filter(Boolean).join('；');

    if (isMC) {
      const pick = got === 0 ? '错选' : (rate < 1 ? '漏选' : '');
      return `${pick}选项，失分类型为${label}。${topic}的基础判断能完成，但对不确定的选项缺少逐项验证与反例排查，${sw.pre}${sw.suf}。`;
    }
    if (isFb) {
      // 填空极简：老师实测均值仅 24 字，一句话定性即可
      if (t0 && t0.key === 'calc')   return `${topic}计算出错，属于偶发计算偏差。`;
      if (t0 && t0.key === 'concept')return `${topic}概念辨析失误，定义边界把握不准。`;
      if (t0 && t0.key === 'read')   return `${topic}条件读漏，多解与范围未考虑完整。`;
      if (t0 && t0.key === 'method') return `${topic}没有清晰思路，方法未掌握。`;
      if (t0 && t0.key === 'fear')   return `${topic}畏难放弃，未动笔尝试。`;
      return `${topic}${sw.pre}失分，基础公式与题型不熟练。`;
    }
    if (isSa) {
      // 解答题：分问复盘
      const parts = [];
      if (rate >= 0.6 && got > 0) parts.push(`前段设问方向正确、拿到了主要步骤分`);
      else if (got > 0) parts.push(`完成了第一步的局部推导，但未能推进到底`);
      else parts.push(`整题几乎没有有效推进`);
      parts.push(`失分类型为${label}，${detail}`);
      if (rate === 0) parts.push('后续设问留白，缺少动笔拆解条件的意识');
      return parts.join('；') + '。';
    }
    // 单选 / 通用
    if (t0 && t0.key === 'concept') return `混淆了${topic}的相关定义，概念边界把握不精准，${sw.pre}失分。`;
    if (t0 && t0.key === 'knowledge') return `${topic}的基础应用${sw.pre}未掌握，${sw.suf}。`;
    if (t0 && t0.key === 'calc') return `${topic}的思路正确，但运算环节出现失误，属于"会做但算不对"。`;
    return `${detail}，${sw.pre}失分。`;
  }

  /* ======================================================================
     五、整卷汇总
     ====================================================================== */
  function diagnoseAll(paper, records, opts) {
    opts = opts || {};
    const out = [];
    (paper.questions || []).forEach(q => {
      const r = (records || {})[q.no] || { full: 0, got: 0 };
      if (num(r.full) > 0 && num(r.got) >= num(r.full)) return;   // 全对不进错题表
      out.push(diagnoseOne(q, r, opts));
    });
    return out;
  }

  /** 按模块聚合失分，并给出教学建议
   *
   *  ⚠ 分值口径（重要）：
   *    一道题常常跨多个模块（例如「椭圆中三角形面积」+「三角函数化简」），
   *    早期实现让每个模块都各自承担整题的失分，导致各模块失分之和
   *    远大于卷面实际失分（重复计算）。
   *    现在的规则：
   *      · lost（失分）只计入该题的**主模块**，保证 Σ模块失分 = 卷面失分
   *      · full / got（满分/得分）在每个相关模块里都保留，
   *        用于展示"这个模块整体得分率"，但它只反映该题在该模块上的表现，
   *        不参与失分求和
   *    主模块的判定：取该题**第一个**知识点所属模块 —— 学科网把知识点按
   *    "最核心 → 最外围"排序，第一个就是这道题的主考点。
   *
   *  @param diags        错题归因列表
   *  @param KC           知识点分类器
   *  @param allQuestions 可选：全卷题目（传入则统计覆盖全卷，能得到"零失分模块"）
   *  @param records      可选：对应的作答记录 */
  function byModule(diags, KC, allQuestions, records) {
    const map = {};
    const add = (k, qno, full, got, lost, types, knowledge) => {
      const id = KC.classify(k);
      const m = map[id] || (map[id] = {
        id, name: KC.moduleName(id), lost: 0, full: 0, got: 0, questions: [],
        typeCount: {}, points: []
      });
      m.lost += lost; m.full += full; m.got += got;
      if (m.questions.indexOf(qno) < 0) m.questions.push(qno);
      (types || []).forEach(t => m.typeCount[t] = (m.typeCount[t] || 0) + 1);
      (knowledge || []).forEach(x => { if (m.points.indexOf(x) < 0) m.points.push(x); });
    };

    /**
     * 处理一道题：算出它涉及哪些模块，只把失分给主模块
     * @param {string[]} kps 该题的知识点
     * @param {number} qno   题号
     */
    const addQuestion = (kps, qno, full, got, types) => {
      const list = (kps && kps.length) ? kps : ['其他'];
      const lostTotal = full - got;
      const seen = {};
      let isPrimary = true;
      list.forEach(k => {
        const id = KC.classify(k);
        if (seen[id]) return;            // 同一题落到同一模块内只算一次
        seen[id] = 1;
        // 第一个命中的模块 = 主模块，承担全部失分；其余模块失分记 0
        add(k, qno, full, got, isPrimary ? lostTotal : 0, types, [k]);
        isPrimary = false;
      });
    };

    if (allQuestions && allQuestions.length) {
      // ① 用全卷题目统计（推荐）：能看到零失分模块
      allQuestions.forEach(q => {
        const r = (records || {})[q.no] || {};
        const full = num(r.full), got = num(r.got);
        const d = (diags || []).find(x => x.no === q.no);
        addQuestion(q.knowledge, q.no, full, got, d ? d.types : []);
      });
    } else {
      // ② 退路：只有错题时，按错题统计
      (diags || []).forEach(d => {
        addQuestion(d.knowledge.length ? d.knowledge : [d.topic], d.no, d.full, d.got, d.types);
      });
    }
    const list = Object.values(map);
    list.forEach(m => {
      m.rate = m.full ? m.got / m.full : 0;
      m.topTypes = Object.keys(m.typeCount).sort((a, b) => m.typeCount[b] - m.typeCount[a]);
      m.advice = KC.adviceOf(m.name);
      m.questions.sort((a, b) => a - b);
    });
    list.sort((a, b) => b.lost - a.lost || b.full - a.full);
    return list;
  }

  /** 按题型聚合（老师习惯按题型分块讲） */
  function byType(diags) {
    const map = {};
    diags.forEach(d => {
      const t = d.section || '未分类';
      const m = map[t] || (map[t] = { type: t, n: 0, lost: 0, full: 0, questions: [], types: {} });
      m.n++; m.lost += (d.full - d.got); m.full += d.full;
      m.questions.push(d.no);
      d.types.forEach(x => m.types[x] = (m.types[x] || 0) + 1);
    });
    Object.values(map).forEach(m => m.rate = m.full ? (m.full - m.lost) / m.full : 0);
    const ORDER = ['单选题', '多选题', '填空题', '解答题'];
    return Object.values(map).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  }

  function num(x) { const v = parseFloat(x); return isNaN(v) ? 0 : v; }

  return {
    TYPES, BANDS, SKELETONS, bandOf, pickSkeleton,
    diagnoseOne, diagnoseAll, byModule, byType, buildQuestionText,
    typeByKey: byKey, severity, SEV_WORD
  };
}));
