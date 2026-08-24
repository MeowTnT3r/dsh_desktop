'use strict';

// dsh-community-market 更新链路单测（#161「插件市场无法更新」修复验证）：
//   A. checkUpdates 命中新版本（catalog latestVersion > receipt.version 严格升格）；
//   B. checkUpdates 不误报（同版本 / 降级均不判为可更新）；
//   C. previewUpdate 走 verifier（下载+完整性）并产出 update intent；
//   D. executeUpdate 成功：pnpm.updatePlugin 精确版本 + 回执版本上移；
//   E. executeUpdate 失败回滚：pnpm 失败 → rollbackPluginUpdate 还原旧版本、
//      回执保持不变。
// 用法：node --test scripts/test/unit-community-market-update.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginsRoot = process.env.DSH_MARKET_TEST_PLUGINS
  ? path.resolve(process.env.DSH_MARKET_TEST_PLUGINS)
  : path.join(repoRoot, 'assets', 'plugins');
const marketDir = path.join(pluginsRoot, 'dsh-community-market');
const bridgeDir = path.join(pluginsRoot, 'dsh-market-desktop-bridge');

let marketInternals;
let bridgeInternals;
test.before(async () => {
  const market = await import(pathToFileURL(path.join(marketDir, 'lib', 'index.js')).href);
  const bridge = await import(pathToFileURL(path.join(bridgeDir, 'lib', 'index.js')).href);
  marketInternals = market.__internals;
  bridgeInternals = bridge.__internals;
  assert.ok(marketInternals && typeof marketInternals.MarketInstallService === 'function', 'market __internals 需暴露 MarketInstallService');
  assert.ok(bridgeInternals && typeof bridgeInternals.updateAddCommand === 'function', 'bridge __internals 需暴露 updateAddCommand');
});

const PROFILE_NAME = 'web';
const PACKAGE = 'example-community-plugin';
const RECEIPT_ID = 'receipt-0000000001';
const SOURCE_RECORD_ID = 'source-0001';
const PROVIDER_ID = 'provider-0001';
const ITEM_ID = 'item-0001';

// 合法 sha512 integrity（64 字节 digest 的规范 base64）与安全 bundle patch 相对路径。
const sha512Integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const bundlePatch = 'cordis.patch.yml';

function makeReceipt(version = '1.0.0') {
  return {
    receiptId: RECEIPT_ID,
    profileName: PROFILE_NAME,
    packageName: PACKAGE,
    version,
    integrity: sha512Integrity,
    bundlePatch,
    sourceRecordId: SOURCE_RECORD_ID,
    providerId: PROVIDER_ID,
    itemId: ITEM_ID,
    displayName: 'Example Community Plugin',
    installedAt: new Date(0).toISOString(),
  };
}

function makeSnapshot(latestVersion) {
  return {
    source: { sourceRecordId: SOURCE_RECORD_ID, providerId: PROVIDER_ID },
    items: [{
      id: ITEM_ID,
      displayName: 'Example Community Plugin',
      provenance: { sourceRecordId: SOURCE_RECORD_ID, providerId: PROVIDER_ID, itemId: ITEM_ID },
      package: { registry: 'npm', name: PACKAGE },
      latestVersion,
      repository: { url: 'https://github.com/example/community-plugin.git' },
    }],
  };
}

function makeVerifier(version = '1.1.0') {
  return {
    async verify(candidate) {
      return {
        integrity: sha512Integrity,
        bundlePatch,
        tarball: `https://registry.npmjs.org/${encodeURIComponent(candidate.packageName)}/-/${candidate.packageName.split('/').pop()}-${version}.tgz`,
      };
    },
  };
}

function okHandle(exitCode = 0) {
  return {
    stdout: { resume() {} },
    stderr: { resume() {} },
    cancel() {},
    done: Promise.resolve({ exitCode, signal: null }),
  };
}

function makePnpm() {
  const calls = { updatePlugin: [], rollbackPluginUpdate: [], runPlugin: [] };
  const pnpm = {
    recoveredInstallReceiptIds: async () => [],
    acknowledgeRecoveredInstall: async () => {},
    runPlugin(args) { calls.runPlugin.push(args); return okHandle(); },
    installPlugin: async () => okHandle(),
    rollbackPluginInstall: async () => true,
    updatePlugin(req) { calls.updatePlugin.push(req); return okHandle(); },
    rollbackPluginUpdate(receiptId) { calls.rollbackPluginUpdate.push(receiptId); return Promise.resolve(true); },
  };
  pnpm.__calls = calls;
  return pnpm;
}

function makeService({ receipts, pnpm, verifier, assertInstalled } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-update-test-'));
  const state = { installReceipts: receipts ?? [makeReceipt()] };
  const scope = {
    get: () => state,
    update: async (partial) => { Object.assign(state, partial); },
  };
  const service = new marketInternals.MarketInstallService(
    scope,
    () => ({ name: PROFILE_NAME, dir: profileDir }),
    pnpm ?? makePnpm(),
    verifier ?? makeVerifier(),
    { assertInstalled: assertInstalled ?? (async () => {}), disabledPackageNames: () => [] },
  );
  return { service, scope, profileDir };
}

