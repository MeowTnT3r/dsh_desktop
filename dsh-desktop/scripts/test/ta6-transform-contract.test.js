'use strict';

// ---------------------------------------------------------------------------
// TA6 元测试 2：transform 契约三态语义统一（34 个 file transform 逐个实跑）。
//
// 对每个 transform 用三种输入各跑一遍：
//   1) pristine 源（.tmp-rc2-stage 未经补丁的内核包文本；有依赖的先应用依赖
//      transform）→ status ∈ {changed, already, anchor-missing}；
//        - changed：必须携带 string src 且与输入不同；
//        - already：不得携带 src；
//        - anchor-missing（自然退役）：detail 非空且含文件名；此时用
//          dsh-desktop/node_modules 真实已应用树补验 already 态；
//   2) 已应用源（自产：对输入跑一遍的产物；或真实已应用树的文件文本）
//      → 必须 already（幂等）；
//   3) 毒化源（把 changed 的锚点区段从输入中挖掉；无法定位区段或本就
//      anchor-missing 的用空白源兜底）→ 必须 anchor-missing，detail 非空
//      且含传入的文件名，不得携带 src、不得 throw；
//   3b) marker-only 输入（仅含 marker 注释）→ 不得 changed（marker 短路是
//      already；双信号 marker 需第二信号，缺信号回落 anchor-missing 也是
//      合法契约）。
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PATCH_SPECS } = require('../lib/patch-registry');

const PRISTINE_RC2 = path.join(__dirname, '..', '..', '..', '.tmp-rc2-stage', 'node_modules');
const PATCHED_DESKTOP = path.join(__dirname, '..', '..', 'node_modules'); // postinstall 后的真实已应用树
const POISON_LABEL = 'TA6-POISON-TARGET.js';

/** 补丁间依赖链（先应用的 id 列表，对齐 registry order）。 */
const PRE_CHAIN = {
  'vision-toggle-gate': ['image-send-fix'],
  'vision-key-fix': ['image-send-fix'],
};

const byId = Object.fromEntries(PATCH_SPECS.map((s) => [s.id, s]));

/** 「上游重构退役」白名单：这些补丁的锚点在 rc.2 被上游以**不同形态**修复
 * （代码重构，非采纳我们的注入）——pristine 与任何新装树都恒 anchor-missing，
 * 我们的 marker 永远不可能出现。「真实已应用树应 already」的不变量只对
 * 「上游采纳了我们的形态」的退役补丁成立；对本清单成员，anchor-missing
 * 同样是正确终态（幂等语义 = 什么都不做，两种形态等价自洽）。
 * （v0.5.3 内核升 rc.2 时这两项开始在新装树上退役，CI 先于本地暴露。） */
const REFACTORED_RETIRED = new Set([
  'slot-legacy-key',      // rc.2 重构了 ui-slots register（rec.spec 形态消失）
  'slot-error-isolation', // rc.2 移除了 if(key===void 0) throw 形态
]);

