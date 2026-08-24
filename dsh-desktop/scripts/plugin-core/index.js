'use strict';

// ---------------------------------------------------------------------------
// plugin-core 组装根（composition root）：createPluginCenter —— 插件管理
// 子系统的唯一门面。main.js 只做接线（构造 ctx、注册 IPC、挂探针），不持有
// 任何插件管理业务逻辑。
//
// 公共接口与数据流见 docs/plugin-center-architecture.md。本模块不 require
// electron；一切 Electron 能力（dialog / ipcMain / openExternal）经 ctx 注入。
// ---------------------------------------------------------------------------

const path = require('node:path');
const { sharedWriteGate } = require('./lib/fs-atomic');
const { PluginStateStore } = require('./lib/state-store');
const { ManifestStore } = require('./lib/manifest-store');
const { createLifecycle, cleanupStaleTrash } = require('./lib/lifecycle');
const { createQuarantine } = require('./lib/quarantine');
const { collectInventory } = require('./lib/inventory');
const { updatePlugin, checkUpdatesAvailable, cleanupStaleUpdateBackups } = require('./lib/updates');
const { createSupervision } = require('./lib/supervision');
const { PLUGIN_IPC_ACTIONS, CONFIRM_MESSAGES, authorize } = require('./lib/capability');
const { parseMarkers, createMarkerAccumulator } = require('./lib/markers');
const { PluginError, PLUGIN_ERROR_CODES } = require('./lib/errors');
const { scanDir } = require('./lib/scan');
const { removedPluginIdsFromPatch } = require('./lib/patch-surgery');

/**
 * @param {Object} ctx
 * @param {() => string} ctx.getHome            有效 DSH_HOME
 * @param {() => string} ctx.getProfile         profile 名（桌面端恒 'web'）
 * @param {() => string} [ctx.getUserDataDir]   壳层 userData
 * @param {(msg: string) => void} [ctx.log]
 * @param {Object} [ctx.companionPlugins]       配套插件清单（默认 COMPANION_PLUGINS）
 * @param {Object} [ctx.dialogs]                { confirm(message) => Promise<boolean> }
 */