test('桥 updateAddCommand 产出精确版本 add 命令', () => {
  assert.deepStrictEqual(
    bridgeInternals.updateAddCommand('example-pkg', '2.0.0', ['--registry=https://registry.npmjs.org/']),
    ['add', 'example-pkg@2.0.0', '--save-exact', '--registry=https://registry.npmjs.org/'],
  );
});

test('A checkUpdates 命中新版本（catalog latest > installed）', async () => {
  const { service } = makeService();
  service.observeCatalog(makeSnapshot('1.1.0'));
  const updates = await service.checkUpdates();
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].packageName, PACKAGE);
  assert.strictEqual(updates[0].version, '1.0.0');
  assert.strictEqual(updates[0].latestVersion, '1.1.0');
  assert.strictEqual(updates[0].updateAvailable, true);
});

test('B checkUpdates 不误报：同版本 / 降级均不判为可更新', async () => {
  const { service } = makeService();
  service.observeCatalog(makeSnapshot('1.0.0'));
  assert.deepStrictEqual(await service.checkUpdates(), []);
  service.observeCatalog(makeSnapshot('0.9.0'));
  assert.deepStrictEqual(await service.checkUpdates(), []);
});

test('C previewUpdate 走 verifier（下载）并产出 update intent', async () => {
  let verifyCalls = 0;
  const verifier = {
    async verify(candidate) {
      verifyCalls += 1;
      return { integrity: sha512Integrity, bundlePatch, tarball: `https://registry.npmjs.org/${candidate.packageName}/-/${candidate.packageName}-1.1.0.tgz` };
    },
  };
  const { service } = makeService({ verifier });
  service.observeCatalog(makeSnapshot('1.1.0'));
  const preview = await service.previewUpdate(RECEIPT_ID, new AbortController().signal);
  assert.strictEqual(preview.action, 'update');
  assert.strictEqual(preview.fromVersion, '1.0.0');
  assert.strictEqual(preview.version, '1.1.0');
  assert.strictEqual(verifyCalls, 1);
  assert.ok(preview.intent && preview.intent.length > 0, '产出 intent token');
});

test('C2 previewUpdate 无更新目标时拒绝（not-available）', async () => {
  const { service } = makeService();
  // 未扫描目录 → 无候选。
  await assert.rejects(
    () => service.previewUpdate(RECEIPT_ID, new AbortController().signal),
    (err) => err.code === 'not-available',
  );
});

test('D executeUpdate 成功：pnpm.updatePlugin 精确版本 + 回执版本上移', async () => {
  const pnpm = makePnpm();
  const { service, scope } = makeService({ pnpm });
  service.observeCatalog(makeSnapshot('1.1.0'));
  const preview = await service.previewUpdate(RECEIPT_ID, new AbortController().signal);
  const result = await service.executeUpdate(preview.intent, new AbortController().signal);
  assert.strictEqual(result.receipt.version, '1.1.0');
  assert.strictEqual(scope.get().installReceipts[0].version, '1.1.0');
  const req = pnpm.__calls.updatePlugin[0];
  assert.strictEqual(req.packageName, PACKAGE);
  assert.strictEqual(req.packageVersion, '1.1.0');
  assert.strictEqual(req.previousVersion, '1.0.0');
  assert.strictEqual(req.receiptId, RECEIPT_ID);
  assert.deepStrictEqual(pnpm.__calls.rollbackPluginUpdate, [], '成功路径不回滚');
});

test('E executeUpdate 失败回滚：pnpm 失败 → rollbackPluginUpdate 还原 + 回执不变', async () => {
  const pnpm = makePnpm();
  pnpm.updatePlugin = (req) => {
    pnpm.__calls.updatePlugin.push(req);
    return okHandle(1); // 非零退出码 → pnpm 更新失败
  };
  const { service, scope } = makeService({ pnpm });
  service.observeCatalog(makeSnapshot('1.1.0'));
  const preview = await service.previewUpdate(RECEIPT_ID, new AbortController().signal);
  await assert.rejects(
    () => service.executeUpdate(preview.intent, new AbortController().signal),
    (err) => err.code === 'operation-failed',
  );
  assert.deepStrictEqual(pnpm.__calls.rollbackPluginUpdate, [RECEIPT_ID], '失败路径调用 rollbackPluginUpdate 还原旧版本');
  assert.strictEqual(scope.get().installReceipts[0].version, '1.0.0', '回执保持旧版本');
});

