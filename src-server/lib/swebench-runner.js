/**
 * D3-4 增强：SWE-bench-lite 真实 runner 接入适配器（2026-11-21）
 *
 * 设计取舍：平台**不捆绑** SWE-bench harness（保持零第三方依赖 / 离线友好）；
 * 通过可配置的**外部命令**驱动真实执行，平台负责协议、解析与结果归一化。
 *
 * 协议（runner bridge）：
 *   - 平台把 SWE-bench-lite instances JSON 数组写入子进程 stdin，随后关闭 stdin；
 *   - runner 应向 stdout 输出 JSON（数组或 {predictions:[...]}）：
 *       [{ "instance_id": "...", "resolved": true, "passed_tests": 2, "steps": 5, "intervened": false }, ...]
 *     （允许 stdout 夹杂日志行，平台会尝试解析最后一个合法 JSON）
 *   - 平台按 sweBenchLiteToCases 归一为内部用例 → 指标 → 可选落为发布基线。
 *
 * 配置：环境变量 SWEBENCH_RUNNER_CMD（如 "python3 run_swebench.py --dataset lite"）；
 *       亦可在 API 请求体显式传 command（管理员）做临时执行。
 * 未配置命令时返回明确的未接入提示（不抛错、不阻断其他功能）。
 */
const { spawn } = require('child_process');
const evalSuite = require('./eval-suite');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;   // 单次 runner 默认超时 10 分钟
const MAX_STDIN_BYTES = 20 * 1024 * 1024;    // 输入 instances 上限 20MB
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;   // 输出上限 20MB

/** 已配置的 runner 命令（环境变量） */
function runnerCommand() {
  return String(process.env.SWEBENCH_RUNNER_CMD || '').trim();
}

/** 能力探测：是否已接入 runner（含命令与说明，不实际执行） */
function runnerProbe() {
  const cmd = runnerCommand();
  return {
    configured: !!cmd,
    command: cmd,
    bundled: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    protocol: 'stdin=instances JSON[] → stdout=predictions JSON',
    note: cmd
      ? '已配置外部 SWE-bench-lite runner 命令；执行时按协议驱动真实 harness。'
      : '未配置 runner：平台不捆绑 SWE-bench harness（零依赖）。设置环境变量 SWEBENCH_RUNNER_CMD，或在执行请求中显式提供 command 即可接入真实执行。',
  };
}

/** 尝试从 runner 输出中解析 predictions JSON（容忍日志行） */
function parseRunnerOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  let v = tryParse(s);
  if (v === undefined) {
    // 取“最后一行的合法 JSON”（常见：日志在前、结果在后）
    const lines = s.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l || (l[0] !== '[' && l[0] !== '{')) continue;
      v = tryParse(l);
      if (v !== undefined) break;
    }
  }
  if (v === undefined) return null;
  const arr = Array.isArray(v) ? v : (Array.isArray(v.predictions) ? v.predictions : (Array.isArray(v.results) ? v.results : null));
  return arr;
}

/**
 * 执行 SWE-bench-lite runner（异步）。
 * @param {{instances:Array, command?:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, configured:boolean, command:string, predictions?:Array, cases?:Array, metrics?:object, raw?:string, error?:string, exitCode?:number}>}
 */
function runSweBenchLite(opts = {}) {
  const instances = Array.isArray(opts.instances) ? opts.instances : [];
  const command = String(opts.command || runnerCommand()).trim();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), DEFAULT_TIMEOUT_MS);
  if (!command) {
    return Promise.resolve({ ok: false, configured: false, command: '', error: '未配置 runner 命令（设置环境变量 SWEBENCH_RUNNER_CMD 或在请求中提供 command）' });
  }
  if (!instances.length) {
    return Promise.resolve({ ok: false, configured: true, command, error: 'instances 为空，无可执行实例' });
  }
  const input = JSON.stringify(instances);
  if (Buffer.byteLength(input) > MAX_STDIN_BYTES) {
    return Promise.resolve({ ok: false, configured: true, command, error: `instances 过大（> ${Math.round(MAX_STDIN_BYTES / 1024 / 1024)}MB）` });
  }

  return new Promise((resolve) => {
    let child;
    try {
      // shell=true 以支持带参数的命令；命令为管理员配置/提供，非终端用户输入
      child = spawn(command, { shell: true, env: process.env });
    } catch (e) {
      return resolve({ ok: false, configured: true, command, error: '无法启动 runner：' + e.message });
    }
    let out = '', err = '', done = false, truncated = false;
    const finish = (payload) => { if (done) return; done = true; clearTimeout(timer); resolve(payload); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { }
      finish({ ok: false, configured: true, command, error: `runner 执行超时（> ${Math.round(timeoutMs / 1000)}s）`, raw: out.slice(-2000) });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (out.length < MAX_STDOUT_BYTES) out += d.toString(); else truncated = true;
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, configured: true, command, error: 'runner 进程错误：' + e.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        return finish({ ok: false, configured: true, command, error: `runner 退出码 ${code}`, raw: (out + '\n' + err).slice(-3000), exitCode: code });
      }
      const predictions = parseRunnerOutput(out);
      if (!predictions) {
        return finish({ ok: false, configured: true, command, error: 'runner 未输出可解析的 predictions JSON', raw: out.slice(-2000), exitCode: code });
      }
      const cases = evalSuite.sweBenchLiteToCases(predictions);
      return finish({ ok: true, configured: true, command, predictions, cases, metrics: evalSuite.computeMetrics(cases), raw: truncated ? out.slice(0, 2000) + '…(截断)' : '', exitCode: code });
    });

    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch (e) {
      try { child.kill('SIGKILL'); } catch { }
      finish({ ok: false, configured: true, command, error: '写入 runner stdin 失败：' + e.message });
    }
  });
}

module.exports = { DEFAULT_TIMEOUT_MS, runnerCommand, runnerProbe, parseRunnerOutput, runSweBenchLite };