function createPluginCenter(ctx) {
  const {
    getHome,
    getProfile,
    log = () => {},
    companionPlugins = require('../lib/companion-plugins').COMPANION_PLUGINS,
    dialogs = { confirm: async () => false },
    // 内核 agent 回合进行中信号（issue #159）：探活期间内核正思考/压缩
    // （HTTP 无响应）时不得误判假死。由壳层把 session 流式/回合状态接进来。
    getAgentBusy = () => false,
  } = ctx;
  const logTopic = (topic) => (msg) => log(topic, msg);

  const home = () => getHome();
  const profileDir = () => path.join(home(), 'profiles', getProfile());

  const state = new PluginStateStore({ file: path.join(home(), 'desktop-plugin-state.json'), log: logTopic('plugin-state') });
  const manifestStore = new ManifestStore({ profileDir: profileDir(), log: logTopic('plugin-manifest') });
  // patch 与 manifest 各自独立锁（不同文件、不同写入方），但同一进程内共享
  // 同一 gate 实例保证同 key 串行（跨进程经锁文件互斥）。
  const patchGate = sharedWriteGate(profileDir());

  const fs = require('node:fs');
  const readPatch = () => {
    try { return fs.readFileSync(path.join(profileDir(), 'cordis.patch.yml'), 'utf8'); } catch { return ''; }
  };

  /** 当前清单（读改写一致的统一入口）。 */
  const inventoryRows = () => collectInventory({
    profileDir: profileDir(),
    companionPlugins,
    patchText: readPatch(),
    bundles: manifestStore.bundles(),
    state: {
      isUninstalled: (id) => state.isUninstalled(id),
      isQuarantined: (id) => state.isQuarantined(id),
    },
    describe: () => '',
  });

  const lifecycle = createLifecycle({
    profileDir: profileDir(),
    state,
    manifestStore,
    patchGate,
    inventoryRows,
    log: logTopic('plugin-manager'),
  });

  const quarantine = createQuarantine({
    profileDir: profileDir(),
    state,
    gate: patchGate,
    inventoryRows,
    log: logTopic('quarantine'),
  });

  // ── 更新源（与历史 PLUGIN_UPDATE_SOURCES 一致） ─────────────────────────
  const updateSources = {
    'compaction-acp': { kind: 'npm', pkg: 'billion-context-dsh' },
    'better-sidebar': { kind: 'npm', pkg: 'dsh-better-sidebar' },
    'side-session': { kind: 'github', repo: 'hzhz314159/dsh-side-session' },
  };

  const installedVersion = (name) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(profileDir(), 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      if (pkg && pkg.version) return String(pkg.version);
    } catch { /* 读取失败回退资产版本 */ }
    try {
      const rel = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'plugins', rel, 'package.json'), 'utf8'));
      if (pkg && pkg.version) return String(pkg.version);
    } catch { /* 无资产版本 */ }
    return '';
  };

  // 同一插件更新互斥（并发触发直接返回「更新中」，避免目录交错破坏）。
  const updateLocks = new Map();
  const withUpdateLock = (id, fn) => {
    if (updateLocks.has(id)) return Promise.resolve({ ok: false, error: new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BUSY, '该插件正在更新中，请稍候') });
    mutationCount += 1;
    const lock = Promise.resolve().then(fn).finally(() => { updateLocks.delete(id); mutationCount -= 1; });
    updateLocks.set(id, lock);
    return lock;
  };

  const updates = {
    sources: updateSources,
    checkUpdates: () => checkUpdatesAvailable(inventoryRows, updateSources, installedVersion),
    update: async (id, { confirm } = {}) => {
      const row = inventoryRows().find((r) => r.id === id);
      const src = row && updateSources[id];
      if (!row || !src) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '该插件没有可用更新源: ' + id);
      if (row.removed) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_RESTORE_NO_SOURCE, '插件已卸载，请先恢复再更新');
      return withUpdateLock(id, () => updatePlugin({
        id, name: row.name, profileDir: profileDir(), source: src,
        installedVersion: installedVersion(row.name),
        gate: patchGate,
        log: logTopic('plugin-manager'),
        confirm: confirm || (async (findings) => {
          const detail = findings.slice(0, 5).map((f) => f.message).join('\n');
          return dialogs.confirm('更新内容静态扫描发现高危模式：\n' + detail + '\n\n仍要继续更新吗？');
        }),
      }));
    },
  };

  // ── 变更互斥口径（供存活探针 isBusy 使用；实际互斥由 WriteGate / updateLocks 保证） ──
  let mutationCount = 0;
  const wrapMutation = (fn) => {
    mutationCount += 1;
    return Promise.resolve().then(fn).finally(() => { mutationCount -= 1; });
  };
  const isMutating = () => mutationCount > 0;

  const api = {
    state,
    manifestStore,
    patchGate,
    inventory: {
      rows: inventoryRows,
      collect: inventoryRows,
      describe: (id) => inventoryRows().find((r) => r.id === id) || null,
    },
    lifecycle: {
      setEnabled: (id, enabled) => wrapMutation(() => lifecycle.setEnabled(id, enabled)),
      uninstall: (id) => wrapMutation(() => lifecycle.uninstall(id)),
      restore: (id) => wrapMutation(() => lifecycle.restore(id)),
    },
    updates,
    quarantine: {
      apply: (id, info) => wrapMutation(() => quarantine.apply(id, info)),
      applyBySource: (source, info) => wrapMutation(() => quarantine.applyBySource(source, info)),
      clear: (id) => wrapMutation(() => quarantine.clear(id)),
    },
    scan: {
      profile: () => scanDir({
        root: path.join(profileDir(), 'node_modules'),
        builtinNames: new Set(companionPlugins.map((p) => p.name)),
      }),
    },
    markers: { parseMarkers, createMarkerAccumulator },
    isMutating,
    bootCleanup: () => {
      cleanupStaleTrash(profileDir(), { log: logTopic('plugin-manager') });
      cleanupStaleUpdateBackups(profileDir());
    },
    removedIds: () => {
      const fromPatch = removedPluginIdsFromPatch(readPatch());
      for (const id of Object.keys(state.getUninstalled())) fromPatch.add(id);
      return fromPatch;
    },
  };

  // 其余监督参数（intervalMs / graceMs / cooldownMs / failThreshold / probeTimeoutMs /
  // timers）原样透传——调用方（含集成测试的时间压缩注入）不得被门面吞掉。
  api.supervision = ({ getBaseUrl, httpGet, isBusy, onZombie, ...rest }) => createSupervision({
    ...rest,
    getBaseUrl,
    httpGet,
    isBusy: () => (isBusy ? isBusy() : false) || api.isMutating() || getAgentBusy(),
    onZombie,
    log: (m) => log('supervision', m),
  });

  // ── IPC 能力策略（main.js 接线，这里只暴露单一数据源） ─────────────────────
  const ipc = {
    actions: PLUGIN_IPC_ACTIONS,
    confirmMessages: CONFIRM_MESSAGES,
    authorize: (event, deps, action) => authorize(event, deps, action),
  };

  return { ...api, ipc };
}

module.exports = { createPluginCenter };
