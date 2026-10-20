/**
 * 科目包：物理（高中 / 初中）
 * 纯配置；题型/分值/模块/话术都可在这里改，不用动引擎。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperV2SubjectPacks = Object.assign(root.PaperV2SubjectPacks || {}, factory());
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const seniorModules = [
    { id: 'mech', name: '力学', re: /质点|参考系|位移|速度|加速度|匀变速|自由落体|重力|弹力|摩擦力|牛顿|受力|超重|失重|曲线运动|平抛|圆周|万有引力|天体|功|功率|动能|势能|机械能|动量|冲量|碰撞|振动|波/i, advice: '先把受力分析画完整，再列牛顿第二定律或能量方程；每一步写清研究对象与正方向。' },
    { id: 'elec', name: '电磁学', re: /电场|电势|电势能|电容|带电粒子|电路|欧姆|电阻|电动势|闭合电路|磁场|安培力|洛伦兹力|电磁感应|楞次|法拉第|交变电流|变压器/i, advice: '电学先画等效电路，磁学先定方向（左手/右手定则）；把"场→力→运动"的链条写全。' },
    { id: 'thermal', name: '热学', re: /分子|热运动|内能|温度|气体|压强|体积|热力学|布朗|扩散/i, advice: '热学抓住"状态参量 → 过程方程 → 能量守恒"三步，注意单位与符号。' },
    { id: 'optics', name: '光学与近代物理', re: /光|折射|反射|全反射|干涉|衍射|偏振|光电效应|光子|能级|原子核|衰变|半衰期|相对论/i, advice: '光学先画光路图，近代物理先写能量/动量守恒式，再代入数据。' },
    { id: 'experiment', name: '物理实验', re: /实验|探究|测量|打点计时器|游标卡尺|螺旋测微器|伏安法|验证|描绘|测定/i, advice: '实验题先写实验原理与公式，再处理数据（逐差/图像），最后分析误差来源。' },
  ];

  const juniorModules = [
    { id: 'sound', name: '声现象', re: /声|音调|响度|音色|噪声|回声/i, advice: '声学抓住"振动发声、介质传声、三要素"三条，结合生活现象解释。' },
    { id: 'light', name: '光现象', re: /光|直线传播|反射|折射|平面镜|凸透镜|凹透镜|色散/i, advice: '光学先画光路图，标清法线、入射角与折射角。' },
    { id: 'thermal', name: '热与内能', re: /温度|内能|热量|比热容|热值|熔化|凝固|汽化|液化|升华|凝华/i, advice: '热学先判断物态变化，再套吸放热公式，注意单位。' },
    { id: 'mech', name: '力学', re: /质量|密度|速度|路程|力|重力|弹力|摩擦力|压强|浮力|杠杆|滑轮|功|功率|机械能/i, advice: '力学先画受力图，再选公式；压强/浮力题先明确"固体还是液体"。' },
    { id: 'elec', name: '电与磁', re: /电流|电压|电阻|欧姆|电路|电功|电功率|焦耳|磁场|电磁铁|电动机|发电机/i, advice: '电学先画等效电路，标清串并联；磁学先定电流方向与磁极。' },
    { id: 'experiment', name: '实验与探究', re: /实验|探究|测量|仪器|读数|误差/i, advice: '实验题先写目的/原理/步骤，再处理数据，最后评估误差。' },
  ];

  const seniorTypes = [
    { id: 'single', label: '单选题', aliases: ['选择题', '单选'], per: 4 },
    { id: 'multi', label: '多选题', aliases: ['多选', '多项选择', '不定项'], per: 5 },
    { id: 'exp', label: '实验题', aliases: ['实验', '实验探究题', '填空题'], per: 10 },
    { id: 'calc', label: '计算题', aliases: ['解答题', '大题', '计算'], per: 12, absorb: true },
  ];

  const senior = {
    key: 'physics', stage: 'senior', name: '物理', fullScore: 100,
    types: seniorTypes,
    presets: [
      { name: '河北新高考卷（100分）', total: 100, dist: { 单选题: [7, 4], 多选题: [3, 5], 实验题: [2, 10], 计算题: [3, 12.33, 37] } },
      { name: '北京卷（100分）', total: 100, dist: { 单选题: [8, 3], 多选题: [4, 4], 实验题: [2, 10], 计算题: [4, 10] } },
    ],
    modules: seniorModules,
    kpDict: {
      '牛顿第二定律': 'mech', '牛顿运动定律': 'mech', '受力分析': 'mech', '机械能守恒': 'mech', '动量守恒': 'mech',
      '平抛运动': 'mech', '圆周运动': 'mech', '万有引力': 'mech',
      '电场强度': 'elec', '电势差': 'elec', '带电粒子在电场中的运动': 'elec', '闭合电路欧姆定律': 'elec',
      '安培力': 'elec', '洛伦兹力': 'elec', '电磁感应': 'elec', '楞次定律': 'elec',
      '气体实验定律': 'thermal', '热力学第一定律': 'thermal',
      '光的折射': 'optics', '全反射': 'optics', '光电效应': 'optics', '原子核衰变': 'optics',
      '打点计时器': 'experiment', '伏安法测电阻': 'experiment', '探究加速度与力质量的关系': 'experiment',
    },
    bands: { 1: ['mech', 'elec'], 2: ['experiment', 'thermal'], 3: ['optics'] },
    prompts: { persona: '你是一位有十几年经验的高中物理教师', knowledgeHint: '用「牛顿第二定律」「电磁感应」这类教材措辞' },
    grades: ['高一', '高二', '高三'],
    defaultGrade: '高三',
    otherAdvice: '先保证受力分析/电路分析不丢步骤分，再练综合计算；每道错题写清"卡在哪一步"。',
  };

  const junior = {
    key: 'physics', stage: 'junior', name: '物理', fullScore: 100,
    types: [
      { id: 'single', label: '单选题', aliases: ['选择题', '单选'], per: 3 },
      { id: 'fill', label: '填空题', aliases: ['填空', '实验题'], per: 3 },
      { id: 'calc', label: '计算题', aliases: ['解答题', '大题', '计算'], per: 8, absorb: true },
    ],
    presets: [
      { name: '中考物理（100分）', total: 100, dist: { 单选题: [12, 3], 填空题: [8, 3], 计算题: [4, 10] } },
    ],
    modules: juniorModules,
    kpDict: {
      '声音的产生与传播': 'sound', '声音的特性': 'sound', '噪声的危害和控制': 'sound',
      '光的反射': 'light', '光的折射': 'light', '凸透镜成像': 'light',
      '比热容': 'thermal', '热机': 'thermal', '物态变化': 'thermal',
      '密度': 'mech', '压强': 'mech', '浮力': 'mech', '简单机械': 'mech', '功和功率': 'mech',
      '欧姆定律': 'elec', '电功率': 'elec', '电磁感应': 'elec',
    },
    bands: { 1: ['mech', 'elec'], 2: ['light', 'thermal'], 3: ['sound', 'experiment'] },
    prompts: { persona: '你是一位有十几年经验的初中物理教师', knowledgeHint: '用「欧姆定律」「凸透镜成像」这类教材措辞' },
    grades: ['八年级', '九年级'],
    defaultGrade: '九年级',
    otherAdvice: '先把概念和公式记准，再练实验与计算；每道错题写清"是概念不清还是算错"。',
  };

  return { 'physics-senior': senior, 'physics-junior': junior };
}));
