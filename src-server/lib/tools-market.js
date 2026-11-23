/**
 * P3-2 工具市场扩展（2026-11-06）：11 个新内置工具（15 → 26），分两类：
 *
 * ① 纯本地计算类（8 个，零外部依赖零网络）：
 *    uuid_gen / hash_tool / base64_tool / json_tool / text_count / date_calc / unit_convert / cron_explain
 * ② 网络查询类（3 个，免费公共源开箱即用，支持用户自有 API Key 增强配额与质量）：
 *    weather_query（和风天气 Key 优先 → wttr.in 免费兜底）
 *    translate_text（DeepL Key 优先 → MyMemory 免费兜底）
 *    exchange_rate（frankfurter.app 免费公共源，无需 Key）
 *
 * 用户级 Key 机制（P3-2 核心诉求「用户可填自己的 API Key」）：
 *    - 存储：user_tool_keys 表（username+tool_name 唯一，api_key AES-256-GCM 加密落盘）
 *    - 管理：POST/PUT/DELETE /api/tool-keys（仅本人，列表掩码回显）
 *    - 消费：本文件经 tools.js 注入的 getUserToolKey(ctx, toolName) 在 run 内读取解密；
 *      ctx.username 缺失（无人值守/旧调用方）或未配置时走免费兜底源——企业内开箱即用
 *
 * 风险分级：11 个全部 low（纯读纯算，无产物落盘、无外部写操作、无持久化实体），
 * 与 web_search/stock_quote 同级（TOOL_RISK 已同步登记，见 tools.js）。
 */

const crypto = require('crypto');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）

/** 可配用户 API Key 的工具元数据（P3-2，单一事实来源）：
 *  routes/tool-keys.js（CRUD 白名单）、routes/skills-market.js（市场展示 keyed 标记）共同引用，
 *  避免两处清单漂移。新增带 key 工具时在此登记即可全链路生效。 */
const KEYED_TOOL_META = {
  weather_query: {
    label: '天气查询 · 和风天气',
    provider: '和风天气（qweather.com）',
    hint: '控制台创建凭据后复制 Key（32 位）。未配置时使用 wttr.in 免费公共源。',
    key_url: 'https://console.qweather.com/',
  },
  translate_text: {
    label: '文本翻译 · DeepL',
    provider: 'DeepL（Free 计划即可）',
    hint: 'DeepL 账户 → API Key（DeepL-Auth-Key）。未配置时使用 MyMemory 免费公共源。',
    key_url: 'https://www.deepl.com/pro-api/',
  },
};

/**
 * 用户级工具 API Key 读取（P3-2 核心）：按 ctx.username + tool_name 查 user_tool_keys 表并解密。
 * - 仅当执行上下文带有 username（对话主链路 chat.js 传入）时生效；无人值守/画布旧调用方无 username → null → 走免费兑底
 * - api_key 存量为 AES-256-GCM 密文（写入方 routes/tool-keys.js encrypt；启动迁移幂等加密），decrypt 未配置密钥时兑底返回原文
 * - status=0（停用）或未登记均返回 null；任何异常兑底 null（工具可用性优先，不因 key 读取失败阻断）
 */
async function getUserToolKey(ctx, toolName) {
  const username = ctx?.username;
  if (!username || !toolName) return null;
  try {
    const { db } = require('../db');
    const row = dal.getq('SELECT api_key, status FROM user_tool_keys WHERE username=? AND tool_name=?', [String(username), String(toolName)]);
    if (!row || !row.status || !row.api_key) return null;
    const { decrypt } = require('./crypto-util');
    return decrypt(row.api_key) || null;
  } catch { return null; }
}

/* =============== 纯本地工具（零网络零依赖） =============== */

