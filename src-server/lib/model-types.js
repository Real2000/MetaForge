/**
 * 模型类型分类（2026-10-22 P4）：384 全量模型按能力分类，支撑前台四模式模型隔离
 * chat    对话（含多模态 VL 对话模型）
 * image   文生图
 * video   文生视频（minimax h3 / Ref2VA 系列 / 任何 t2v）
 * tts     语音合成
 * embedding/rerank 嵌入与重排（不出现在任何创作下拉）
 * 注：MiniMax-H3-Ascend / minimax h3 实测网关 chat 调用报 t2va 错误 → 归 video
 */
function classifyModel(name) {
  const n = String(name || '').toLowerCase();
  if (/tts|speech|sensevoice|voice|asr|whisper/.test(n)) return 'tts';
  if (/image|绘图|drawing|flux|dall-e|sdxl|sd\b|diffusion/.test(n)) return 'image';
  if (/minimax[\s-]?h\d|ref2va|t2v|a2v|video|wan|pixeldance|hunyuan[-_]?video|kling/.test(n)) return 'video';
  if (/embedding|rerank|bge-|m3e|doc2vec|text2vec/.test(n)) return 'embedding';
  return 'chat';
}

const TYPE_LABEL = { chat: '💬 对话', image: '🎨 生图', video: '🎬 视频', tts: '🎙️ 语音', embedding: '🧠 嵌入' };

module.exports = { classifyModel, TYPE_LABEL };