function targetFile(root, spec) {
  if (spec.layout === 'profile-boot-dirs') {
    const lib = path.join(root, '@deepseek-ai', 'dsh', 'lib');
    try {
      const files = fs.readdirSync(lib).filter((f) => /^profile-boot-.*\.js$/.test(f));
      return files.length ? path.join(lib, files[0]) : null;
    } catch { return null; }
  }
  const rels = spec.pkgRels && spec.pkgRels.length ? spec.pkgRels : [spec.pkgRel];
  for (const rel of rels) {
    const p = path.join(root, '@deepseek-ai', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** pristine 输入：先应用依赖链（vision 系依赖 image-send 注入的形态）。 */
function pristineInput(spec) {
  const file = targetFile(PRISTINE_RC2, spec);
  assert.ok(file, `${spec.id} 在 pristine 树中找不到目标文件`);
  let src = fs.readFileSync(file, 'utf8');
  for (const depId of (PRE_CHAIN[spec.id] || [])) {
    const r = byId[depId].transform(src, file);
    if (r.status === 'changed') src = r.src;
  }
  return { file, src };
}

/** 从输入与 patched 的公共前后缀定位锚点区段，挖掉它。 */
function excavateAnchor(input, patched) {
  if (patched === input) return null;
  let pre = 0;
  const minLen = Math.min(input.length, patched.length);
  while (pre < minLen && input[pre] === patched[pre]) pre += 1;
  let suf = 0;
  while (suf < minLen - pre && input[input.length - 1 - suf] === patched[patched.length - 1 - suf]) suf += 1;
  const core = input.slice(pre, input.length - suf);
  if (core.length === 0 || core.length > input.length * 0.6) return null; // 多点注入 → 兜底
  return input.slice(0, pre) + input.slice(input.length - suf);
}

const fileSpecs = PATCH_SPECS.filter((s) => s.kind === 'file');

test('前置条件：pristine rc.2 stage 树与真实已应用树均可用', () => {
  assert.ok(fs.existsSync(PRISTINE_RC2), `缺 pristine 源 ${PRISTINE_RC2}`);
  assert.ok(fs.existsSync(PATCHED_DESKTOP));
});

for (const spec of fileSpecs) {
  test(`三态契约：${spec.id}`, () => {
    const { file, src: pristine } = pristineInput(spec);

    // 1) pristine（依赖链先行）：三态之一，各态契约自洽。
    const r1 = spec.transform(pristine, file);
    assert.ok(
      ['changed', 'already', 'anchor-missing'].includes(r1.status),
      `${spec.id} 对 pristine 的 status 越界：${r1.status}`,
    );
    if (r1.status === 'changed') {
      assert.equal(typeof r1.src, 'string', `${spec.id} changed 必须携带 string src`);
      assert.notEqual(r1.src, pristine, `${spec.id} changed 产物必须不同于输入`);
    } else {
      assert.equal(r1.src, undefined, `${spec.id} ${r1.status} 不得携带 src`);
    }
    if (r1.status === 'anchor-missing') {
      assert.ok(r1.detail && r1.detail.includes(path.basename(file)),
        `${spec.id} 退役态 detail 应含文件名，得 "${r1.detail}"`);
      // 退役补丁在真实已应用树上必须表现为 already（幂等语义不因退役丢失）；
      // 例外：上游重构退役（白名单）——真实树恒 anchor-missing，同为正确终态。
      if (!REFACTORED_RETIRED.has(spec.id)) {
        const patchedFile = targetFile(PATCHED_DESKTOP, spec);
        if (patchedFile) {
          const rp = spec.transform(fs.readFileSync(patchedFile, 'utf8'), patchedFile);
          assert.equal(rp.status, 'already', `${spec.id} 在真实已应用树应 already，得 ${rp.status}`);
        }
      }
    }

    // 2) 已应用源（自产）：幂等 already。
    const applied = r1.status === 'changed' ? r1.src
      : r1.status === 'already' ? pristine
        : fs.readFileSync(targetFile(PATCHED_DESKTOP, spec), 'utf8');
    const r2 = spec.transform(applied, file);
    if (REFACTORED_RETIRED.has(spec.id) && r1.status === 'anchor-missing') {
      // 上游重构退役：真实树恒 anchor-missing（marker 永不出现）——确定性
      // 终态同样满足幂等（同输入恒同输出，绝不二次改写）。
      assert.equal(r2.status, 'anchor-missing', `${spec.id} 退休态幂等：应恒 anchor-missing，得 ${r2.status}`);
    } else {
      assert.equal(r2.status, 'already', `${spec.id} 已应用源应 already，得 ${r2.status}`);
    }
    assert.equal(r2.src, undefined);

    // 3) 毒化源：锚点挖掉 → anchor-missing + detail 含文件名，绝不改写。
    const poisoned = r1.status === 'changed'
      ? (excavateAnchor(pristine, r1.src) ?? '// ta6 poisoned\n')
      : '// ta6 poisoned\n';
    const r3 = spec.transform(poisoned, POISON_LABEL);
    assert.equal(r3.status, 'anchor-missing', `${spec.id} 毒化源应 anchor-missing，得 ${r3.status}`);
    assert.ok(r3.detail && r3.detail.length > 0, `${spec.id} anchor-missing 必须携带 detail`);
    assert.ok(
      r3.detail.includes(POISON_LABEL) || r3.detail.includes(path.basename(file)),
      `${spec.id} anchor-missing detail 应含文件名，得 "${r3.detail}"`,
    );
    assert.equal(r3.src, undefined, 'anchor-missing 不得携带 src');

    // 3b) marker-only：绝不 changed。
    if (spec.marker) {
      const r4 = spec.transform(`// ${spec.marker}\n`, POISON_LABEL);
      assert.notEqual(r4.status, 'changed',
        `${spec.id} marker-only 输入必须短路（already 或双信号回落 anchor-missing）`);
    }
  });
}

test('vision 系依赖序：未应用 image-send 时 toggle/key 必须 anchor-missing（不误伤）', () => {
  for (const id of ['vision-toggle-gate', 'vision-key-fix']) {
    const spec = byId[id];
    const file = targetFile(PRISTINE_RC2, spec);
    const r = spec.transform(fs.readFileSync(file, 'utf8'), file);
    assert.equal(r.status, 'anchor-missing', `${id} 在裸 pristine 上应因缺 image-send 形态而 anchor-missing`);
  }
});

test('契约面完整性：39 个 file transform 全部被本文件覆盖', () => {
  assert.equal(fileSpecs.length, 39);
});