/** UUID / 随机密码 / 随机串生成 */
const uuid_gen = {
  schema: {
    type: 'function',
    function: {
      name: 'uuid_gen',
      description: '生成随机标识符：UUID v4、随机密码、随机字符串。用于生成记录 ID、临时密码、测试数据等场景。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['uuid', 'password', 'string'], description: '生成类型：uuid（UUID v4）/ password（随机密码，含大小写数字符号）/ string（随机字符串，仅字母数字）' },
          count: { type: 'integer', description: '生成数量（1~20，默认 1）' },
          length: { type: 'integer', description: 'password/string 的长度（8~64，默认 16）' },
        },
        required: ['kind'],
      },
    },
  },
  run: async (args) => {
    const kind = String(args.kind || 'uuid');
    const count = Math.min(Math.max(parseInt(args.count) || 1, 1), 20);
    const len = Math.min(Math.max(parseInt(args.length) || 16, 8), 64);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (kind === 'uuid') out.push(crypto.randomUUID());
      else if (kind === 'password') {
        // 加固（2026-11-11）：纯均匀随机在 12 位下约 16% 概率缺某一类字符（实测冒烟 flaky：
        // 生成 J*#HreBs)M$y 缺数字），且作为密码生成器缺类属弱密码缺陷——改为四类各保底 1 个，
        // 其余随机填充后 Fisher-Yates 洗牌，保证「长度达标 + 四类必含」且无位置规律
        const sets = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$%^&*()-_=+'];
        const all = sets.join('');
        const buf = crypto.randomBytes(256);
        let pick = 0;
        const next = mod => buf[pick++ % buf.length] % mod;
        const arr = sets.map(set => set[next(set.length)]);
        while (arr.length < len) arr.push(all[next(all.length)]);
        for (let j = arr.length - 1; j > 0; j--) { const k = next(j + 1); [arr[j], arr[k]] = [arr[k], arr[j]]; }
        out.push(arr.join(''));
      } else {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const buf = crypto.randomBytes(len);
        let s = '';
        for (let j = 0; j < len; j++) s += chars[buf[j] % chars.length];
        out.push(s);
      }
    }
    return count === 1 ? out[0] : out.join('\n');
  },
};

/** 文本哈希（MD5/SHA1/SHA256/SHA512） */
const hash_tool = {
  schema: {
    type: 'function',
    function: {
      name: 'hash_tool',
      description: '计算文本哈希值，支持 MD5 / SHA1 / SHA256 / SHA512（十六进制输出）。用于数据校验、去重指纹、签名比对。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要哈希的文本内容' },
          algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512'], description: '哈希算法（默认 sha256）' },
        },
        required: ['text'],
      },
    },
  },
  run: async (args) => {
    const text = String(args.text ?? '');
    if (!text) return '请提供要哈希的文本内容';
    const algo = String(args.algorithm || 'sha256').toLowerCase();
    if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) return `不支持的算法：${algo}（可用：md5 / sha1 / sha256 / sha512）`;
    const h = crypto.createHash(algo).update(text, 'utf8').digest('hex');
    return `${algo.toUpperCase()}：${h}`;
  },
};

/** Base64 / URL 编解码 */
const base64_tool = {
  schema: {
    type: 'function',
    function: {
      name: 'base64_tool',
      description: 'Base64 与 URL 百分号编解码。用于解码接口返回的 Base64 数据、编码传输内容、解析 URL 参数。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要处理的内容' },
          mode: { type: 'string', enum: ['base64_encode', 'base64_decode', 'url_encode', 'url_decode'], description: '处理模式' },
        },
        required: ['text', 'mode'],
      },
    },
  },
  run: async (args) => {
    const text = String(args.text ?? '');
    const mode = String(args.mode || '');
    try {
      if (mode === 'base64_encode') return Buffer.from(text, 'utf8').toString('base64');
      if (mode === 'base64_decode') return Buffer.from(text, 'base64').toString('utf8');
      if (mode === 'url_encode') return encodeURIComponent(text);
      if (mode === 'url_decode') return decodeURIComponent(text);
      return `不支持的模式：${mode}（可用：base64_encode / base64_decode / url_encode / url_decode）`;
    } catch (e) {
      return `解码失败（内容可能不是合法编码）：${e.message}`;
    }
  },
};

