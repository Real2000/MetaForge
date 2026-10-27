/** @技能名 解析（2026-10-20 P3 技能资产化）
 *  从用户输入中提取 @ 标记，在技能池中匹配（本人技能优先 → 他人已发布技能）。
 *  返回 { skills, content }：
 *   - skills：命中的技能资产（去重，保持出现顺序）
 *   - content：移除已命中标记后的内容（送模型用；用户消息原文在调用方保留展示）
 *  边界规则：@ 必须出现在行首或空白/左括号之后——邮箱 user@example.com、
 *  代码 @装饰器 等不会误触；未命中的 @标记 原样保留（交给模型自然回应）。
 */
function parseSkillMentions(input, pool, username) {
  let content = String(input || '');
  const skills = [];
  const pool_ = Array.isArray(pool) ? pool : [];
  const markers = [...content.matchAll(/(?:^|[\s（(【\[])@([\w\u4e00-\u9fa5-]{1,20})/g)];
  for (const m of markers) {
    const name = m[1];
    const hit = pool_.find(s => s.owner === username && s.name === name) || pool_.find(s => s.name === name);
    if (hit && !skills.some(s => s.id === hit.id)) {
      skills.push(hit);
      content = content.split('@' + name).join(''); // 移除全部同标记出现
    }
  }
  return { skills, content };
}

module.exports = { parseSkillMentions };

/** @专家名 解析（P5.24 指定专家：镜像 @技能 机制）
 *  从（已剥离技能标记的）输入中提取剩余 @ 标记，在「已发布且公开」的智能体池中匹配。
 *  返回 { agents, content }：
 *   - agents：命中的智能体（去重，保持出现顺序）——调用方把其 prompt 作为专家设定注入 system
 *   - content：移除已命中标记后的内容
 *  边界规则与 parseSkillMentions 一致（行首/空白/左括号后；未命中原样保留）；
 *  同名时技能先解析（调用顺序保证），专家池仅公开已发布——restricted 智能体提示词不外泄。
 */
function parseAgentMentions(input, pool) {
  let content = String(input || '');
  const agents = [];
  const pool_ = Array.isArray(pool) ? pool : [];
  const markers = [...content.matchAll(/(?:^|[\s（(【\[])@([\w\u4e00-\u9fa5-]{1,20})/g)];
  for (const m of markers) {
    const name = m[1];
    const hit = pool_.find(a => a.name === name);
    if (hit && !agents.some(a => a.id === hit.id)) {
      agents.push(hit);
      content = content.split('@' + name).join('');
    }
  }
  return { agents, content };
}

module.exports.parseAgentMentions = parseAgentMentions;
