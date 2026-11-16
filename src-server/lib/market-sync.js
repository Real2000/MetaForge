/**
 * U2-3 市场同步工具（2026-11-16）
 *
 * 从 market_hubs 中已配置的远程 hub URL 拉取插件/技能清单，
 * 同步到本地 plugins 表。
 *
 * market_hub 远程接口约定：
 *   GET {hub_url}/plugins?t=skill
 *   → { plugins: [{ plugin_id, name, entry, version, author, description, permissions, ... }] }
 */
const { db, now } = require('../db');

async function syncOne(hub) {
  if (!hub || !hub.url || !hub.enabled) return { hub: hub?.id, status: 'skipped', reason: 'hub 未启用或无 URL' };
  try {
    db.prepare("UPDATE market_hubs SET sync_status='syncing' WHERE id=?").run(hub.id);
    const res = await fetch(`${hub.url}/plugins?t=${hub.type || 'skill'}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json.plugins || []);
    let imported = 0;
    for (const item of list) {
      if (!item.plugin_id) continue;
      const exist = db.prepare('SELECT id FROM plugins WHERE plugin_id=?').get(item.plugin_id);
      if (exist) {
        db.prepare('UPDATE plugins SET name=?,version=?,description=?,entry=?,author=?,updated_at=? WHERE id=?')
          .run(item.name || '', item.version || '1.0.0', item.description || '', item.entry || '', item.author || '', now(), exist.id);
      } else {
        db.prepare('INSERT OR IGNORE INTO plugins (plugin_id,name,type,entry,icon,description,version,author,runtime,enabled,installed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)')
          .run(item.plugin_id, item.name || item.plugin_id, 'tool', item.entry || '', item.icon || '🧩', item.description || '', item.version || '1.0.0', item.author || 'system', item.runtime || 'node', now(), now(), now());
      }
      imported++;
    }
    db.prepare("UPDATE market_hubs SET sync_status='success',last_sync_at=? WHERE id=?").run(now(), hub.id);
    return { hub: hub.id, status: 'success', imported };
  } catch (e) {
    db.prepare("UPDATE market_hubs SET sync_status='failed' WHERE id=?").run(hub.id);
    return { hub: hub.id, status: 'failed', error: e.message };
  }
}

async function loadAllSync() {
  const hubs = db.prepare("SELECT * FROM market_hubs WHERE enabled=1").all();
  const results = [];
  for (const hub of hubs) {
    const r = await syncOne(hub);
    results.push(r);
  }
  return { hubs: hubs.length, results };
}

module.exports = { syncOne, loadAllSync };
