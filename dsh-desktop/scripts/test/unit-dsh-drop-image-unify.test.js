'use strict';

// unit-dsh-drop-image-unify.test.js — M3「拖拽 = 粘贴 = 选择」统一单测。
//
// 被测对象：
//   · assets/plugins/dsh-file-drop/lib/client.js（浏览器半边，vm 装载全真）
//   · assets/plugins/dsh-file-drop/lib/index.js（宿主半边读图路由，真 fs）
//
// 统一契约（与内核源对照，node_modules/@deepseek-ai/dsh-client-ui-
// conversation/lib/client.js）：
//   · 内核粘贴处理器 InputBar.onPaste → intakeImages(files) → 槽位注入的
//     addImages(files) = conversation.createDraftImages(files) + shell
//     .addImages(ids)（lib/client.js:3823-3856 与 10108-10116）；
//   · 输入框槽位拿到的 inputActions.addImages 就是 shell.actions.addImages
//     （lib/client.js:967）——即「粘贴图片」的最终落点对。
// 因此断言「拖入图片 → conversation.createDraftImages + inputActions
// .addImages（与 📎 选择器同一对象、同一函数）」即断言「拖入走了粘贴的
// 同一 ingest」，无需触碰系统剪贴板。
//
// 覆盖：
//   1) 纯逻辑 planBridgeEntries：白名单/非白名单/超大/内容载荷二分矩阵；
//   2) vm 端到端：壳层 client-file-drop 路径载荷 → fetch 宿主路由 → File →
//      与选择器完全相同的 createDraftImages+addImages 调用与发送 wire 形状；
//      多图单批；张数限额（railCount=19）；读失败/无 fetch/超大/非图片回退
//      路径提示（零回归）；内容载荷免读直进；
//   3) 宿主半边路由矩阵：happy(PNG/JPEG/GIF/WEBP)/改名单/坏扩展/超大/缺失/
//      目录/相对路径/非回环/非 POST/apply 注册与卸载。
//
// 运行：node --test scripts/test/unit-dsh-drop-image-unify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-file-drop');
const CLIENT = path.join(PLUGIN_DIR, 'lib', 'client.js');
const HOST = path.join(PLUGIN_DIR, 'lib', 'index.js');

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 真图片字节（魔数嗅探面）
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 9, 8, 7]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([4, 3, 2, 1])]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'), Buffer.from([0x56, 0x50, 0x38, 0x20]),
]);

// ---------------------------------------------------------------------------
// vm 装载浏览器半边（形态对齐 unit-dsh-file-drop-attach.test.js）
// ---------------------------------------------------------------------------

function loadClient(file, extraSandbox) {
  let captured = null;
  const baseWindow = { __ModuleLoader__: { load: (reg) => { captured = reg; } } };
  const sandbox = Object.assign({}, extraSandbox || {});
  sandbox.window = Object.assign(baseWindow, sandbox.window || {});
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { captured, sandbox };
}