/** JSON 格式化 / 压缩 / 校验 */
const json_tool = {
  schema: {
    type: 'function',
    function: {
      name: 'json_tool',
      description: 'JSON 处理：格式化美化（缩进）、压缩成单行、校验合法性并定位错误。用于整理接口返回、排查 JSON 语法问题。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'JSON 文本' },
          mode: { type: 'string', enum: ['format', 'minify', 'validate'], description: 'format=美化缩进（默认）/ minify=压缩单行 / validate=仅校验' },
          indent: { type: 'integer', description: 'format 模式缩进空格数（默认 2）' },
        },
        required: ['text'],
      },
    },
  },
  run: async (args) => {
    const text = String(args.text ?? '');
    if (!text.trim()) return '请提供 JSON 文本';
    const mode = String(args.mode || 'format');
    try {
      const obj = JSON.parse(text);
      if (mode === 'minify') return JSON.stringify(obj);
      if (mode === 'validate') return '✅ JSON 合法（' + (Array.isArray(obj) ? `数组，${obj.length} 项` : typeof obj === 'object' && obj ? `对象，${Object.keys(obj).length} 键` : typeof obj) + '）';
      const indent = Math.min(Math.max(parseInt(args.indent) || 2, 1), 8);
      return JSON.stringify(obj, null, indent);
    } catch (e) {
      if (mode === 'validate') return '❌ JSON 不合法：' + e.message;
      return 'JSON 解析失败：' + e.message;
    }
  },
};

/** 字数统计（中文友好） */
const text_count = {
  schema: {
    type: 'function',
    function: {
      name: 'text_count',
      description: '统计文本的字数信息：总字符数（含/不含空格）、中文字符数、英文单词数、句子数、段落数。适用于稿件字数要求核对。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要统计的文本' },
        },
        required: ['text'],
      },
    },
  },
  run: async (args) => {
    const text = String(args.text ?? '');
    if (!text) return '请提供要统计的文本';
    const total = text.length;
    const noSpace = text.replace(/\s/g, '').length;
    const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const words = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    const sentences = text.split(/[。！？!?.\n]+/).map(s => s.trim()).filter(Boolean).length;
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).length;
    return [
      `总字符数（含空格）：${total}`,
      `总字符数（不含空格）：${noSpace}`,
      `中文字符：${chinese}`,
      `英文单词：${words}`,
      `句子数：${sentences}`,
      `段落数：${paragraphs}`,
    ].join('\n');
  },
};

/** 日期计算（日期差/加减/工作日） */
const date_calc = {
  schema: {
    type: 'function',
    function: {
      name: 'date_calc',
      description: '日期计算：两个日期相差天数、日期加减 N 天、起止日期间的自然日/工作日（周一至周五）天数。支持 YYYY-MM-DD 或 YYYY/MM/DD 输入。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['diff', 'add', 'workdays'], description: 'diff=两日期相差/add=日期加减/workdays=区间工作日' },
          date: { type: 'string', description: '基准日期 YYYY-MM-DD（add/diff/workdays 起点；缺省用今天）' },
          date2: { type: 'string', description: 'diff/workdays 的第二个日期 YYYY-MM-DD' },
          days: { type: 'integer', description: 'add 模式加减天数（负数为往前）' },
        },
        required: ['mode'],
      },
    },
  },
  run: async (args) => {
    const mode = String(args.mode || 'diff');
    const parseD = (s) => {
      const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(s || '').trim());
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      return isNaN(d.getTime()) ? null : d;
    };
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
    if (mode === 'add') {
      const base = parseD(args.date) || new Date();
      const days = parseInt(args.days) || 0;
      if (Math.abs(days) > 36500) return '加减天数超出范围（±36500 天内）';
      const r = new Date(base.getTime() + days * 86400000);
      return `${fmt(base)}（周${WEEK[base.getDay()]}）${days >= 0 ? ' + ' : ' - '}${Math.abs(days)} 天 = ${fmt(r)}（周${WEEK[r.getDay()]}）`;
    }
    if (mode === 'diff' || mode === 'workdays') {
      const d1 = parseD(args.date) || new Date();
      const d2 = parseD(args.date2);
      if (!d2) return '请提供第二个日期（date2，YYYY-MM-DD）';
      const [a, b] = d1 <= d2 ? [d1, d2] : [d2, d1];
      const natural = Math.round((b - a) / 86400000);
      if (mode === 'diff') {
        return `${fmt(d1)} → ${fmt(d2)}：相差 ${natural} 天${d1 > d2 ? '（date 在 date2 之后，结果取绝对值）' : ''}`;
      }
      let workdays = 0;
      for (let t = a.getTime(); t <= b.getTime(); t += 86400000) {
        const day = new Date(t).getDay();
        if (day !== 0 && day !== 6) workdays++;
      }
      return `${fmt(a)} → ${fmt(b)}：自然日 ${natural + 1} 天（含首尾），工作日（周一至周五）${workdays} 天`;
    }
    return `不支持的模式：${mode}（可用：diff / add / workdays）`;
  },
};

