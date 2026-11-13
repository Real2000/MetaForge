/**
 * P2-24 媒体后处理模块（2026-11-13）
 *
 * 封装 ffmpeg/ffprobe 调用，提供转码、压缩、抽帧、音频处理功能。
 * 依赖运行时环境安装的 ffmpeg（未安装时功能降级返回错误，不崩溃）。
 *
 * 用法：
 *   const media = require('./lib/media');
 *   await media.transcode({ input: '/tmp/video.mp4', output: '/tmp/video.webm', format: 'webm', quality: 22 });
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);

/** 检查 ffmpeg 是否在 PATH 中 */
async function checkFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch { return false; }
}

/** 检查 ffprobe 是否在 PATH 中 */
async function checkFfprobe() {
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    return true;
  } catch { return false; }
}

let ffmpegChecked = false;
let ffmpegAvailable = false;

async function ensureFfmpeg() {
  if (!ffmpegChecked) {
    ffmpegAvailable = await checkFfmpeg();
    ffmpegChecked = true;
  }
  if (!ffmpegAvailable) throw new Error('ffmpeg 不可用，请先安装 ffmpeg（brew install ffmpeg / apt install ffmpeg）');
  return true;
}

/**
 * 获取媒体文件信息（ffprobe）
 * @param {string} input - 输入文件路径
 * @returns {object} { format, duration, width, height, bitrate, codec }
 */
async function probe(input) {
  await ensureFfmpeg();
  await checkFfprobe();
  // 用 ffprobe 获取 JSON 格式的信息
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      input,
    ], { timeout: 10000 });
    const info = JSON.parse(stdout);
    const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
    const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');
    return {
      format: info.format?.format_name || '',
      duration: parseFloat(info.format?.duration || 0),
      size: parseInt(info.format?.size || 0),
      bitrate: parseInt(info.format?.bit_rate || 0),
      video: videoStream ? {
        codec: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        fps: eval(videoStream.r_frame_rate) || 0, // "24000/1001" → 23.97
      } : null,
      audio: audioStream ? {
        codec: audioStream.codec_name,
        channels: audioStream.channels,
        sampleRate: parseInt(audioStream.sample_rate || 0),
      } : null,
    };
  } catch (e) {
    throw new Error(`ffprobe 失败：${e.message}`);
  }
}

/**
 * 执行 ffmpeg 命令（通用封装）
 * @param {string[]} args - ffmpeg 参数数组
 * @param {object} [opts] - 选项 { timeoutMs } 
 * @returns {Promise<string>} stdout
 */
async function runFfmpeg(args, opts = {}) {
  await ensureFfmpeg();
  const { stdout, stderr } = await execFileAsync('ffmpeg', args, {
    timeout: opts.timeoutMs || 30000,
    maxBuffer: 1024 * 1024 * 10, // 10MB
  });
  return stdout || stderr;
}

/**
 * 视频转码
 * @param {object} params
 * @param {string}  params.input     - 源文件路径
 * @param {string}  params.output    - 目标文件路径
 * @param {string}  [params.format]  - 目标格式（webm/mp4/avi）
 * @param {number}  [params.quality] - CRF 质量（0-51，越小质量越好，默认 23）
 * @param {number}  [params.width]   - 宽度限制（按比例缩放）
 * @param {number}  [params.height]  - 高度限制（按比例缩放）
 * @param {boolean} [params.trimTo]    - 裁剪到多少秒（可选）
 * @returns {Promise<{output:string, info:object}>}
 */
async function transcode({ input, output, format, quality, width, height, trimTo }) {
  const args = ['-i', input];
  if (width) args.push('-vf', `scale=${width}:-2`);
  if (height) args.push('-vf', `scale=-2:${height}`);
  if (quality !== undefined) args.push('-crf', String(quality));
  if (format === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0');
  if (format === 'mp4') args.push('-c:v', 'libx264');
  if (trimTo) args.push('-t', String(trimTo));
  args.push('-y', output);
  await runFfmpeg(args, { timeoutMs: 60000 });
  // 返回输出文件信息
  const st = fs.statSync(output);
  const info = {
    size: st.size,
    path: output,
  };
  return { output, info };
}

/**
 * 视频压缩（转码 + 降低质量到指定目标文件大小）
 * @param {object} params
 * @param {string}  params.input      - 源文件路径
 * @param {string}  params.output     - 目标文件路径
 * @param {number}  [params.maxSizeMB] - 目标大小上限（MB）
 * @returns {Promise<object>}
 */
async function compress({ input, output, maxSizeMB }) {
  // 先用默认质量转码，如果太大则逐步提高 CRF（降低质量）
  const targetBytes = (maxSizeMB || 20) * 1048576;
  for (let crf of [23, 28, 32, 35, 40]) {
    await transcode({ input, output, quality: crf, format: 'mp4' });
    const st = fs.statSync(output);
    if (st.size <= targetBytes) {
      return { output, size: st.size, crf, success: true };
    }
  }
  // 最后尝试一次极限压缩
  await transcode({ input, output, quality: 45, format: 'mp4', width: 640 });
  const st = fs.statSync(output);
  return { output, size: st.size, crf: 45, success: st.size <= targetBytes, note: '极限压缩模式' };
}

/**
 * 视频抽帧（每隔 n 秒取一帧图像）
 * @param {object} params
 * @param {string}  params.input     - 源文件路径
 * @param {string}  params.outputDir - 输出目录
 * @param {number}  params.interval  - 间隔秒数（默认 10）
 * @returns {Promise<string[]>} 生成的文件路径列表
 */
async function extractFrames({ input, outputDir, interval = 10 }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const pat = path.join(outputDir, 'frame_%04d.png');
  await runFfmpeg(['-i', input, '-vf', `fps=1/${interval}`, '-q:v', '2', '-y', pat], { timeoutMs: 120000 });
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('frame_')).sort().map(f => path.join(outputDir, f));
  return files;
}

/**
 * 音频提取 / 转码
 * @param {object} params
 * @param {string}  params.input     - 源文件路径
 * @param {string}  params.output    - 目标文件路径
 * @param {string}  [params.format]  - 目标格式（mp3/wav/aac/ogg）
 * @param {number}  [params.bitrate] - 比特率（如 128k/192k/320k）
 * @returns {Promise<object>}
 */
async function extractAudio({ input, output, format, bitrate }) {
  const args = ['-i', input, '-vn']; // 去除视频流
  if (bitrate) args.push('-b:a', String(bitrate));
  args.push('-y', output);
  await runFfmpeg(args, { timeoutMs: 60000 });
  const st = fs.statSync(output);
  return { output, size: st.size };
}

module.exports = {
  ensureFfmpeg, probe, transcode, compress, extractFrames, extractAudio, runFfmpeg, checkFfmpeg, checkFfprobe,
};