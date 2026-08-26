// @deepseek-ai/dsh-mini — zstd-log.js
// zstd-framed session log 读取工具（dsh-side-session 模式），供 index.js（旧手机页）
// 与 gui-api.js（v3 GUI history）共用。模块级缓存跨两处共享。
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE
const FILE_MAP_TTL_MS = 60_000;
const MAX_LOG_EVENTS = 4000;
// 头部只读上限：仅覆盖第一条 zstd 帧的 header（对齐内核 256KB 封顶先例）。
const SESSION_HEAD_READ_BYTES = 256 * 1024;
// 全量解压上限：超过该压缩字节数即退化为「只读尾部 N 帧」，避免超大日志 OOM。
const MAX_LOG_DECOMPRESS_BYTES = 16 * 1024 * 1024;
const MAX_LOG_TAIL_FRAMES = 512;

export { ZSTD_MAGIC };

export function scanFrame(buf, offset) {
  if (buf.length - offset < 4) return null;
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return null;
  let o = offset + 4;
  const desc = buf.readUInt8(o++);
  if ((desc & 24) !== 0) return null;
  const csf = desc >>> 6;
  const singleSeg = (desc & 32) !== 0;
  const checksum = (desc & 4) !== 0;
  const dictFlag = desc & 3;
  const dictBytes = dictFlag === 3 ? 4 : dictFlag;
  const contentSizeBytes = csf === 0 ? (singleSeg ? 1 : 0) : 1 << csf;
  let remaining = (singleSeg ? 0 : 1) + dictBytes + contentSizeBytes;
  if (buf.length - o < remaining) return null;
  o += remaining;
  for (;;) {
    if (buf.length - o < 3) return null;
    const bh = buf.readUIntLE(o, 3);
    o += 3;
    const last = (bh & 1) !== 0;
    const bt = (bh >>> 1) & 3;
    const bs = bh >>> 3;
    if (bt === 3) return null;
    const payload = bt === 1 ? 1 : bs;
    if (buf.length - o < payload) return null;
    o += payload;
    if (last) break;
  }
  if (checksum) o += 4;
  return { start: offset, end: o };
}

export function decompressZstd(buf) {
  let offset = 0;
  let out = "";
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    try {
      out += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    } catch {
      break;
    }
    offset = f.end;
    if (offset >= buf.length) break;
  }
  return out;
}

export function decompressFrames(buf, from) {
  let offset = from;
  let out = "";
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    try {
      out += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    } catch {
      break;
    }
    offset = f.end;
    if (offset >= buf.length) break;
  }
  return { text: out, end: offset };
}

// 只扫帧边界、不解压，然后仅解压最后 `maxFrames` 帧。超大日志缓存 miss 时的
// 有界降级：避免把整份日志全量解压进内存导致 OOM/卡死。返回 totalFrames 供
// 上层判断是否发生了裁剪（truncated）。
export function decompressTailFrames(buf, maxFrames) {
  const starts = [];
  let offset = 0;
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    starts.push(f.start);
    offset = f.end;
    if (offset >= buf.length) break;
  }
  if (starts.length === 0) return { text: "", end: 0, totalFrames: 0, truncated: false };
  const truncated = starts.length > maxFrames;
  const from = truncated ? starts[starts.length - maxFrames] : 0;
  const { text, end } = decompressFrames(buf, from);
  return { text, end, totalFrames: starts.length, truncated };
}

export function parseLines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Walk <dshHome>/sessions/**/session.jsonl.zstd once, mapping session id -> file.
let fileMapCache = { at: 0, map: new Map() };

export function resetFileMapCache() {
  fileMapCache = { at: 0, map: new Map() };
}

// 有界头部读：只读文件前 `maxBytes` 字节。walkSessionFiles 只要第一条事件的
// id，绝不能对每个会话整读多 MB 日志（O(n × 会话总字节) 遍历即卡顿源）。
export function readHeadBuffer(path, maxBytes) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const size = Math.min(st.size, maxBytes);
  if (size <= 0) return Buffer.alloc(0);
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