/** 单位换算 */
const unit_convert = {
  schema: {
    type: 'function',
    function: {
      name: 'unit_convert',
      description: '单位换算：长度（km/m/cm/mm/mile/ft/in）、重量（t/kg/g/lb/oz）、温度（°C/°F/K）、面积（km²/m²/亩/公顷）、数据量（B/KB/MB/GB/TB）。',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: '原始数值' },
          from: { type: 'string', description: '原始单位（如 km、kg、°C、亩、MB）' },
          to: { type: 'string', description: '目标单位（如 mile、lb、°F、公顷、GB）' },
        },
        required: ['value', 'from', 'to'],
      },
    },
  },
  run: async (args) => {
    const value = Number(args.value);
    const from = String(args.from || '').trim().toLowerCase();
    const to = String(args.to || '').trim().toLowerCase();
    if (!Number.isFinite(value)) return '请提供有效数值（value）';
    // 各类基准：长度→米，重量→千克，温度特殊处理，面积→平方米，数据量→字节
    const LENGTH = { km: 1000, m: 1, cm: 0.01, mm: 0.001, mile: 1609.344, mi: 1609.344, ft: 0.3048, in: 0.0254, '英尺': 0.3048, '英寸': 0.0254, '公里': 1000, '米': 1, '厘米': 0.01, '毫米': 0.001, '英里': 1609.344 };
    const WEIGHT = { t: 1000, kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523125, '吨': 1000, '千克': 1, '公斤': 1, '克': 0.001, '磅': 0.45359237, '盎司': 0.028349523125 };
    const AREA = { 'km²': 1e6, 'm²': 1, '亩': 666.6667, '公顷': 1e4, 'ha': 1e4, 'ft²': 0.09290304 };
    const DATA = { b: 1, byte: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
    const TEMP = { '°c': 'C', 'c': 'C', '℃': 'C', '°f': 'F', 'f': 'F', '℉': 'F', 'k': 'K', '开尔文': 'K', '摄氏度': 'C', '华氏度': 'F' };
    const norm = (u) => u.replace('²', '²').replace('°', '°');
    const key = (map, u) => Object.keys(map).find(k => k.toLowerCase() === u.toLowerCase() || norm(k).toLowerCase() === u.toLowerCase());
    // 温度特殊链
    const tf = key(TEMP, from), tt = key(TEMP, to);
    if (tf && tt) {
      let celsius;
      if (TEMP[tf] === 'C') celsius = value;
      else if (TEMP[tf] === 'F') celsius = (value - 32) * 5 / 9;
      else celsius = value - 273.15;
      let out;
      if (TEMP[tt] === 'C') out = celsius;
      else if (TEMP[tt] === 'F') out = celsius * 9 / 5 + 32;
      else out = celsius + 273.15;
      return `${value} ${from} = ${Math.round(out * 100) / 100} ${to}`;
    }
    for (const [name, map] of [['长度', LENGTH], ['重量', WEIGHT], ['面积', AREA], ['数据量', DATA]]) {
      const kf = key(map, from), kt = key(map, to);
      if (kf && kt) {
        const out = value * map[kf] / map[kt];
        return `${value} ${from} = ${Math.round(out * 10000) / 10000} ${to}（${name}）`;
      }
    }
    return `不支持的换算组合：${from} → ${to}。支持：长度 km/m/cm/mm/mile/ft/in、重量 t/kg/g/lb/oz、温度 °C/°F/K、面积 km²/m²/亩/公顷、数据量 B/KB/MB/GB/TB`;
  },
};

