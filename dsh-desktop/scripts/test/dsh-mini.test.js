'use strict';
// dsh-mini 插件单测（对齐上游 hzhz314159/dsh-mini v1.4.1）：
//   index.js   — tokenEquals / maskToken（安全审计 2026-08：恒时比对 + 日志脱敏）
//   gui-ws.js  — 帧封装 / 工具卡视图 / lastEventSeq（_internal 导出）
//   zstd-log.js — zstd 帧解析 / 多帧解压 / walkSessionFiles 纯 TTL 缓存
// 说明：上游 v1.4.1 的安全模型（isLoopback 免 token + 公网模式默认关 +
// timingSafeEqual）不通过 _internal 导出，本文件只测公开可测面；
// 手机 GUI 静态资产（gui/）与公网穿透行为由上游 verify 脚本与手动验证覆盖。
// 插件 lib 为 ESM（type:module），测试文件用 CJS 外壳 + before 钩子动态 import。
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');

const LIB = '../../assets/plugins/dsh-mini/lib/';
let gws = null;
let zlog = null;
let mini = null;

before(async () => {
  mini = await import(LIB + 'index.js');
  gws = await import(LIB + 'gui-ws.js');
  zlog = await import(LIB + 'zstd-log.js');
});

// ---------------------------------------------------------------------------
// index.js（_internal：tokenEquals / maskToken —— 安全审计 2026-08）
// ---------------------------------------------------------------------------
test('tokenEquals：正确 token 通过，错误/长度不符/空值拒绝且不抛错', () => {
  const { tokenEquals } = mini._internal;
  const want = 'a'.repeat(32);
  assert.strictEqual(tokenEquals(want, want), true, '相同 token 应通过');
  assert.strictEqual(tokenEquals('b'.repeat(32), want), false, '同长度不同内容应拒绝');
  assert.strictEqual(tokenEquals('a'.repeat(31), want), false, '长度差 1 应拒绝');
  assert.strictEqual(tokenEquals(want + 'a', want), false, '更长前缀匹配应拒绝');
  assert.strictEqual(tokenEquals('', want), false, '空 provided 应拒绝');
  assert.strictEqual(tokenEquals(want, ''), false, '空 want 应拒绝');
  assert.strictEqual(tokenEquals(undefined, want), false, 'undefined provided 不抛错');
  assert.strictEqual(tokenEquals(null, want), false, 'null provided 不抛错');
  assert.strictEqual(tokenEquals(want, undefined), false, 'undefined want 不抛错');
  // 非 ASCII（Unicode token）也不抛错：sha256 输入是字符串即可
  assert.strictEqual(tokenEquals('令牌'.repeat(8), '令牌'.repeat(8)), true);
  assert.strictEqual(tokenEquals('令牌'.repeat(8), '令牌'.repeat(7)), false);
});

test('tokenEquals：长度差异不泄密（不同失败输入的结果仅 false，无异常路径）', () => {
  const { tokenEquals } = mini._internal;
  const want = '0123456789abcdef0123456789abcdef';
  // 各种长度(0..64)的错误输入全部安静地返回 false——不存在因长度触发的 throw
  for (let n = 0; n <= 64; n++) {
    assert.strictEqual(tokenEquals('x'.repeat(n), want), false, `长度 ${n} 应安静拒绝`);
  }
});

test('maskToken：完整 token 不出现在输出中，前 4 后 4 保留可辨认性', () => {
  const { maskToken } = mini._internal;
  const token = 'abcdef1234567890abcdef1234567890';
  const masked = maskToken(token);
  assert.ok(!masked.includes(token), '完整 token 不得出现在脱敏输出中');
  assert.ok(!masked.includes(token.slice(4, -4)), '中段（可爆破余量）不得出现');
  assert.ok(masked.startsWith('abcd') && masked.endsWith('7890'), '保留前 4 后 4 便于辨认');
  assert.strictEqual(maskToken('short'), '****', '≤12 位整体打码');
  assert.strictEqual(maskToken(''), '(not set)', '空 token 明示未配置');
  assert.strictEqual(maskToken(null), '(not set)', 'null 不抛错');
  assert.strictEqual(maskToken(undefined), '(not set)', 'undefined 不抛错');
});

