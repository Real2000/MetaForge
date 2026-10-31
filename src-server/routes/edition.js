/** 版本 / License 管理端点（V2.3 Y7 2026-10-31）：License 文件替换后免重启生效
 *  对标 MaxKB 专业版「上传 License 即切换版本」体验——本路由把 lib/edition.js 的运行态能力暴露为 HTTP：
 *  - GET  /api/edition          当前版本快照（登录即可访问）：
 *                               普通用户返回脱敏字段（edition/name/licensed/reason/days_left）；
 *                               管理员（role=admin）额外返回 customer/expires_at/license_key（完整快照）。
 *  - POST /api/edition/reload   热重载 License（仅管理员）：清缓存重读 data/license.json 重验签，
 *                               License 文件替换后无需重启进程即生效。
 *  安全口径：
 *  - reload 是管理操作必须审计——写 op_logs（action='License热重载'，detail 记重载后版本与原因/到期），
 *    私有化部署下「谁在何时把部署切到哪个版本」是商用授权的追溯链；
 *  - GET 对普通用户脱敏——customer/到期日/License 编号属授权商业信息，防普通用户探测授权详情
 *    （license_key 本身在 lib/edition.js 即只留前缀展示，双层防泄露）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { currentEdition, refreshLicense, reasonDescription } = require('../lib/edition');

const router = express.Router();
router.use(auth); // 登录即可访问（读版本状态无越权面；reload 路由内再收紧到管理员）

/** 普通用户脱敏快照：不含 customer/expires_at/license_key/days_left（防探测授权商业信息）
 *  V2.3 审查加固（P1-3/S2-2）：days_left 移出白名单——剩余天数可反推到期日（今天+days_left 即 expires_at），
 *  掩 expires_at 却暴露其等价信息与脱敏目标自相矛盾；前端当前无 days_left 消费者，零 UI 回归 */
function maskedSnapshot(cur) {
  return { edition: cur.edition, name: cur.name, licensed: cur.licensed, reason: cur.reason };
}

/* ---------------- 版本快照 ---------------- */
router.get('/', (req, res) => {
  const cur = currentEdition();
  // 管理员返回完整快照（含 customer/expires_at/license_key 前缀），普通用户脱敏
  res.json({ code: 0, data: req.user.role === 'admin' ? cur : maskedSnapshot(cur) });
});

/* ---------------- License 热重载（仅管理员） ---------------- */
router.post('/reload', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.json({ code: 403, msg: '仅管理员可热重载 License' });
  }
  const cur = refreshLicense();
  // 审计 detail 口径：有效 License 记「专业版（到期 2027-10-31）」；降级态记「社区版（原因：未找到 license.json）」
  const detail = cur.licensed
    ? `${cur.name}（到期 ${cur.expires_at}）`
    : `社区版（原因：${reasonDescription(cur.reason)}）`;
  try {
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.username, 'License热重载', detail, req.ip, now());
  } catch (e) {
    console.warn('[edition] 热重载审计写入失败（不影响重载结果）：' + e.message);
    // V2.3 审查加固（S3-3）：双通道痕迹——op_logs 写失败时补写 err_logs（不同表更可能成功），
    // 避免磁盘满/锁等存储异常时热重载操作完全无痕
    try { db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('edition', `License热重载审计写入失败（${req.user.username}：${detail}）：${e.message}`, now()); } catch { }
  }
  res.json({ code: 0, msg: 'License 已热重载', data: cur }); // 管理员视角完整快照
});

module.exports = router;