/** cron 表达式解析为中文描述（轻量独立实现，不依赖 scheduler） */
const cron_explain = {
  schema: {
    type: 'function',
    function: {
      name: 'cron_explain',
      description: '解析 cron 定时表达式（分 时 日 月 周）为中文自然语言描述，并给出未来 3 次执行时间。用于核对定时任务配置是否符合预期。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '标准 5 段 cron 表达式，如 "0 9 * * 1-5"（工作日每天 9 点）' },
        },
        required: ['expression'],
      },
    },
  },
  run: async (args) => {
    const expr = String(args.expression || '').trim();
    if (!expr) return '请提供 cron 表达式';
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) return `表达式应为 5 段（分 时 日 月 周），当前 ${parts.length} 段：${expr}`;
    const FIELD_NAMES = ['分钟', '小时', '日', '月', '星期'];
    // 逐段校验（字符白名单 + 数值范围：分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-6）
    const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    for (let i = 0; i < 5; i++) {
      if (!/^[\d*,\-\/]+$/.test(parts[i])) return `第 ${i + 1} 段（${FIELD_NAMES[i]}）含非法字符：${parts[i]}`;
      for (const seg of parts[i].split(',')) {
        let range = seg, step = null;
        const sm = /^(.+)\/(\d+)$/.exec(seg);
        if (sm) { range = sm[1]; step = +sm[2]; }
        if (range === '*') continue;
        const nums = /^(\d+)-(\d+)$/.test(range) ? [+RegExp.$1, +RegExp.$2] : (/^\d+$/.test(range) ? [+range, +range] : null);
        if (!nums) return `第 ${i + 1} 段（${FIELD_NAMES[i]}）格式无法解析：${parts[i]}`;
        const [min, max] = RANGES[i];
        if (nums[0] < min || nums[1] > max || nums[0] > nums[1]) return `第 ${i + 1} 段（${FIELD_NAMES[i]}）超出范围 ${min}-${max}：${parts[i]}`;
        if (step != null && (step < 1 || step > max)) return `第 ${i + 1} 段（${FIELD_NAMES[i]}）步长非法：${parts[i]}`;
      }
    }
    // 中文描述（常见模式优先）
    const [mi, h, dom, mon, dow] = parts;
    const describeField = (p, unit) => {
      if (p === '*') return `每${unit}`;
      if (/^\*\/(\d+)$/.test(p)) return `每 ${RegExp.$1} ${unit}`;
      if (/^(\d+)-(\d+)$/.test(p)) return `${RegExp.$1} 到 ${RegExp.$2} ${unit}`;
      return `${p} ${unit}`;
    };
    const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];
    let desc;
    if (mi === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') desc = '每分钟执行一次';
    else if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*') desc = `每小时的第 ${mi} 分钟执行`;
    else if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*') {
      if (/^[0-6]$/.test(dow) || /^\d+-\d+$/.test(dow)) {
        const d = /^[0-6]$/.test(dow) ? `每周${DOW_CN[+dow]}` : `每周${DOW_CN[+dow.split('-')[0]]}至周${DOW_CN[+dow.split('-')[1]]}`;
        desc = `${d} ${h.padStart(2, '0')}:${mi.padStart(2, '0')} 执行`;
      } else desc = `每天 ${h.padStart(2, '0')}:${mi.padStart(2, '0')} 执行`;
    } else if (/^\d+$/.test(mi) && /^\d+$/.test(h) && /^\d+$/.test(dom) && /^\d+$/.test(mon)) {
      desc = `每年 ${mon} 月 ${dom} 日 ${h.padStart(2, '0')}:${mi.padStart(2, '0')} 执行`;
    } else {
      desc = `分钟：${describeField(mi, '分')}；小时：${describeField(h, '时')}；日：${describeField(dom, '号')}；月：${describeField(mon, '月')}；星期：${describeField(dow, '周')}`;
    }
    // 未来 3 次执行时间（朴素模拟：从现在起逐分钟扫描，上限 366 天防止死循环）
    const next3 = [];
    const matchField = (p, v, min, max) => {
      if (p === '*') return true;
      for (const seg of p.split(',')) {
        let step = 1, range = seg;
        const sm = /^(.+)\/(\d+)$/.exec(seg);
        if (sm) { range = sm[1]; step = +sm[2]; }
        if (range === '*') { if ((v - min) % step === 0) return true; continue; }
        const rm = /^(\d+)-(\d+)$/.exec(range);
        if (rm) { const [a, b] = [+rm[1], +rm[2]]; if (v >= a && v <= b && (v - a) % step === 0) return true; continue; }
        if (/^\d+$/.test(range) && +range === v) return true;
      }
      return false;
    };
    let t = new Date();
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    const limit = Date.now() + 366 * 86400000;
    while (next3.length < 3 && t.getTime() < limit) {
      if (matchField(mon, t.getMonth() + 1, 1, 12)
        && matchField(dom, t.getDate(), 1, 31)
        && matchField(dow, t.getDay(), 0, 6)
        && matchField(h, t.getHours(), 0, 23)
        && matchField(mi, t.getMinutes(), 0, 59)) {
        next3.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
      }
      t = new Date(t.getTime() + 60000);
    }
    return `「${expr}」= ${desc}\n未来执行时间：${next3.length ? next3.join('、') : '（一年内无命中——请检查日/周字段是否互斥过严）'}`;
  },
};