test('maskUrlToken：URL 形态日志不泄漏完整 token（V4 审计残留泄漏回归）', () => {
  const { maskUrlToken } = mini._internal;
  const token = '432a7fa69db04c58b4d1637e27eadb4f';
  const url = `http://172.26.120.186:46322/?token=${token}`;
  const masked = maskUrlToken(url);
  assert.ok(!masked.includes(token), '完整 token 不得出现在 URL 日志形态');
  assert.ok(masked.includes('token=432a7fa6…db4f'), '保留前 8 后 4 便于辨认: ' + masked);
  assert.ok(masked.startsWith('http://172.26.120.186:46322/?'), 'URL 其余部分原样保留');
  assert.strictEqual(maskUrlToken('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234/', '无 token 查询串原样返回');
  const amp = maskUrlToken(`http://h/?a=1&token=${token}`);
  assert.ok(!amp.includes(token), '&token= 形态同样掩码');
  assert.strictEqual(maskUrlToken(null), '', 'null 归空串不抛错（url || "" 形态）');
});

// ---------------------------------------------------------------------------
// gui-ws.js（上游 _internal：frame / writeFrame / toolViewFor / lastEventSeq）
// ---------------------------------------------------------------------------
test('frame/writeFrame：server-request 封装与 method 兜底', () => {
  const { frame, writeFrame } = gws._internal;
  const f = frame({ type: 'session/event', data: { x: 1 } });
  assert.strictEqual(f.type, 'server-request');
  assert.strictEqual(f.method, 'session/event');
  assert.ok(typeof f.rpcId === 'string' && f.rpcId.length > 0);
  assert.deepStrictEqual(f.payload, { type: 'session/event', data: { x: 1 } });
  assert.strictEqual(frame(undefined).method, 'session/event');
  assert.strictEqual(frame({ foo: 1 }).method, 'session/event');
  assert.notStrictEqual(frame({ type: 'a' }).rpcId, f.rpcId, 'rpcId 应随机');

  const sent = [];
  const mockWs = {
    send(s) {
      sent.push(s);
      return true;
    },
  };
  assert.strictEqual(writeFrame(mockWs, { type: 'session/event', data: {} }), true);
  const parsed = JSON.parse(sent[0]);
  assert.strictEqual(parsed.type, 'server-request');
  assert.strictEqual(parsed.method, 'session/event');
  assert.deepStrictEqual(parsed.payload, { type: 'session/event', data: {} });
});

test('toolViewFor：tool/call|result 生成卡片视图，其余 undefined', () => {
  const { toolViewFor } = gws._internal;
  assert.deepStrictEqual(toolViewFor({ type: 'tool/call', data: { name: 'bash' } }), {
    for: 'call',
    view: { card: 'bash' },
  });
  assert.deepStrictEqual(toolViewFor({ type: 'tool/result', data: { tool: 'read' } }), {
    for: 'result',
    view: { card: 'read' },
  });
  assert.deepStrictEqual(toolViewFor({ type: 'tool/call', data: { call: { name: 'edit' } } }), {
    for: 'call',
    view: { card: 'edit' },
  });
  assert.deepStrictEqual(toolViewFor({ type: 'tool/call', data: {} }), {
    for: 'call',
    view: { card: 'tool' },
  });
  assert.strictEqual(toolViewFor({ type: 'session/event' }), undefined);
  assert.strictEqual(toolViewFor(null), undefined);
  assert.strictEqual(toolViewFor(undefined), undefined);
});

test('lastEventSeq：seq 减 1 / 事件尾 seq / 兜底 -1', () => {
  const { lastEventSeq } = gws._internal;
  assert.strictEqual(lastEventSeq({ seq: 5 }), 4);
  assert.strictEqual(lastEventSeq({ events: [{ seq: 1 }, { seq: 9 }] }), 9);
  assert.strictEqual(lastEventSeq({ events: [] }), -1);
  assert.strictEqual(lastEventSeq({}), -1);
  assert.strictEqual(lastEventSeq(null), -1);
});

// ---------------------------------------------------------------------------
// zstd-log.js
// ---------------------------------------------------------------------------
test('scanFrame/decompressZstd：识别 node zstd 帧、多帧拼接、垃圾输入', () => {
  const line1 = '{"id":"session-z1","type":"session","title":"t1"}\n';
  const line2 = '{"id":"session-z2","type":"session"}\n';
  const frame1 = zstdCompressSync(Buffer.from(line1));
  const frame2 = zstdCompressSync(Buffer.from(line2));
  assert.ok(frame1.length > 4);

  const f = zlog.scanFrame(frame1, 0);
  assert.ok(f, 'node zstd 输出应为合法 zstd 帧');
  assert.strictEqual(f.start, 0);
  assert.strictEqual(f.end, frame1.length);

  const cat = Buffer.concat([frame1, frame2]);
  const g1 = zlog.scanFrame(cat, 0);
  assert.strictEqual(g1.end, frame1.length);
  const g2 = zlog.scanFrame(cat, g1.end);
  assert.ok(g2, '第二帧应从第一帧结束处接着解析');
  assert.strictEqual(g2.end, cat.length);

  const text = zlog.decompressZstd(cat);
  assert.ok(text.includes('session-z1') && text.includes('session-z2'), '解压应还原两行 JSON');

  assert.strictEqual(zlog.scanFrame(Buffer.alloc(16, 0), 0), null, '全零字节非 zstd 帧');
  assert.strictEqual(zlog.scanFrame(Buffer.from('plain text without magic'), 0), null);
  assert.strictEqual(zlog.scanFrame(frame1, frame1.length + 10), null, '越界 offset 返回 null');
  assert.strictEqual(zlog.scanFrame(Buffer.alloc(2), 0), null, '不足 4 字节返回 null');
});

test('decompressFrames：from 偏移起解析多帧，返回 {text, end}', () => {
  const line1 = '{"id":"session-f1","type":"session"}\n';
  const line2 = '{"id":"session-f2","type":"session"}\n';
  const cat = Buffer.concat([zstdCompressSync(Buffer.from(line1)), zstdCompressSync(Buffer.from(line2))]);
  const all = zlog.decompressFrames(cat, 0);
  assert.ok(all.text.includes('session-f1') && all.text.includes('session-f2'));
  assert.strictEqual(all.end, cat.length, '全部帧解完后 end 应指缓冲尾部');
  const firstFrameEnd = zlog.scanFrame(cat, 0).end;
  const tail = zlog.decompressFrames(cat, firstFrameEnd);
  assert.ok(!tail.text.includes('session-f1') && tail.text.includes('session-f2'), 'from 之后只解后续帧');
});

// ---------------------------------------------------------------------------
// zstd-log.js —— 历史加载优化（头部只读 + 尾部降级，2026-08 卡顿/报错根治）
// ---------------------------------------------------------------------------
test('readHeadBuffer：只读前 maxBytes、空上限、缺文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mini-head-'));
  const p = path.join(tmp, 'big.bin');
  try {
    fs.writeFileSync(p, Buffer.alloc(1024 * 1024, 7));
    const head = zlog.readHeadBuffer(p, 256 * 1024);
    assert.ok(Buffer.isBuffer(head), '应返回 Buffer');
    assert.strictEqual(head.length, 256 * 1024, '只读 256KB 而非整文件（1MB）');
    assert.ok(head.every((b) => b === 7), '内容应为文件前 256KB');
    assert.strictEqual(zlog.readHeadBuffer(p, 0).length, 0, '上限 0 → 空 buffer');
    assert.strictEqual(zlog.readHeadBuffer(path.join(tmp, 'nope'), 1024), null, '缺文件返回 null');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('firstEventId：zstd / 纯文本 / 垃圾 / 空输入', () => {
  const line = '{"id":"session-h1","type":"session","title":"t"}\n';
  const zf = zstdCompressSync(Buffer.from(line));
  assert.strictEqual(zlog.firstEventId(zf, true), 'session-h1', 'zstd 首帧取 id');
  assert.strictEqual(zlog.firstEventId(Buffer.from(line), false), 'session-h1', '纯文本首行取 id');
  assert.strictEqual(zlog.firstEventId(Buffer.from('not json\n'), false), undefined, '非 JSON → undefined');
  assert.strictEqual(zlog.firstEventId(Buffer.alloc(0), true), undefined, '空 buffer → undefined');
  assert.strictEqual(zlog.firstEventId(null, true), undefined, 'null → undefined');
});

test('decompressTailFrames：只解压最后 N 帧并标记 truncated', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `{"seq":${i + 1}}\n`);
  const frames = lines.map((l) => zstdCompressSync(Buffer.from(l)));
  const cat = Buffer.concat(frames);
  const tail = zlog.decompressTailFrames(cat, 3);
  assert.strictEqual(tail.totalFrames, 8, '应扫到 8 帧');
  assert.strictEqual(tail.truncated, true, '8 帧 > 3 帧 → truncated');
  assert.ok(!tail.text.includes('"seq":1') && !tail.text.includes('"seq":5'), '应裁掉最早 5 帧');
  assert.ok(tail.text.includes('"seq":6') && tail.text.includes('"seq":8'), '应保留最后 3 帧');
  const noTrunc = zlog.decompressTailFrames(cat, 100);
  assert.strictEqual(noTrunc.truncated, false, '帧数不超上限 → 不 truncated');
  assert.ok(noTrunc.text.includes('"seq":1') && noTrunc.text.includes('"seq":8'), '全量解压保留全部帧');
});

