'use strict';

// dsh-market-desktop-bridge（市场桌面服务桥）单测：
//   A. patch 手术：parsePatchRows / disableInPatch / enableInPatch 对真实形态
//      的 cordis.patch.yml（insert 块 + 顶层禁用块 + preset 禁用行）解析与
//      幂等往返（与壳层 patch-surgery.togglePluginInPatch 同文件格式语义）；
//   B. 包元数据：hub 登记（inspectCompanionMeta 同源规则）——name/version
//      精确 semver/description/private，配套清单 id 与 cordis.patch.yml 一致；
//   C. 与壳层 patch-surgery 的双向兼容：本桥写入的禁用块可被壳层
//      togglePluginInPatch(enable) 消费，反之亦然。
// 用法：node --test scripts/test/unit-market-desktop-bridge.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
// 解析沙箱覆盖（与 unit-community-market.test.js 同约定）。
const pluginsRoot = process.env.DSH_MARKET_TEST_PLUGINS
  ? path.resolve(process.env.DSH_MARKET_TEST_PLUGINS)
  : path.join(repoRoot, 'assets', 'plugins');
const bridgeDir = path.join(pluginsRoot, 'dsh-market-desktop-bridge');
const { togglePluginInPatch } = require('../plugin-manager-patch');
const { COMPANION_PLUGINS } = require('../lib/companion-plugins');

// ESM 插件经动态 import 加载（与 loader 同路径形态）。
let internals;
test.before(async () => {
  const mod = await import(`file://${JSON.stringify(path.join(bridgeDir, 'lib', 'index.js')).slice(1, -1)}`);
  assert.equal(mod.name, 'market-desktop-bridge');
  assert.deepEqual(mod.inject, []);
  assert.equal(typeof mod.apply, 'function');
  internals = mod.__internals;
  assert.ok(internals, '__internals 可测面必须存在');
});

const SAMPLE_PATCH = [
  '# dsh web profile patch（由 DSH Desktop 维护）',
  '- id: compaction-basic',
  '  disabled: true',
  '',
  '- id: harness-pet',
  '  disabled: true',
  '- insert:',
  "    - id: file-changes",
  "      name: '@deepseek-ai/dsh-file-changes'",
  '- insert:',
  "    - id: community-market",
  "      name: 'dsh-community-market'",
  '      requires:',
  "        - webServer",
  '- insert:',
  "    - id: dsh-hub",
  "      name: 'dsh-hub'",
  '',
].join('\n');

test('A1 parsePatchRows: insert 内层 / 顶层块 / disabled 标记全解析', () => {
  const rows = internals.parsePatchRows(SAMPLE_PATCH);
  assert.deepStrictEqual(
    rows.map((r) => r.id),
    ['compaction-basic', 'harness-pet', 'file-changes', 'community-market', 'dsh-hub'],
  );
  assert.strictEqual(rows.find((r) => r.id === 'file-changes').name, '@deepseek-ai/dsh-file-changes');
  assert.strictEqual(rows.find((r) => r.id === 'harness-pet').disabled, true);
  assert.strictEqual(rows.find((r) => r.id === 'community-market').disabled, false);
});

test('A2 disable→enable 幂等往返：insert 条目迁出为顶层禁用块再恢复', () => {
  const disabled = internals.disableInPatch(SAMPLE_PATCH, 'dsh-hub', 'dsh-hub');
  assert.ok(disabled.includes('- id: dsh-hub'), '顶层禁用块已写入');
  assert.ok(/disabled:\s*true/.test(disabled), 'disabled: true 已写入');
  // 内层条目 = 缩进的 `- id:` 行（顶层禁用块的 id 行不缩进）
  assert.ok(!/\n[ \t]+-[ \t]*id:[ \t]*dsh-hub\b/.test(disabled), 'insert 内层条目已移出');

  // 幂等：再次 disable 不再变化
  assert.strictEqual(internals.disableInPatch(disabled, 'dsh-hub', 'dsh-hub'), disabled);

  const enabled = internals.enableInPatch(disabled, 'dsh-hub');
  assert.ok(!/- id: dsh-hub[\s\S]*?disabled:\s*true/.test(enabled), '禁用行已移除');
  assert.ok(enabled.includes("- id: dsh-hub"), '带 name 的块保留为激活登记');
  assert.ok(!enabled.includes('关闭 dsh-hub'), '标记注释已清');
  // 幂等
  assert.strictEqual(internals.enableInPatch(enabled, 'dsh-hub'), enabled);
});