/* =============== 网络查询工具（免费兜底 + 用户 Key 增强） =============== */

/** 天气查询：用户和风天气 Key（user_tool_keys）优先 → wttr.in 免费公共源兜底 */
const weather_query = {
  schema: {
    type: 'function',
    function: {
      name: 'weather_query',
      description: '查询指定城市的当前天气与近三天预报（温度/体感/湿度/风力/天气状况）。国内城市与海外主要城市均支持。可提示用户在「我的模型」页配置和风天气 API Key 获得更稳定服务（未配置时使用免费公共源）。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名（中文或拼音均可，如 北京、上海、Tokyo）' },
        },
        required: ['city'],
      },
    },
  },
  run: async (args, ctx) => {
    const city = String(args.city || '').trim();
    if (!city) return '请提供要查询的城市名';
    // ① 用户自有和风天气 Key（P3-2：user_tool_keys 表，ctx.username 维度，缺省走免费源）
    const qweatherKey = await getUserToolKey(ctx, 'weather_query');
    if (qweatherKey) {
      try {
        const geo = await (await fetch(`https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&key=${qweatherKey}`, { signal: AbortSignal.timeout(8000) })).json();
        if (geo && geo.code === '200' && geo.location && geo.location.length) {
          const loc = geo.location[0];
          const now = await (await fetch(`https://devapi.qweather.com/v7/weather/now?location=${loc.id}&key=${qweatherKey}`, { signal: AbortSignal.timeout(8000) })).json();
          const d3 = await (await fetch(`https://devapi.qweather.com/v7/weather/3d?location=${loc.id}&key=${qweatherKey}`, { signal: AbortSignal.timeout(8000) })).json();
          if (now && now.code === '200') {
            const lines = [`【${loc.name}】当前：${now.now.text}，${now.now.temp}°C（体感 ${now.now.feelsLike}°C），湿度 ${now.now.humidity}%，${now.now.windDir}${now.now.windScale} 级`];
            if (d3 && d3.code === '200' && d3.daily) {
              for (const d of d3.daily.slice(1)) lines.push(`${d.fxDate}：${d.textDay}转${d.textNight}，${d.tempMin}~${d.tempMax}°C`);
            }
            return lines.join('\n') + '\n（数据源：和风天气·用户自有 Key）';
          }
        }
      } catch { /* 用户 Key 路径失败 → 回落免费源 */ }
    }
    // ② 免费兜底：wttr.in（无需 Key，中文格式）
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        headers: { 'User-Agent': 'curl/8.0', 'Accept-Language': 'zh-CN' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const cur = j.current_condition && j.current_condition[0];
      if (!cur) throw new Error('响应缺少 current_condition');
      const lines = [`【${city}】当前：${cur.lang_zh && cur.lang_zh[0] ? cur.lang_zh[0].value : cur.weatherDesc[0].value}，${cur.temp_C}°C（体感 ${cur.FeelsLikeC}°C），湿度 ${cur.humidity}%，风速 ${cur.windspeedKmph} km/h`];
      for (const day of (j.weather || []).slice(1, 3)) {
        lines.push(`${day.date}：${Math.min(...day.hourly.map(h => +h.tempC))}~${Math.max(...day.hourly.map(h => +h.tempC))}°C`);
      }
      return lines.join('\n') + '\n（数据源：wttr.in 免费公共接口。如需更稳定可在「我的模型」页配置和风天气 API Key）';
    } catch (e) {
      return `天气查询失败：${e.message}（可在「我的模型」页配置和风天气 API Key 后重试）`;
    }
  },
};

