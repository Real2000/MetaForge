#!/usr/bin/env bash
# U2-1 / N7-P3 只读副本一次性初始化与校验。
#
# 作用：把主库做一次「一致性快照」生成只读副本文件，并做完整性校验。
#       之后由 litestream 持续同步增量（见 deploy/litestream.yml）。
#
# 用法：
#   AGENT_DATA_DIR=./data REPLICA_DIR=./replica bash scripts/replica-bootstrap.sh
#
# 应用侧启用（指向副本即走读写分离；不设置则回退主库）：
#   export AGENT_DB_READONLY="$(pwd)/replica/platform.db"
#
# 优先使用 sqlite3 CLI（.backup 在线一致性快照）；无 CLI 时回退 node + better-sqlite3。
set -euo pipefail

DATA_DIR="${AGENT_DATA_DIR:-./data}"
REPLICA_DIR="${REPLICA_DIR:-./replica}"
MAIN_DB="${DATA_DIR}/platform.db"
REPLICA_DB="${REPLICA_DIR}/platform.db"

echo "[replica] 主库:   ${MAIN_DB}"
echo "[replica] 副本:   ${REPLICA_DB}"

if [ ! -f "${MAIN_DB}" ]; then
  echo "[replica] 错误：主库不存在（${MAIN_DB}）。请先启动一次平台以初始化数据库。" >&2
  exit 1
fi

mkdir -p "${REPLICA_DIR}"

echo "[replica] 生成一致性快照…"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${MAIN_DB}" ".backup '${REPLICA_DB}'"
  # 副本改为自包含单文件模式，便于以 readonly 方式打开（只读连接无需 -wal/-shm 可写）
  sqlite3 "${REPLICA_DB}" "PRAGMA journal_mode=DELETE;"
  echo "[replica] 已用 sqlite3 .backup 生成副本"
else
  echo "[replica] 未找到 sqlite3 CLI，回退 node + better-sqlite3 在线备份"
  node - "${MAIN_DB}" "${REPLICA_DB}" <<'NODE'
const Database = require('better-sqlite3');
const [main, replica] = process.argv.slice(2);
const db = new Database(main, { readonly: true });
db.backup(replica).then(() => {
  const r = new Database(replica);
  r.pragma('journal_mode = DELETE');
  r.close();
  db.close();
  console.log('[replica] better-sqlite3 在线备份完成');
}).catch(e => { console.error('[replica] 备份失败:', e.message); process.exit(1); });
NODE
fi

if [ ! -f "${REPLICA_DB}" ]; then
  echo "[replica] 错误：副本未生成（${REPLICA_DB}）。" >&2
  exit 1
fi

echo "[replica] 校验副本完整性…"
if command -v sqlite3 >/dev/null 2>&1; then
  RESULT="$(sqlite3 "${REPLICA_DB}" "PRAGMA integrity_check;")"
  echo "[replica] integrity_check => ${RESULT}"
  if [ "${RESULT}" != "ok" ]; then
    echo "[replica] 错误：副本完整性校验未通过。" >&2
    exit 1
  fi
else
  node - "${REPLICA_DB}" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
const r = db.pragma('integrity_check');
db.close();
const ok = Array.isArray(r) ? (r[0] && r[0].integrity_check) : r;
console.log('[replica] integrity_check =>', JSON.stringify(ok));
if (String(ok) !== 'ok') { console.error('[replica] 副本完整性校验未通过'); process.exit(1); }
NODE
fi

echo "[replica] 完成。启用读写分离：export AGENT_DB_READONLY=\"$(cd "$(dirname "${REPLICA_DB}")" && pwd)/$(basename "${REPLICA_DB}")\""