// 从首帧（header）第一行提取 session id；非 zstd 走纯文本首行。空/损坏返回 undefined。
export function firstEventId(headBuf, isZstd) {
  if (!headBuf || headBuf.length === 0) return undefined;
  let head = null;
  if (isZstd) {
    const f = scanFrame(headBuf, 0);
    if (f) {
      try {
        head = JSON.parse(
          zstdDecompressSync(headBuf.subarray(f.start, f.end)).toString("utf8").split("\n", 1)[0]
        );
      } catch {
        /* skip */
      }
    }
  } else {
    try {
      head = JSON.parse(headBuf.toString("utf8").split("\n", 1)[0]);
    } catch {
      /* skip */
    }
  }
  return head && typeof head.id === "string" ? head.id : undefined;
}

export function walkSessionFiles(dshHome) {
  const now = Date.now();
  if (now - fileMapCache.at < FILE_MAP_TTL_MS && fileMapCache.map.size > 0) {
    return fileMapCache.map;
  }
  const map = new Map();
  const root = join(dshHome, "sessions");
  const visit = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) visit(join(dir, e.name), depth + 1);
      else if (e.name === "session.jsonl.zstd" || e.name === "session.jsonl") {
        const p = join(dir, e.name);
        try {
          const headBuf = readHeadBuffer(p, SESSION_HEAD_READ_BYTES);
          const id = firstEventId(headBuf, e.name.endsWith(".zstd"));
          if (id !== undefined && !map.has(id)) map.set(id, p);
        } catch {
          /* skip */
        }
      }
    }
  };
  try {
    visit(root, 0);
  } catch {
    /* skip */
  }
  fileMapCache = { at: now, map };
  return map;
}

export function findSessionFile(dshHome, sessionId) {
  const map = walkSessionFiles(dshHome);
  if (map.has(sessionId)) return map.get(sessionId);
  const cands = [];
  if (sessionId.startsWith("session-")) cands.push(sessionId.slice("session-".length));
  else cands.push("session-" + sessionId);
  for (const c of cands) {
    if (map.has(c)) return map.get(c);
  }
  return "";
}

// ---- fold helpers over raw log events ----
export function freshFoldState() {
  return { events: [], title: "", model: null, updatedAt: 0 };
}

export function foldInto(state, evs) {
  for (const ev of evs) {
    if (!ev || typeof ev !== "object") continue;
    if (typeof ev.time === "number" && ev.time > state.updatedAt) state.updatedAt = ev.time;
    if (ev.type === "session/title" && ev.data && typeof ev.data.title === "string") {
      state.title = ev.data.title;
    } else if (ev.type === "session" && typeof ev.title === "string") {
      state.title = ev.title;
    } else if (ev.type === "request/header" && ev.data) {
      const cfg = (ev.data.config || (ev.data.header && ev.data.header.config)) || null;
      if (cfg && cfg.provider && cfg.model) {
        state.model = {
          provider: String(cfg.provider),
          model: String(cfg.model),
          reasoningEffort: cfg.reasoningEffort !== undefined ? cfg.reasoningEffort : undefined,
        };
      }
    } else if (ev.type === "request/context" && ev.data && ev.data.provider && ev.data.model) {
      if (state.model) {
        state.model.provider = String(ev.data.provider);
        state.model.model = String(ev.data.model);
      } else {
        state.model = { provider: String(ev.data.provider), model: String(ev.data.model), reasoningEffort: undefined };
      }
    }
    state.events.push(ev);
  }
  if (state.events.length > MAX_LOG_EVENTS) {
    state.events = state.events.slice(state.events.length - MAX_LOG_EVENTS);
  }
}

const foldCache = new Map();
function capMap(map, max) {
  if (map.size <= max) return;
  let extra = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--extra <= 0) break;
  }
}

