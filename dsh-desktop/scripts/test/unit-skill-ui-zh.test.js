'use strict';

// skill 工具行汉化补丁（skill-ui-zh / K27）单测：
// 锚点命中 pristine payload 副本 / 产物语法 / 幂等 / 中文文案就位 /
// 工具名 "skill"（机器调用 key）逐字不变。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { transformSkillUiZh, markers } = require('../lib/patch-adapters');

const SKILL_UI_ZH_MARKER_TEXT = 'dsh-desktop i18n: skill row title/inspect';

const PRISTINE_TARGET = path.join(
  __dirname, '..', '..', '..', '.tmp-rc2-stage',
  'node_modules', '@deepseek-ai', 'dsh-client-ui-skill', 'lib', 'client.js',
);

function pristineSrc() {
  // pristine 源优先 .tmp-rc2-stage（boot 链碰不到）；缺失回退 dev node_modules
  // （若已被 postinstall/运行时补丁打过，锚点用例会 already，属预期）。
  if (fs.existsSync(PRISTINE_TARGET)) return fs.readFileSync(PRISTINE_TARGET, 'utf8');
  const dev = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-skill', 'lib', 'client.js');
  if (fs.existsSync(dev)) return fs.readFileSync(dev, 'utf8');
  throw new Error('找不到 dsh-client-ui-skill/lib/client.js 源文件（pristine 与 dev 均缺失）');
}

test('锚点命中 pristine 副本（版本漂移哨兵）', () => {
  const r = transformSkillUiZh(pristineSrc(), 'client.js');
  assert.strictEqual(r.status, 'changed', `pristine 必须命中锚点，得 ${r.status}: ${r.detail || ''}`);
});

test('中文文案就位：row.title / row.inspect 键 + t() 引用 + 硬编码英文移除', () => {
  const r = transformSkillUiZh(pristineSrc(), 'client.js');
  assert.ok(r.src.includes('"row.title": "技能"'), 'zh 词典应含 row.title=技能');
  assert.ok(r.src.includes('"row.inspect": "查看"'), 'zh 词典应含 row.inspect=查看');
  assert.ok(r.src.includes('"row.title": "Skill"'), 'en 词典应含 row.title=Skill');
  assert.ok(r.src.includes('"row.inspect": "Inspect"'), 'en 词典应含 row.inspect=Inspect');
  assert.ok(r.src.includes('children: t("row.title")'), '标题应改用 t("row.title")');
  assert.ok(r.src.includes('t("row.inspect")'), '按钮应改用 t("row.inspect")');
  assert.ok(!r.src.includes('children: "Skill"'), '硬编码标题 "Skill" 应移除');
  assert.ok(!r.src.includes(', "Inspect"]'), '硬编码按钮 "Inspect" 应移除');
});

test('工具名 "skill"（机器 key）逐字不变', () => {
  const src = pristineSrc();
  const r = transformSkillUiZh(src, 'client.js');
  // keyed slot 注册 key / trigger 源 name / data-tool 属性均为机器调用 key。
  for (const key of ['key: "skill"', 'name: "skill"', '"data-tool": "skill"']) {
    assert.ok(r.src.includes(key), `机器 key ${key} 不得被汉化破坏`);
  }
  // 工具名字符本身未被翻译（"skill" 仍以原样存在，未出现中文替换）。
  assert.ok(!r.src.includes('"技能"') || r.src.includes('"row.title": "技能"'), '不应出现脱离词典的中文工具名');
});

test('transform 产物语法合法（node --check）', () => {
  const r = transformSkillUiZh(pristineSrc(), 'client.js');
  const tmp = path.join(os.tmpdir(), `dsh-skill-ui-zh-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmp, r.src);
  try {
    const res = require('node:child_process').spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `产物必须语法合法: ${res.stderr}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('幂等：二遍 already，不携带 src', () => {
  const once = transformSkillUiZh(pristineSrc(), 'client.js');
  const twice = transformSkillUiZh(once.src, 'client.js');
  assert.strictEqual(twice.status, 'already');
  assert.strictEqual(twice.src, undefined);
});

test('毒化源：锚点挖掉 → anchor-missing + detail 含文件名，绝不改写', () => {
  const src = pristineSrc();
  const r = transformSkillUiZh(src, 'client.js');
  // 挖掉标题锚点，模拟上游漂移。
  const poisoned = src.replace('children: "Skill"', 'children: "XXX"');
  const r3 = transformSkillUiZh(poisoned, 'client.js');
  assert.strictEqual(r3.status, 'anchor-missing');
  assert.ok(r3.detail && r3.detail.includes('client.js'), `detail 应含文件名，得 "${r3.detail}"`);
  assert.strictEqual(r3.src, undefined);
  assert.ok(r.status === 'changed');
});

test('registry 登记：guard 组 order 161 / cli:false / marker 导出', () => {
  const registry = require('../lib/patch-registry');
  const specs = registry.PATCH_SPECS || [];
  const spec = specs.find((s) => s.id === 'skill-ui-zh');
  assert.ok(spec, 'skill-ui-zh 必须登记');
  assert.strictEqual(spec.group, 'guard');
  assert.strictEqual(spec.order, 161);
  assert.strictEqual(spec.cli, false);
  assert.ok(spec.pkgRel.includes('dsh-client-ui-skill'), 'pkgRel 应指向 dsh-client-ui-skill');
  assert.strictEqual(spec.marker, markers.SKILL_UI_ZH_MARKER, 'marker 单一数据源');
  assert.ok(markers.SKILL_UI_ZH_MARKER.includes('skill row'), 'marker 文本与实现同源');
});