test('F executeUpdate 更新后完整性校验失败 → 回滚旧版本', async () => {
  const pnpm = makePnpm();
  // 旧版本校验通过、新版本校验失败：模拟「pnpm 装完但 bundle 无效」。
  const assertInstalled = async (_profile, _pkg, version) => {
    if (version === '1.1.0') throw new Error('updated bundle invalid');
  };
  const { service, scope } = makeService({ pnpm, assertInstalled });
  service.observeCatalog(makeSnapshot('1.1.0'));
  const preview = await service.previewUpdate(RECEIPT_ID, new AbortController().signal);
  await assert.rejects(
    () => service.executeUpdate(preview.intent, new AbortController().signal),
    (err) => err.code === 'operation-failed',
  );
  assert.deepStrictEqual(pnpm.__calls.rollbackPluginUpdate, [RECEIPT_ID], '完整性校验失败后回滚旧版本');
  assert.strictEqual(scope.get().installReceipts[0].version, '1.0.0', '回执保持旧版本');
});

// ---------------------------------------------------------------------------
// 客户端接线（K21）回归：#161 端到端可点「更新」所需的三个补点。
//   G. installations 路由合并：复用缓存目录索引补 candidates → checkUpdates 命中 →
//      mergeInstallationUpdates 把 updateAvailable/latestVersion 合并进受管条目；
//   H. mergeInstallationUpdates 只合并受管回执、不误改 external/immutable；
//   I. 客户端 bundle 静态接线：更新按钮 / update 预览 / 错误码中文文案。
// ---------------------------------------------------------------------------

/** 模拟 installations 路由复用的「缓存目录索引」（cachedScanView 形态，不触发 observeSnapshot）。 */
function makeIndex(latestVersion) {
  const snapshot = makeSnapshot(latestVersion);
  return {
    source: snapshot.source,
    snapshots: [snapshot],
    scannedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    cacheStatus: 'cached',
  };
}

test('G installations 合并：缓存索引补 candidates → checkUpdates → 合并 updateAvailable', async () => {
  const { service } = makeService();
  // 关键：不经过 observeCatalog/observeSnapshot（模拟缓存命中），仅凭 index.snapshots 补 candidates。
  await service.listInstallable(makeIndex('1.1.0'), new AbortController().signal);
  const updates = await service.checkUpdates();
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].latestVersion, '1.1.0');

  const installations = marketInternals.reconcileInstallations(
    [makeReceipt()],
    [{ bundleId: 'bundle-1', packageName: PACKAGE, status: 'active', mutable: true }],
  );
  assert.strictEqual(installations.length, 1);
  assert.strictEqual(installations[0].kind, 'managed');

  const merged = marketInternals.mergeInstallationUpdates(installations, updates);
  assert.strictEqual(merged[0].updateAvailable, true);
  assert.strictEqual(merged[0].latestVersion, '1.1.0');
});

test('G2 mergeInstallationUpdates 只合并受管回执，不误改 external', () => {
  const managed = { kind: 'managed', status: 'active', action: 'uninstall', disableBundleId: 'bundle-1', receipt: makeReceipt() };
  const external = { kind: 'external', status: 'active', action: 'disable', bundleId: 'bundle-2', packageName: 'other-plugin' };
  const updates = [{ receiptId: RECEIPT_ID, packageName: PACKAGE, displayName: 'Example Community Plugin', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }];
  const merged = marketInternals.mergeInstallationUpdates([managed, external], updates);
  assert.strictEqual(merged[0].updateAvailable, true);
  assert.strictEqual(merged[0].latestVersion, '1.1.0');
  assert.strictEqual(merged[1].updateAvailable, undefined, 'external 不携带 updateAvailable');
  assert.strictEqual(merged[1].latestVersion, undefined, 'external 不携带 latestVersion');
});

test('I 客户端 bundle 接线：更新按钮 / update 预览 / 错误码中文文案', () => {
  const client = fs.readFileSync(path.join(marketDir, 'lib', 'client.js'), 'utf8');
  // update 错误码 → 中文文案映射表（旧 dshmarket updates.js 错误码兜底）。
  assert.ok(client.includes('UPDATE_ERROR_MESSAGE_KEYS'), '存在 update 错误码映射表');
  assert.ok(client.includes('updateErrorIntegrityMismatch'), '存在 UPDATE_INTEGRITY_MISMATCH 文案键');
  assert.ok(client.includes('updateErrorPackageMismatch'), '存在 UPDATE_PACKAGE_MISMATCH 文案键');
  assert.ok(client.includes('updateErrorRollbackFailed'), '存在 UPDATE_ROLLBACK_FAILED 文案键');
  // beginOperationPreview 的 update 错误兜底文案 + executeError 透传映射。
  assert.ok(client.includes('action === "update" ? "updatePreviewError"'), 'beginOperationPreview 缺 update 文案已补');
  // installed 视图「更新」按钮与 preview({action:'update'}) 接线。
  assert.ok(client.includes('onUpdate: (receipt) =>'), 'installed 视图 onUpdate 处理器存在');
  assert.ok(client.includes('action: "update"'), 'update action 预览接线存在');
  assert.ok(client.includes('updateAvailable === true'), '更新按钮渲染条件存在');
});