test('A3 enable 对无 name/config 的裸块：整块移除（对齐壳层 patch-surgery）', () => {
  const bare = '# header\n- id: lone-plugin\n  disabled: true\n';
  const out = internals.enableInPatch(bare, 'lone-plugin');
  assert.ok(!out.includes('lone-plugin'), '裸块整块移除');
});

test('A4 CRLF 保真', () => {
  const crlf = SAMPLE_PATCH.replace(/\n/g, '\r\n');
  const disabled = internals.disableInPatch(crlf, 'file-changes', '@deepseek-ai/dsh-file-changes');
  assert.ok(disabled.includes('\r\n'), 'CRLF 保持');
  assert.ok(!/(?<!\r)\n/.test(disabled), '不产生混合换行');
});

test('A5 buildPluginArgv 携带必需的 --profile（issue #164）', () => {
  const entry = { file: 'node.exe', args: ['--use-system-ca', 'C:/dsh/lib/bin.js'], cwd: 'C:/dsh/lib', viaShell: false };
  assert.deepStrictEqual(
    internals.buildPluginArgv(entry, ['add', 'x@1.0.0', '--save-exact'], 'web'),
    ['--use-system-ca', 'C:/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', 'x@1.0.0', '--save-exact'],
  );
  // 缺 profile 时也不崩（仅不插入 --profile，交由内核 CLI 报必需项缺失）
  assert.deepStrictEqual(
    internals.buildPluginArgv(entry, ['remove', 'x'], undefined),
    ['--use-system-ca', 'C:/dsh/lib/bin.js', 'plugin', 'remove', 'x'],
  );
});

test('B1 包元数据满足 hub 登记规则（name/精确 semver/description/private）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'dsh-market-desktop-bridge');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.strictEqual(typeof pkg.description, 'string');
  assert.ok(pkg.description.length > 0);
  assert.strictEqual(pkg.private, true);
  assert.ok(/DSH Desktop/.test(pkg.description), '过期清理三重判定（private+描述）可命中');
  // 配套清单与 cordis.patch.yml 的 loader id 一致（issue #104 防线）
  const entry = COMPANION_PLUGINS.find((p) => p.name === 'dsh-market-desktop-bridge');
  assert.ok(entry, '配套清单已登记');
  const patch = fs.readFileSync(path.join(bridgeDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes(`- id: ${entry.id}`), 'patch id 与配套清单一致');
});

test('B2 市场包（dsh-community-market）元数据与清单一致', () => {
  const marketDir = path.join(repoRoot, 'assets', 'plugins', 'dsh-community-market');
  const pkg = JSON.parse(fs.readFileSync(path.join(marketDir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'dsh-community-market');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(pkg.description && /DSH Desktop/.test(pkg.description));
  const entry = COMPANION_PLUGINS.find((p) => p.name === 'dsh-community-market');
  assert.ok(entry, '市场已登记配套清单');
  const patch = fs.readFileSync(path.join(marketDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes(`- id: ${entry.id}`), 'patch id 与配套清单一致');
  // 客户端构建产物存在且带 loader 包装
  const client = fs.readFileSync(path.join(marketDir, 'lib', 'client.js'), 'utf8');
  assert.ok(client.startsWith('window.__ModuleLoader__.load({ id: "dsh-community-market"'));
  assert.ok(client.includes('[desktop-restart-fix]'), '桌面监管重启补丁已打');
});

test('C1 双向兼容：本桥禁用块可被壳层 togglePluginInPatch 启用消费', () => {
  const disabled = internals.disableInPatch(SAMPLE_PATCH, 'file-changes', '@deepseek-ai/dsh-file-changes');
  // 壳层（sidecar plugin-set-enabled）的启用路径吃同一文件
  const shellEnabled = togglePluginInPatch(disabled, 'file-changes', true, '@deepseek-ai/dsh-file-changes');
  assert.ok(!new RegExp('- id: file-changes[\\s\\S]*?disabled:\\s*true').test(shellEnabled));
});

test('C2 双向兼容：壳层禁用块可被本桥启用消费', () => {
  const shellDisabled = togglePluginInPatch(SAMPLE_PATCH, 'file-changes', false, '@deepseek-ai/dsh-file-changes');
  const bridgeEnabled = internals.enableInPatch(shellDisabled, 'file-changes');
  assert.ok(!new RegExp('- id: file-changes[\\s\\S]*?disabled:\\s*true').test(bridgeEnabled));
});