function makeRequire(stubs) {
  return (spec) => {
    if (stubs && Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
    throw new Error(`missed module: ${spec}`);
  };
}

function makeReactStub() {
  return {
    Fragment: Symbol('fragment'),
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
    useEffect: (fn) => { fn(); return () => {}; },
  };
}

const KERNEL_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
function makeKernelConversation() {
  const drafts = new Map();
  let seq = 0;
  const api = {
    calls: { create: [], addImageBatches: [] },
    released: [],
    lastAdded: null,
    createDraftImages(files) {
      for (const f of files) {
        if (!KERNEL_MIMES.includes(f.type)) {
          const err = new Error(`unsupported image media type: ${f.type || '(empty)'}`);
          err.name = 'UnsupportedImageMediaTypeError';
          throw err;
        }
      }
      const made = files.map((file) => {
        const attachment = { kind: 'image', id: 'img-' + (seq++), previewUrl: 'blob:mock-' + seq, file };
        drafts.set(attachment.id, attachment);
        api.calls.create.push(file.name);
        return attachment;
      });
      api.lastBatch = made;
      return made;
    },
    releaseDraftImages(list) { for (const d of list) { drafts.delete(d.id); api.released.push(d.id); } },
    draftImages: (ids) => ids.map((id) => drafts.get(id)).filter(Boolean),
    serializeDraftImages(ids) {
      return Promise.all(api.draftImages(ids).map(async (a) => ({
        type: 'image',
        mediaType: a.file.type,
        data: Buffer.from(await a.file.arrayBuffer()).toString('base64'),
        name: a.file.name,
      })));
    },
  };
  return api;
}

/**
 * DOM + fetch 桩沙箱。hostFiles：绝对路径 → { bytes, mediaType }（宿主路由
 * 成功面）；不在表内或 hostDown 时按失败处理。data: URL 桩负责 fileFromContent
 * 的 blob 物化（File 构造器缺席走生产同款 catch 兜底：blob.name 赋值）。
 */
function makeDomSandbox(hostFiles, hostDown) {
  const fetchCalls = [];
  const textarea = {
    tagName: 'TEXTAREA',
    value: '',
    focus() {},
    dispatchEvent() {},
  };
  const listeners = { document: {}, window: {} };
  function blobOf(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl));
    if (!m) throw new Error('bad data url');
    const bytes = Buffer.from(m[2], 'base64');
    return {
      type: m[1],
      size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  const sandbox = {
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    Date,
    Promise,
    URL: undefined,
    Event: function Event(type, opts) { this.type = type; Object.assign(this, opts || {}); },
    FileReader: function FileReader() {},
    HTMLTextAreaElement: (function () {
      function T() {}
      Object.defineProperty(T.prototype, 'value', {
        get() { return textarea.value; },
        set(v) { textarea.value = v; },
        configurable: true,
      });
      return T;
    })(),
    fetch(url, opts) {
      fetchCalls.push({ url, opts });
      if (String(url).startsWith('data:')) {
        return Promise.resolve({ blob: async () => blobOf(url) });
      }
      if (url === '/dsh-file-drop/read-image') {
        if (hostDown) return Promise.resolve({ json: async () => ({ ok: false, error: 'route down' }) });
        let body = {};
        try { body = JSON.parse(opts && opts.body); } catch { /* 保持空 */ }
        const hit = hostFiles && hostFiles[body.path];
        if (!hit) return Promise.resolve({ json: async () => ({ ok: false, error: 'not found' }) });
        return Promise.resolve({
          json: async () => ({
            ok: true,
            dataUrl: 'data:' + hit.mediaType + ';base64,' + hit.bytes.toString('base64'),
            mediaType: hit.mediaType,
            name: body.name || 'x',
            size: hit.bytes.length,
          }),
        });
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    },
    document: {
      activeElement: textarea,
      body: null,
      addEventListener(type, fn) { (listeners.document[type] = listeners.document[type] || []).push(fn); },
      querySelector: () => textarea,
    },
  };
  sandbox.window = {
    addEventListener(type, fn) { (listeners.window[type] = listeners.window[type] || []).push(fn); },
  };
  return { sandbox, listeners, textarea, fetchCalls };
}

async function setupApplied(hostFiles, hostDown) {
  const dom = makeDomSandbox(hostFiles, hostDown);
  const load = loadClient(CLIENT, dom.sandbox);
  const kernel = makeKernelConversation();
  const addImagesCalls = [];
  const inputActions = {
    addImages(ids) { addImagesCalls.push(ids); kernel.lastAdded = ids; return true; },
    setDraft() {},
  };
  const input = { draft: '', imageIds: [] };
  const slotRegistrations = [];
  const ctx = {
    get: (name) => { if (name === 'conversation') return kernel; throw new Error('no service ' + name); },
    slots: {
      inject: (name, fn) => { slotRegistrations.push({ name, register: fn }); },
      register: (options, component) => ({ options, component }),
    },
  };
  const mod = load.captured.factory(makeRequire({
    react: makeReactStub(),
    '@deepseek-ai/dsh-client-ui-primitives': { IconPaperclipOutline16: (p) => ({ tag: 'icon', props: p }) },
  }));
  mod.apply(ctx);
  return {
    mod, kernel, inputActions, addImagesCalls, input, slotRegistrations,
    textarea: dom.textarea, listeners: dom.listeners, fetchCalls: dom.fetchCalls,
    store: load.sandbox.window.__dshFileDropStore,
    renderSlot(withInput) {
      const entry = slotRegistrations[0].register();
      return entry.component({ inputActions, input: withInput || input });
    },
  };
}

const flush = (ms) => new Promise((r) => setTimeout(r, ms));

function fireBridge(e, files) {
  e.listeners.window['client-file-drop'][0]({ detail: { type: 'drop', files } });
}

// ---------------------------------------------------------------------------
// 1) 纯逻辑：planBridgeEntries 二分矩阵
// ---------------------------------------------------------------------------

const core = loadClient(CLIENT).captured.factory(makeRequire({ react: makeReactStub() })).core;

test('planBridgeEntries：白名单扩展 → rail；文本/二进制/非白名单图/超大图 → hint', () => {
  const plan = core.planBridgeEntries([
    { path: 'C:\\a\\x.png', name: 'x.png', size: 1024 },
    { path: 'C:\\a\\y.jpg', name: 'y.JPG', size: 2048 },   // 大写扩展名（extOf 归一小写）
    { path: 'C:\\a\\z.bmp', name: 'z.bmp', size: 10 },      // 图片但非内核白名单
    { path: 'C:\\a\\n.md', name: 'n.md', size: 30 },        // 文本
    { path: 'C:\\a\\b.bin', name: 'b.bin', size: 40 },      // 二进制
    { path: 'C:\\a\\big.png', name: 'big.png', size: 4 * MB }, // 超单图上限
    { path: 'C:\\a\\u.png', name: 'u.png', size: null },     // 体积未知 → 放行交宿主复核
  ]);
  // 注意：vm 上下文构造的数组原型与宿主不同，deepEqual 会假失败
  //（与 unit-dsh-file-drop-attach.test.js 同坑）——统一 Array.from 拉回宿主域。
  assert.deepEqual(Array.from(plan.rail, (e) => e.name), ['x.png', 'y.JPG', 'u.png']);
  assert.deepEqual(Array.from(plan.hint, (e) => e.name), ['z.bmp', 'n.md', 'b.bin', 'big.png']);
  // 内容载荷无论扩展名一律进 rail 通道（类型在 File 物化后按真实 MIME 复核）。
  const plan2 = core.planBridgeEntries([
    { path: 'C:\\a\\c.dat', name: 'c.dat', size: 5, dataUrl: 'data:image/png;base64,AAA' },
  ]);
  assert.equal(plan2.rail.length, 1);
  assert.equal(plan2.hint.length, 0);
  // 空输入。
  assert.equal(JSON.stringify(core.planBridgeEntries([])), '{"rail":[],"hint":[]}');
  assert.equal(JSON.stringify(core.planBridgeEntries(null)), '{"rail":[],"hint":[]}');
  // 限额注入（宿主可配置更大单图上限时超大图也应尝试进管道）。
  const plan3 = core.planBridgeEntries([{ path: 'p', name: 'big.png', size: 4 * MB }],
    { maxImageBytes: 10 * MB, maxImagesPerMessage: 20, maxMessageImageBytes: 100 * MB, maxImageDimension: 2000 });
  assert.equal(plan3.rail.length, 1);
});

test('RAIL_IMAGE_EXT_MIME 与内核附件媒体白名单一一对应', () => {
  const mimes = new Set(Object.values(core.RAIL_IMAGE_EXT_MIME));
  for (const m of core.KERNEL_IMAGE_MEDIA_TYPES) assert.ok(mimes.has(m), m);
});

// ---------------------------------------------------------------------------
// 2) vm 端到端：拖入 → 与粘贴/选择器同一 ingest
// ---------------------------------------------------------------------------

test('e2e: 壳层拖入 PNG（路径载荷）→ 宿主路由读回 → 与选择器同一 createDraftImages + inputActions.addImages', async () => {
  const e = await setupApplied({ 'C:\\shots\\登录页.png': { bytes: PNG_BYTES, mediaType: 'image/png' } });
  e.renderSlot(); // 登记 railEnv（conversation + inputActions + railCount）

  fireBridge(e, [{ path: 'C:\\shots\\登录页.png', name: '登录页.png', size: PNG_BYTES.length }]);

  // 宿主路由以净化后的原路径被调（POST + JSON）。
  await flush(25);
  assert.equal(e.fetchCalls.filter((c) => c.url === '/dsh-file-drop/read-image').length, 1);
  assert.equal(e.fetchCalls[0].opts.method, 'POST');
  assert.equal(JSON.parse(e.fetchCalls[0].opts.body).path, 'C:\\shots\\登录页.png');

  // 与 📎 选择器完全相同的 ingest 对：createDraftImages(同 conversation 对象)
  // + inputActions.addImages(槽位同一函数对象——内核粘贴 intakeImages 的落点)。
  assert.deepEqual(e.kernel.calls.create, ['登录页.png'], '拖入图片应进官方附件管道');
  assert.equal(e.addImagesCalls.length, 1, 'addImages 应被调一次（批量单图）');
  assert.equal(e.addImagesCalls[0].length, 1);

  // 不再注入路径提示（进栏即止，防双份）。
  assert.ok(!e.textarea.value.includes('登录页.png'), '成功进栏后不得再注入路径提示');
});

test('e2e: 同一 ingest 断言 —— 拖入与 📎 选择器产出逐位相同的附件 wire 形状（= 粘贴同款）', async () => {
  // 选择器半边：同字节 PNG 经 onChange 进管道。
  const e = await setupApplied({ 'C:\\p\\drop.png': { bytes: PNG_BYTES, mediaType: 'image/png' } });
  const tree = e.renderSlot();
  const fileInput = tree.children.find((c) => c.tag === 'input');
  const pickedFile = {
    name: 'same.png', type: 'image/png', size: PNG_BYTES.length,
    arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length),
  };
  fileInput.props.onChange({ target: { files: [pickedFile], value: 'x' } });
  await flush(25);
  assert.deepEqual(e.kernel.calls.create, ['same.png']);

  // 拖入半边：另一张同字节 PNG（不同路径）。
  fireBridge(e, [{ path: 'C:\\p\\drop.png', name: 'drop.png', size: PNG_BYTES.length }]);
  await flush(25);
  assert.deepEqual(e.kernel.calls.create, ['same.png', 'drop.png'], '拖入应复用选择器的同一管道');

  // 两者序列化出的发送载荷（内核 submit 时的 base64 image 块）逐位等价。
  const [pickedWire, dropWire] = await e.kernel.serializeDraftImages(['img-0', 'img-1']);
  assert.equal(pickedWire.type, dropWire.type);
  assert.equal(pickedWire.mediaType, dropWire.mediaType);
  assert.equal(pickedWire.data, dropWire.data);
  assert.equal(dropWire.data, PNG_BYTES.toString('base64'));
  assert.equal(dropWire.name, 'drop.png');
});

test('e2e: 拖入多图（png+jpeg+webp）→ 单批 createDraftImages + 单次 addImages；gif 同白名单', async () => {
  const host = {
    'C:\\m\\a.png': { bytes: PNG_BYTES, mediaType: 'image/png' },
    'C:\\m\\b.jpg': { bytes: JPEG_BYTES, mediaType: 'image/jpeg' },
    'C:\\m\\c.webp': { bytes: WEBP_BYTES, mediaType: 'image/webp' },
    'C:\\m\\d.gif': { bytes: GIF_BYTES, mediaType: 'image/gif' },
  };
  const e = await setupApplied(host);
  e.renderSlot();
  fireBridge(e, Object.keys(host).map((p) => ({ path: p, name: path.basename(p), size: host[p].bytes.length })));
  await flush(25);
  assert.deepEqual(e.kernel.calls.create, ['a.png', 'b.jpg', 'c.webp', 'd.gif'], '四张白名单图全部进管道');
  assert.equal(e.addImagesCalls.length, 1, '多图应合批一次 addImages');
  assert.equal(e.addImagesCalls[0].length, 4);
  assert.ok(!/\[拖入/.test(e.textarea.value), '成功进栏不注入提示块');
});

test('e2e: 张数限额 —— 附件栏已有 19 张再拖 2 张：第 1 张进栏、第 2 张回退路径提示（粘贴同款限流）', async () => {
  const host = {
    'C:\\q\\one.png': { bytes: PNG_BYTES, mediaType: 'image/png' },
    'C:\\q\\two.png': { bytes: Buffer.concat([PNG_BYTES, Buffer.from([9])]), mediaType: 'image/png' },
  };
  const e = await setupApplied(host);
  e.renderSlot({ draft: '', imageIds: Array.from({ length: 19 }, (_, i) => 'img-existing-' + i) });
  fireBridge(e, [
    { path: 'C:\\q\\one.png', name: 'one.png', size: host['C:\\q\\one.png'].bytes.length },
    { path: 'C:\\q\\two.png', name: 'two.png', size: host['C:\\q\\two.png'].bytes.length },
  ]);
  await flush(25);
  assert.deepEqual(e.kernel.calls.create, ['one.png'], '仅第 1 张进管道（20 张上限）');
  assert.equal(e.addImagesCalls[0].length, 1);
  // 被拒的第 2 张回退为附件 chip（路径提示），不再注入输入框。
  assert.equal(e.textarea.value, '', '不再注入路径提示进输入框');
  assert.deepEqual(Array.from(e.store.snapshotPending(e.inputActions), (x) => x.name), ['two.png'], '被拒的第 2 张应成为待发附件 chip');
  assert.equal(e.store.snapshotPending(e.inputActions)[0].kind, 'path');
  assert.equal(e.store.snapshotPending(e.inputActions)[0].path, 'C:\\q\\two.png');
});

test('e2e: 非图片（md + zip）不误路由 —— 不调宿主读图路由、不进管道、合并路径提示', async () => {
  const e = await setupApplied({});
  e.renderSlot();
  fireBridge(e, [
    { path: 'C:\\t\\note.md', name: 'note.md', size: 30 },
    { path: 'C:\\t\\pack.zip', name: 'pack.zip', size: 4096 },
  ]);
  await flush(25);
  assert.equal(e.fetchCalls.length, 0, '非图片不得触发读图路由');
  assert.equal(e.kernel.calls.create.length, 0, '非图片不得进附件管道');
  // 非图片成为附件 chip（路径提示），不再合并注入输入框。
  assert.equal(e.textarea.value, '');
  assert.deepEqual(Array.from(e.store.snapshotPending(e.inputActions), (x) => x.name), ['note.md', 'pack.zip']);
  assert.ok(e.store.snapshotPending(e.inputActions).every((x) => x.kind === 'path'));
});

test('e2e: 超大图（>3.5MB）与非白名单图（bmp）→ 不读内容，维持路径提示（既有语义零回归）', async () => {
  const e = await setupApplied({});
  e.renderSlot();
  fireBridge(e, [
    { path: 'C:\\t\\huge.png', name: 'huge.png', size: 4 * MB },
    { path: 'C:\\t\\icon.bmp', name: 'icon.bmp', size: 10 },
  ]);
  await flush(25);
  assert.equal(e.fetchCalls.length, 0, '超大/非白名单不浪费一次读');
  assert.equal(e.kernel.calls.create.length, 0);
  assert.equal(e.textarea.value, '');
  assert.deepEqual(Array.from(e.store.snapshotPending(e.inputActions), (x) => x.name), ['huge.png', 'icon.bmp']);
});

test('e2e: 宿主路由失败（旧宿主/未注册路由）→ 回退路径提示，不抛错不丢信息', async () => {
  const e = await setupApplied(null, true /* hostDown */);
  e.renderSlot();
  fireBridge(e, [{ path: 'C:\\t\\gone.png', name: 'gone.png', size: 10 }]);
  await flush(25);
  assert.equal(e.fetchCalls.filter((c) => c.url === '/dsh-file-drop/read-image').length, 1, '应尝试读图路由');
  assert.equal(e.kernel.calls.create.length, 0);
  assert.deepEqual(Array.from(e.store.snapshotPending(e.inputActions), (x) => x.name), ['gone.png'], '读失败回退为附件 chip');
});

test('e2e: 无 fetch 能力（残留 file:// 壳）→ 同样回退路径提示', async () => {
  const dom2 = makeDomSandbox(null, false);
  delete dom2.sandbox.fetch;
  const load2 = loadClient(CLIENT, dom2.sandbox);
  const kernel2 = makeKernelConversation();
  const inputActions2 = { addImages() { return true; }, setDraft() {} };
  const ctx2 = {
    get: (n) => { if (n === 'conversation') return kernel2; throw new Error('no'); },
    slots: { inject: () => {}, register: () => ({}) },
  };
  const mod2 = load2.captured.factory(makeRequire({ react: makeReactStub() }));
  mod2.apply(ctx2);
  dom2.listeners.window['client-file-drop'][0]({
    detail: { type: 'drop', files: [{ path: 'C:\\t\\legacy.png', name: 'legacy.png', size: 10 }] },
  });
  await flush(25);
  assert.equal(kernel2.calls.create.length, 0);
  assert.ok(dom2.textarea.value.includes('C:\\t\\legacy.png'));
});

test('e2e: 载荷自带内容（dataUrl）→ 免读直进同一管道（不调宿主路由）', async () => {
  const e = await setupApplied({});
  e.renderSlot();
  fireBridge(e, [{
    path: 'C:\\t\\carried.png', name: 'carried.png', size: PNG_BYTES.length,
    dataUrl: 'data:image/png;base64,' + PNG_BYTES.toString('base64'), mediaType: 'image/png',
  }]);
  await flush(25);
  assert.equal(e.fetchCalls.filter((c) => c.url === '/dsh-file-drop/read-image').length, 0);
  assert.deepEqual(e.kernel.calls.create, ['carried.png']);
  assert.ok(!e.textarea.value.includes('carried.png'));
});

test('e2e: enter/leave 悬停载荷零副作用', async () => {
  const e2 = await setupApplied({});
  e2.renderSlot();
  e2.listeners.window['client-file-drop'][0]({ detail: { type: 'enter', count: 2 } });
  e2.listeners.window['client-file-drop'][0]({ detail: { type: 'leave' } });
  await flush(10);
  assert.equal(e2.fetchCalls.length, 0);
  assert.equal(e2.kernel.calls.create.length, 0);
  assert.equal(e2.textarea.value, '');
});

// ---------------------------------------------------------------------------
// 3) 宿主半边读图路由矩阵（真 fs、真流）
//    注：宿主半边是 ESM（dsh-file-drop package.json type:module），CJS 测试
//    经动态 import 惰性加载。
// ---------------------------------------------------------------------------

let HOST_NS = null;
async function hostNS() {
  if (!HOST_NS) HOST_NS = await import(pathToFileURL(HOST).href);
  return HOST_NS;
}

function makeReq(method, body, remoteAddress = '127.0.0.1') {
  const req = new PassThrough();
  req.method = method;
  req.socket = { remoteAddress };
  if (body != null) req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  else req.end();
  return req;
}

function makeRes() {
  return {
    status: 0, headers: null, body: null, ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(data) { this.ended = true; this.body = data != null ? String(data) : this.body; },
  };
}

async function callRoute(req) {
  const H = await hostNS();
  const res = makeRes();
  await H.handleReadImage(req, res);
  let json = null;
  try { json = res.body != null ? JSON.parse(res.body) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-drop-unify-'));
const tmpAbs = (name) => path.join(tmpRoot, name);
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理尽力 */ } });

test('宿主路由：PNG happy path → dataUrl + 嗅探 MIME + base64 原文', async () => {
  const file = tmpAbs('ok.png');
  fs.writeFileSync(file, PNG_BYTES);
  const r = await callRoute(makeReq('POST', { path: file, name: 'ok.png' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mediaType, 'image/png');
  assert.equal(r.json.dataUrl, 'data:image/png;base64,' + PNG_BYTES.toString('base64'));
  assert.equal(r.json.size, PNG_BYTES.length);
});

test('宿主路由：JPEG / GIF / WEBP 魔数嗅探全部识别', async () => {
  const cases = [['j.jpg', JPEG_BYTES, 'image/jpeg'], ['g.gif', GIF_BYTES, 'image/gif'], ['w.webp', WEBP_BYTES, 'image/webp']];
  for (const [n, bytes, mime] of cases) {
    const file = tmpAbs(n);
    fs.writeFileSync(file, bytes);
    const r = await callRoute(makeReq('POST', { path: file }));
    assert.equal(r.status, 200, n);
    assert.equal(r.json.mediaType, mime, n);
  }
});

test('宿主路由：改名文件（.png 扩展 + 文本内容）→ 415 not an image', async () => {
  const file = tmpAbs('fake.png');
  fs.writeFileSync(file, 'this is definitely not an image');
  const r = await callRoute(makeReq('POST', { path: file }));
  assert.equal(r.status, 415);
  assert.equal(r.json.ok, false);
});

test('宿主路由：非白名单扩展（.zip/.bmp/.svg）→ 415，且不读文件', async () => {
  const file = tmpAbs('data.zip');
  fs.writeFileSync(file, PNG_BYTES);
  for (const p of [file, tmpAbs('no-such.bmp'), tmpAbs('no-such.svg')]) {
    const r = await callRoute(makeReq('POST', { path: p }));
    assert.equal(r.status, 415, p);
  }
});

test('宿主路由：超大（>3.5MB）→ 413；缺失 → 404；目录伪装 .png → 400', async () => {
  const big = tmpAbs('big.png');
  const bigBuf = Buffer.alloc(MAX_IMAGE_BYTES + 1024);
  PNG_BYTES.copy(bigBuf, 0);
  fs.writeFileSync(big, bigBuf);
  assert.equal((await callRoute(makeReq('POST', { path: big }))).status, 413);

  assert.equal((await callRoute(makeReq('POST', { path: tmpAbs('gone.png') }))).status, 404);

  const dir = tmpAbs('dir.png');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal((await callRoute(makeReq('POST', { path: dir }))).status, 400);
});

test('宿主路由：相对路径 / 空字节 / 坏 JSON / 非 POST / 非回环 → 4xx 拒绝', async () => {
  assert.equal((await callRoute(makeReq('POST', { path: 'relative/x.png' }))).status, 400);
  assert.equal((await callRoute(makeReq('POST', { path: tmpAbs('a\u0000b.png') }))).status, 400);
  assert.equal((await callRoute(makeReq('POST', 'not-json{{'))).status, 400);
  assert.equal((await callRoute(makeReq('GET', { path: tmpAbs('x.png') }))).status, 405);
  const remote = await callRoute(makeReq('POST', { path: tmpAbs('x.png') }, '8.8.8.8'));
  assert.equal(remote.status, 403);
});

test('宿主路由：apply 注册 exact 路由 + 卸载 dispose', async () => {
  const H = await hostNS();
  const registered = [];
  const dispose = H.apply({
    webServer: { register: (route) => { registered.push(route); return () => {}; } },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, 'exact');
  assert.equal(registered[0].path, '/dsh-file-drop/read-image');
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(typeof dispose, 'function');
  assert.equal(H.inject.join(), 'webServer');
  assert.equal(H.name, 'dsh-file-drop');
});

test('宿主路由：saneImagePath 纯函数矩阵', async () => {
  const H = await hostNS();
  assert.equal(H.saneImagePath('  C:\\a\\b.png '), 'C:\\a\\b.png');
  assert.equal(H.saneImagePath('\\\\server\\share\\x.png'), '\\\\server\\share\\x.png');
  assert.equal(H.saneImagePath('x.png'), '');
  assert.equal(H.saneImagePath('C:\\a\u0001b.png'), '');
  assert.equal(H.saneImagePath(''), '');
  assert.equal(H.saneImagePath(null), '');
  assert.equal(H.saneImagePath('C:\\' + 'x'.repeat(5000) + '.png'), '');
});

test('宿主路由：真实响应头（loopback + JSON 响应头）', async () => {
  const H = await hostNS();
  const file = tmpAbs('hdr.png');
  fs.writeFileSync(file, PNG_BYTES);
  const req = makeReq('POST', { path: file });
  const res = makeRes();
  await H.handleReadImage(req, res);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body || '', 'utf8')));
});