/** 文本翻译：用户 DeepL Key 优先 → MyMemory 免费兜底 */
const translate_text = {
  schema: {
    type: 'function',
    function: {
      name: 'translate_text',
      description: '翻译文本。支持中↔英/日/韩/法/德/西等常见语言对。短文本即时返回；可提示用户在「我的模型」页配置 DeepL API Key 获得更高质量（未配置时使用免费公共源）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要翻译的文本（≤2000 字符）' },
          to: { type: 'string', description: '目标语言代码，如 zh（中文）/ en（英文）/ ja（日文）/ ko（韩文）/ fr / de / es' },
          from: { type: 'string', description: '源语言代码，缺省自动检测' },
        },
        required: ['text', 'to'],
      },
    },
  },
  run: async (args, ctx) => {
    const text = String(args.text || '').trim();
    const to = String(args.to || '').trim();
    if (!text) return '请提供要翻译的文本';
    if (!to) return '请提供目标语言代码（如 zh / en / ja）';
    if (text.length > 2000) return '文本过长（上限 2000 字符），请分段翻译';
    // ① 用户自有 DeepL Key（P3-2：user_tool_keys）
    const deeplKey = await getUserToolKey(ctx, 'translate_text');
    if (deeplKey) {
      try {
        const body = { text: [text], target_lang: to.toUpperCase() === 'ZH' ? 'ZH' : to.toUpperCase() };
        if (args.from) body.source_lang = String(args.from).toUpperCase();
        const r = await fetch('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${deeplKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const j = await r.json();
          if (j.translations && j.translations.length) {
            return `${j.translations[0].text}\n（DeepL·用户自有 Key，检测源语言：${j.translations[0].detected_source_language}）`;
          }
        }
      } catch { /* 回落免费源 */ }
    }
    // ② 免费兜底：MyMemory（无需 Key，get 参数）
    try {
      const from = args.from ? String(args.from) : 'aut'; // MyMemory 无 aut，先试 zh→to，失败再 en→to
      const attempts = from !== 'aut' ? [[from, to]] : text.match(/[\u4e00-\u9fff]/) ? [['zh', to]] : [['en', to]];
      for (const [f, t] of attempts) {
        const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${f}|${t}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.responseData && j.responseData.translatedText && !/MYMEMORY WARNING/i.test(j.responseData.translatedText)) {
          return `${j.responseData.translatedText}\n（MyMemory 免费公共接口。如需更高质量可在「我的模型」页配置 DeepL API Key）`;
        }
      }
      return '免费翻译源暂不可用或未返回有效译文（可在「我的模型」页配置 DeepL API Key 后重试）';
    } catch (e) {
      return `翻译失败：${e.message}`;
    }
  },
};

/** 汇率换算：frankfurter.app 免费公共源（ECB 欧洲央行日频数据，无需 Key） */
const exchange_rate = {
  schema: {
    type: 'function',
    function: {
      name: 'exchange_rate',
      description: '查询货币汇率并换算金额：人民币 CNY / 美元 USD / 欧元 EUR / 日元 JPY / 英镑 GBP / 港币 HKD 等 30+ 币种。支持「100 美元等于多少人民币」类换算与汇率查询。数据为欧洲央行日频参考价。',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: '金额（默认 1，即查汇率本身）' },
          from: { type: 'string', description: '源货币代码（如 USD、CNY），默认 CNY' },
          to: { type: 'string', description: '目标货币代码（如 CNY、JPY），默认 USD' },
        },
        required: [],
      },
    },
  },
  run: async (args) => {
    const amount = Number.isFinite(Number(args.amount)) ? Number(args.amount) : 1;
    const from = String(args.from || 'CNY').trim().toUpperCase();
    const to = String(args.to || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return '货币代码应为 3 位字母（如 USD、CNY、EUR、JPY）';
    try {
      const r = await fetch(`https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        if (r.status === 404) return `不支持的货币代码：${from} 或 ${to}（常见：CNY/USD/EUR/JPY/GBP/HKD）`;
        throw new Error('HTTP ' + r.status);
      }
      const j = await r.json();
      if (j && j.rates && j.rates[to] !== undefined) {
        const out = Math.round(j.rates[to] * 10000) / 10000;
        return `${amount} ${from} = ${out} ${to}（欧洲央行参考价，${j.date}）`;
      }
      return `汇率响应缺少 ${to} 字段`;
    } catch (e) {
      return `汇率查询失败：${e.message}（frankfurter.app 免费公共源，稍后重试）`;
    }
  },
};

module.exports = { uuid_gen, hash_tool, base64_tool, json_tool, text_count, date_calc, unit_convert, cron_explain, weather_query, translate_text, exchange_rate, getUserToolKey, KEYED_TOOL_META };
