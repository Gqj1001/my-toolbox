/**
 * 高中数学 · 知识点模块分类器
 * ------------------------------------------------------------------
 * 学科网自带的「知识点分析」归并很粗（常把集合、数列并进"函数与导数"），
 * 本模块用规则把它重新归到细粒度的高考模块，供报告按模块统计使用。
 * 纯函数、无依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./kp-dict.js'));
  else root.KnowledgeClassifier = factory(root.KpDict);
}(typeof self !== 'undefined' ? self : this, function (KpDict) {
  'use strict';

  /** 模块定义：按判定优先级排列（越靠前优先级越高）
   *  注意 1：一律用多字词，避免"体""面""球""计"这类单字误伤
   *          （例如"用样本估计总体"里的"体"、"二项式系数"里的"计"）
   *  注意 2：平面解析几何必须排在立体几何之前 —— 否则"圆锥"会抢走
   *          "直线与圆锥曲线的位置关系"里的"圆锥曲线" */
  const MODULES = [
    { id: 'trig',   name: '三角函数与解三角形',
      re: /三角函数|正弦函数|余弦函数|正切函数|正余弦定理|正弦定理|余弦定理|解三角形|三角恒等|诱导公式|弧度制|任意角|同角三角|y\s*=\s*A\s*sin|和差角|和、差角|和差化积|积化和差|二倍角|辅助角|三角形面积|三角形形状|sinx|cosx|tanx|对称轴及对称中心|图象变换|平移变换/i },

    { id: 'anageo', name: '平面解析几何',
      re: /椭圆|双曲线|抛物线|圆锥曲线|直线与圆锥|圆的方程|直线与圆|离心率|渐近线|准线|焦点弦|弦长|定点|定值|轨迹方程|直线的方程|倾斜角|斜率|中点弦|点差法|韦达定理|联立|两圆|圆的切线|直线方程|距离公式|对称问题|阿波罗尼斯/i },

    { id: 'geo3',   name: '立体几何与空间向量',
      re: /立体几何|空间几何|空间向量|线面|面面|线线|异面直线|二面角|棱柱|棱锥|棱台|圆柱|圆锥|圆台|球的|外接球|内切球|表面积|体积|三视图|直观图|点面距离|法向量|共面向量|斜二测|截面|空间直角坐标系|空间点|空间位置关系|空间线段|空间共面|锥体|柱体|台体|空间角/i },

    { id: 'calc',   name: '导数及其应用',
      // "恒成立"只在与导数/函数同现时才算导数题；否则会抢走
      // "一元二次不等式恒成立问题"（应属等式与不等式）
      re: /导数|导函数|切线|极值|单调区间|能成立|定积分|瞬时变化率|平均变化率|函数模型|(?:导数|函数)[^。；]{0,10}恒成立|恒成立[^。；]{0,10}(?:导数|函数)/i },

    { id: 'seq',    name: '数列',
      re: /数列|等差|等比|通项|前\s*n\s*项和|错位相减|裂项|递推|数学归纳|下标性质/i },

    { id: 'vec',    name: '平面向量',
      re: /平面向量|向量|数量积|基底|共线向量|向量的模|向量夹角|投影向量|投影/i },

    { id: 'anageo', name: '平面解析几何',
      re: /椭圆|双曲线|抛物线|圆锥曲线|圆的方程|直线与圆|直线与圆锥|离心率|渐近线|准线|焦点弦|弦长|定点|定值|轨迹方程|直线的方程|倾斜角|斜率|中点弦|点差法|韦达定理|联立|两圆|圆的切线|直线方程|距离公式|对称问题|阿波罗尼斯/i },

    { id: 'prob',   name: '概率与统计',
      re: /概率|概型|随机变量|分布列|期望|方差|标准差|二项分布|超几何分布|正态分布|独立性检验|回归|相关系数|抽样|频率分布|平均数|中位数|众数|百分位|极差|统计|直方图|残差|成对数据|样本估计|用样本|独立性|卡方|列联表/i },

    { id: 'ineq',   name: '等式与不等式',
      re: /不等式|基本不等式|比较大小|绝对值|一元二次不等式|分式不等式|等式与不等式|不等关系|作差法|均值不等式/i },

    { id: 'cnr',    name: '计数原理与二项式',
      re: /计数原理|排列|组合|二项式|展开式|通项公式|系数|分类加法|分步乘法|全排列|捆绑|插空|隔板|数字排列|染色问题/i },

    { id: 'set',    name: '集合与常用逻辑用语',
      re: /集合|子集|交集|并集|补集|充要条件|充分条件|必要条件|全称|存在量词|命题|逻辑|Venn|量词/i },

    { id: 'cplx',   name: '复数',
      re: /复数|虚部|实部|共轭|复平面|模长/i },

    { id: 'fun',    name: '函数概念与性质',
      re: /函数|定义域|值域|奇偶性|单调性|周期性|对称性|幂函数|指数|对数|图象|抽象函数|分段函数|反函数|复合函数|函数值/i }
  ];

  /** 把一条知识点归到模块 id
   *  优先级：① 显式词典（300 条权威归并，已验证可复现学科网官方归并）
   *          ② 关键词规则（处理词典里没有的新知识点） */
  function classify(text) {
    const t = String(text || '');
    if (KpDict && t) {
      const hit = KpDict.lookup(t);
      if (hit) return hit;
    }
    for (const m of MODULES) if (m.re.test(t)) return m.id;
    return 'other';
  }
  function classifyName(text) {
    const id = classify(text);
    const m = MODULES.find(x => x.id === id);
    return m ? m.name : '其他';
  }
  function moduleName(id) {
    const m = MODULES.find(x => x.id === id);
    return m ? m.name : '其他';
  }

  /**
   * 对一篇试卷的技能点做模块聚合
   * @param {Array} questions paper.questions（含 no / knowledge[] / coeff / difficulty）
   * @param {Object} records  { 题号: {full, got} }
   */
  function aggregate(questions, records) {
    const map = {};
    (questions || []).forEach(q => {
      const r = (records || {})[q.no] || {};
      const full = num(r.full), got = num(r.got);
      const seen = {};
      (q.knowledge || []).forEach(k => {
        const id = classify(k);
        if (seen[id]) return;           // 同一题的同一模块只算一次分值
        seen[id] = 1;
        const m = map[id] || (map[id] = { id, name: moduleName(id), n: 0, full: 0, got: 0, questions: [], points: [] });
        m.n++; m.full += full; m.got += got;
        if (m.questions.indexOf(q.no) < 0) m.questions.push(q.no);
        if (m.points.indexOf(k) < 0) m.points.push(k);
      });
    });
    const list = Object.values(map);
    list.forEach(m => { m.rate = m.full ? m.got / m.full : 0; m.lost = m.full - m.got; });
    list.sort((a, b) => b.lost - a.lost || b.full - a.full);
    return list;
  }

  function num(x) { const v = parseFloat(x); return isNaN(v) ? 0 : v; }

  /** 按模块名给出教学建议方向（供报告生成与 AI 提示词使用） */
  const ADVICE = {
    '三角函数与解三角形': '练熟"边角互化"与最值范围的标准化流程，把解答题第一问做到零失误',
    '立体几何与空间向量': '固化"建系→写坐标→求法向量→算角"的步骤，证明题先背全定理条件',
    '导数及其应用': '把含参分类讨论固定为"求导通分→找零点→比较定义域边界→分情况写结论"',
    '数列': '通项与求和的方法要形成清单：累加、累乘、构造、裂项、错位相减，见到题先判类型',
    '平面向量': '坐标运算与几何转化两条路都要熟练，重点练数量积、模长、夹角、共线',
    '平面解析几何': '先保证第一问（求方程、求离心率）满分，第二问练联立与韦达定理的运算速度',
    '概率与统计': '规范书写事件设定、分布列表格、结论说明，这类题按模板拿满分',
    '等式与不等式': '注意定义域与边界条件，含参不等式先定分类标准再讨论',
    '计数原理与二项式': '整理常见模型（相邻、不相邻、分组分配、定序），二项式记准通项与系数和区别',
    '集合与常用逻辑用语': '这类送分题要求零失误，重点避免空集、端点等细节陷阱',
    '复数': '记牢四则运算与分母实数化，这类题要做到每题不超过 1 分钟',
    '函数概念与性质': '把单调性、奇偶性、周期性、对称性的判定流程各自固化成步骤',
    '其他': '回归课本记牢核心公式与性质，配套足量基础题巩固'
  };
  function adviceOf(moduleName) { return ADVICE[moduleName] || ADVICE['其他']; }

  return { MODULES, classify, classifyName, moduleName, aggregate, adviceOf, ADVICE };
}));