export function foldLogEvents(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { events: [], title: "", model: null, updatedAt: 0 };
  }
  const cached = foldCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.state;
  }
  const buf = readFileSync(file);
  const firstMagic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
  const isZstd = firstMagic === ZSTD_MAGIC;
  let state = null;
  let frameEnd = 0;
  if (
    isZstd &&
    cached &&
    cached.isZstd &&
    cached.firstMagic === firstMagic &&
    cached.frameEnd > 0 &&
    cached.frameEnd <= buf.length &&
    cached.size <= st.size
  ) {
    const inc = decompressFrames(buf, cached.frameEnd);
    if (inc.text) {
      state = cached.state;
      foldInto(state, parseLines(inc.text));
      frameEnd = inc.end;
    } else {
      state = cached.state;
      frameEnd = cached.frameEnd;
    }
  }
  if (!state) {
    state = freshFoldState();
    if (isZstd) {
      if (buf.length > MAX_LOG_DECOMPRESS_BYTES) {
        // 有界降级：只折叠 header 帧 + 最后 N 帧。title 从 header 帧保留，
        // asOfSeq/updatedAt 取自尾部；避免超大日志全量解压 OOM/卡死。
        const hf = scanFrame(buf, 0);
        let headText = "";
        if (hf) {
          try {
            headText = zstdDecompressSync(buf.subarray(hf.start, hf.end)).toString("utf8");
          } catch {
            /* ignore */
          }
        }
        const tail = decompressTailFrames(buf, MAX_LOG_TAIL_FRAMES);
        if (tail.truncated && headText) foldInto(state, parseLines(headText));
        if (tail.text) foldInto(state, parseLines(tail.text));
        frameEnd = tail.end;
      } else {
        foldInto(state, parseLines(decompressZstd(buf)));
        frameEnd = decompressFrames(buf, 0).end;
      }
    } else {
      foldInto(state, parseLines(buf.toString("utf8")));
      frameEnd = buf.length;
    }
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, firstMagic, isZstd, frameEnd, state };
  foldCache.set(file, entry);
  capMap(foldCache, 200);
  return state;
}

// 完整日志事件流（GUI history 用，不裁剪）。
// 增量读：session.history 每次 loadOlder 都调 readAllLogEvents(file)，若每次
// 都 readFileSync + 全量 zstd 解压 + 逐行 JSON.parse（前端只请求 maxMessages:50，
// 后端代价 O(整份日志)）。此处复用 foldLogEvents 同款 (mtimeMs,size,frameEnd)
// 增量缓存：首次全量解压后，后续 loadOlder 仅解压新增尾部帧，不再整份解压；
// 文件缩小/变更即失效重读，不掩盖真实变更。非 zstd（纯文本 JSONL）路径保持
// 原样（无帧边界，未变文件命中缓存、变更则全量重读）。
const allEventsCache = new Map();
export function readAllLogEvents(file) {
  try {
    let st;
    try {
      st = statSync(file);
    } catch {
      return [];
    }
    const cached = allEventsCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.events;
    const buf = readFileSync(file);
    const firstMagic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
    const isZstd = firstMagic === ZSTD_MAGIC;
    let events;
    let frameEnd;
    if (isZstd && cached && cached.isZstd && cached.frameEnd > 0 && cached.frameEnd <= buf.length && cached.size <= st.size) {
      const inc = decompressFrames(buf, cached.frameEnd);
      events = cached.events;
      if (inc.text) events = events.concat(parseLines(inc.text));
      frameEnd = inc.end;
    } else if (isZstd) {
      if (buf.length > MAX_LOG_DECOMPRESS_BYTES) {
        // 有界降级：只保留尾部帧（session.history 真正需要的最近事件），
        // 不全量解压超大日志，避免 OOM/卡死。
        const tail = decompressTailFrames(buf, MAX_LOG_TAIL_FRAMES);
        events = parseLines(tail.text);
        frameEnd = tail.end;
      } else {
        events = parseLines(decompressZstd(buf));
        frameEnd = decompressFrames(buf, 0).end;
      }
    } else {
      events = parseLines(buf.toString("utf8"));
      frameEnd = buf.length;
    }
    allEventsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, isZstd, frameEnd, events });
    capMap(allEventsCache, 200);
    return events;
  } catch {
    return [];
  }
}

export function dshHome() {
  return process.env.DSH_HOME || homedir() + "/.dsh";
}