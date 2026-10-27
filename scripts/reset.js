/** 重置数据库（删除后重启自动重建种子数据） */
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, '..', 'data');
if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true });
  console.log('[reset] data/ 已删除，重启服务后将自动重建种子数据');
} else {
  console.log('[reset] data/ 不存在，无需重置');
}
