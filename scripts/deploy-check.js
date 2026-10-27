/**
 * 部署环境自检（P5.20 问题1）：启动前检查 better-sqlite3 原生模块与当前平台匹配
 *
 * 背景：better-sqlite3 是原生 C++ 模块，编译产物绑定平台（darwin/linux × arm64/x64）。
 * 在 Mac 上 npm install 后直接把 node_modules 拷到 Linux 服务器 → 启动报
 * "was compiled against a different Node.js version / NODE_MODULE_VERSION mismatch"
 * 或 "Error: The module was compiled against an incompatible ABI"。
 *
 * 用法：
 *   npm run deploy:check          # 自检（启动前或部署后跑一次）
 *   npm run deploy:linux          # Linux 服务器一键修复：rebuild + 自检
 *
 * 退出码：0 可用 / 1 需 rebuild（CI 里可直接当门禁）
 */
const os = require('os');
const path = require('path');

function main() {
  const plat = `${os.platform()}-${os.arch()}`;
  let loaded = false;
  let err = null;
  try {
    require('better-sqlite3');
    loaded = true;
  } catch (e) {
    err = e;
  }
  console.log(`[deploy-check] 平台：${plat} · Node：${process.version}（NODE_MODULE_VERSION ${process.versions.modules}）`);
  if (loaded) {
    console.log('[deploy-check] ✅ better-sqlite3 原生模块可用，可直接 npm start');
    process.exit(0);
  }
  console.log('[deploy-check] ❌ better-sqlite3 原生模块不可用（跨平台拷贝产物或 Node 大版本变更）：');
  console.log('             ' + String(err && err.message || err).split('\n').slice(0, 3).join('\n             '));
  console.log('[deploy-check] 修复（在目标服务器上执行其一）：');
  console.log('   ① npm run deploy:linux            # 一键 rebuild（推荐，需可联网/有构建工具）');
  console.log('   ② npm rebuild better-sqlite3 --update-binary');
  console.log('   ③ rm -rf node_modules && npm install --omit=dev');
  console.log('[deploy-check] 提示：无构建工具的极简环境可用 prebuilt 二进制（npm i better-sqlite3 --update-binary 会拉平台预编译包）；');
  console.log('             打包分发请排除 node_modules/better-sqlite3/build，目标环境自行编译。');
  process.exit(1);
}
main();