test('walkSessionFiles：文件超过头部读上限仍能只读头部定位 session id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mini-walkbig-'));
  const sessions = path.join(tmp, 'sessions');
  const sdir = path.join(sessions, 's1');
  fs.mkdirSync(sdir, { recursive: true });
  const filePath = path.join(sdir, 'session.jsonl.zstd');
  try {
    // 合法 header 帧 + 大量非 zstd 垃圾尾部，把文件撑到 >256KB（头部读上限）。
    const head = zstdCompressSync(Buffer.from('{"id":"session-big1","type":"session","title":"big"}\n'));
    fs.writeFileSync(filePath, Buffer.concat([head, Buffer.alloc(512 * 1024, 0)]));
    assert.ok(fs.statSync(filePath).size > 256 * 1024, '文件应大于头部读上限');
    zlog.resetFileMapCache();
    const m = zlog.walkSessionFiles(tmp);
    assert.strictEqual(m.get('session-big1'), filePath, '只读头部即可定位 id（不读全文件）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readAllLogEvents / foldLogEvents：多帧文件完整读与折叠（回归）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mini-events-'));
  const filePath = path.join(tmp, 'session.jsonl.zstd');
  try {
    const lines = [
      '{"id":"session-e1","type":"session","title":"标题","time":1}\n',
      '{"type":"user/message","seq":1,"time":2}\n',
      '{"type":"assistant/message","seq":2,"time":3}\n',
    ];
    const frames = lines.map((l) => zstdCompressSync(Buffer.from(l)));
    fs.writeFileSync(filePath, Buffer.concat(frames));

    const events = zlog.readAllLogEvents(filePath);
    assert.strictEqual(events.length, 3, '应完整读回 3 个事件');
    assert.strictEqual(events[0].id, 'session-e1');
    assert.strictEqual(events[2].seq, 2, '尾部事件 seq 正确');

    const fold = zlog.foldLogEvents(filePath);
    assert.strictEqual(fold.title, '标题', 'fold 应提取 title');
    assert.strictEqual(fold.updatedAt, 3, 'fold 应取最大 time');
    assert.strictEqual(fold.events.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('walkSessionFiles：TTL 内复用缓存、reset 重建、缺目录不抛错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mini-zstd-test-'));
  const sessions = path.join(tmp, 'sessions');
  const sdir = path.join(sessions, 's1');
  fs.mkdirSync(sdir, { recursive: true });
  const filePath = path.join(sdir, 'session.jsonl.zstd');
  fs.writeFileSync(filePath, zstdCompressSync(Buffer.from('{"id":"session-w1","type":"session"}\n')));
  try {
    zlog.resetFileMapCache();
    const m1 = zlog.walkSessionFiles(tmp);
    assert.ok(m1 instanceof Map);
    assert.strictEqual(m1.get('session-w1'), filePath, 'map 应映射 sessionId -> 文件路径');

    // 上游 v1.4.x 为纯 TTL 缓存（60s 内且 map 非空即复用，不做目录 mtime 短路）：
    const m2 = zlog.walkSessionFiles(tmp);
    assert.strictEqual(m2, m1, 'TTL 内 → 直接复用同一缓存引用');

    zlog.resetFileMapCache();
    const m4 = zlog.walkSessionFiles(tmp);
    assert.notStrictEqual(m4, m1, 'reset 后应重新构建');
    assert.strictEqual(m4.get('session-w1'), filePath);

    const m5pre = zlog.walkSessionFiles(path.join(tmp, 'nope'));
    assert.strictEqual(m5pre, m4, 'TTL 内且缓存非空 → 缺目录调用也直接命中缓存');
    zlog.resetFileMapCache();
    const m5 = zlog.walkSessionFiles(path.join(tmp, 'nope'));
    assert.ok(m5 instanceof Map && m5.size === 0, '缓存重建后不存在的目录 → 空 Map 不抛错');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
