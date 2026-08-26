// dsh-input-history — 终端式上下键命令历史回溯（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   1. 经 conversation.input.left 槽位拿到 inputActions / input / session
//      （与 dsh-file-drop 同款：sessions.provide 注入 inputActions + input，
//       槽位 owner zone 注入 session），登记「当前会话环境」；
//   2. 捕获阶段 keydown（document）拦截 ↑/↓：
//        · 光标在输入框、空草稿、无 shift/ctrl/meta/alt 组合键时才回溯；
//        · 回溯过程中 ↑/↓ 继续翻（草稿此时非空，靠「是否在回溯」状态放行）；
//        · ↓ 越过最新历史回到空；
//        · 用户一旦手动编辑（原生 input 事件，setDraft 不触发）即复位指针。
//   3. 历史来源：优先本会话已发送的用户消息（session.chat 真实消息，挂载时
//      播种）；发送瞬间经「包装 submit + 回车捕获」自建记录，保证最新一条
//      立刻可回溯（连续重复去重，不重不漏）。
//   4. 按会话隔离：历史与导航指针都以 inputActions 为 key。
//
// 纯逻辑挂在 window.__dshInputHistoryCore（生产无副作用），供 node 测试套件
// 直接评估本文件验证 —— 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────

  /** 是否 Map 形态（跨 realm 安全，不依赖 instanceof）。 */
  function isMapLike(x) {
    return !!x && typeof x.get === 'function' && typeof x.forEach === 'function';
  }

  /** 内容块 → 纯文本（type:'text' 的块按序拼接；其余块忽略）。 */
  function contentText(content) {
    if (!Array.isArray(content)) return '';
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('');
  }

  /**
   * 从会话快照提取本会话用户消息（真实历史，最旧→最新）。
   * 不可读（旧内核 / 无 chat）返回 null；可读返回 string[]（跳过纯图片消息）。
   */
  function extractUserMessages(session) {
    if (!session || !session.chat) return null;
    var nodes = session.chat.nodes;
    var order = session.chat.order;
    if (!isMapLike(nodes) || !Array.isArray(order)) return null;
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var node = nodes.get(order[i]);
      if (!node || node.kind !== 'user') continue;
      var text = contentText(node.content);
      if (text !== '') out.push(text);
    }
    return out;
  }

  /**
   * 终端式历史导航状态机（纯逻辑；history 输入为最旧→最新）。
   * 语义（与终端命令行历史对齐）：
   *   · ↑ 首次触发：当前草稿作为临时第 0 条（空则跳过），之后逐条往旧翻；
   *   · ↓ 逐条往新翻，越过最新（第 0 条）之后回到空；
   *   · 手动编辑复位（reset 后下次 ↑ 从头开始）。
   */
  function createHistoryController() {
    var state = { history: [], saved: '', pos: -1, entries: [] };

    function rebuild() {
      var entries = [];
      if (state.saved !== '') entries.push(state.saved);   // 临时第 0 条（最新）
      for (var i = state.history.length - 1; i >= 0; i--) entries.push(state.history[i]);
      state.entries = entries;
    }

    function reset() {
      state.saved = '';
      state.pos = -1;
      rebuild();
    }

    /** 设置历史（最旧→最新）；内容未变时返回 false 且不重置指针。 */
    function setHistory(list) {
      var next = (list || []).slice();
      var same = next.length === state.history.length;
      if (same) {
        for (var i = 0; i < next.length; i++) {
          if (next[i] !== state.history[i]) { same = false; break; }
        }
      }
      if (same) return false;
      state.history = next;
      reset();
      return true;
    }

    function isNavigating() { return state.pos !== -1; }

    /** 追加一条历史（最旧→最新末尾），连续重复去重；成功追加返回 true。 */
    function append(text) {
      var t = String(text == null ? '' : text);
      if (t === '') return false;
      if (state.history.length > 0 && state.history[state.history.length - 1] === t) return false;
      state.history.push(t);
      reset();
      return true;
    }

    function getHistory() { return state.history.slice(); }

    function up(currentDraft) {
      if (state.pos === -1) {
        state.saved = String(currentDraft == null ? '' : currentDraft);
        rebuild();
        if (state.history.length === 0) return null;   // 无历史可翻
        state.pos = state.saved !== '' ? 1 : 0;        // 空草稿从最新历史起，非空先跳过临时条
        if (state.pos >= state.entries.length) return null;
        return state.entries[state.pos];
      }
      if (state.pos >= state.entries.length - 1) return state.entries[state.pos]; // 已在最旧
      state.pos += 1;
      return state.entries[state.pos];
    }

    function down() {
      if (state.pos === -1) return null;   // 未在回溯中
      state.pos -= 1;
      if (state.pos < 0) {                 // 越过最新 → 回到空
        reset();
        return '';
      }
      return state.entries[state.pos];
    }

    return {
      setHistory: setHistory,
      append: append,
      getHistory: getHistory,
      reset: reset,
      isNavigating: isNavigating,
      up: up,
      down: down,
      _state: state,
    };
  }

  // 暴露纯逻辑供测试；生产无副作用。
  var core = {
    isMapLike: isMapLike,
    contentText: contentText,
    extractUserMessages: extractUserMessages,
    createHistoryController: createHistoryController,
  };
  if (typeof window !== 'undefined') {
    window.__dshInputHistoryCore = core;
  }

  // ───────── 运行时状态（按会话 inputActions 隔离） ─────────
  var controllerBySession = new Map();    // key -> controller（controller 是历史+指针的唯一数据源）
  var activeEnv = null;                   // { key, inputActions, inputRef }

  function controllerFor(key) {
    var c = controllerBySession.get(key);
    if (!c) { c = createHistoryController(); controllerBySession.set(key, c); }
    return c;
  }

  // 统一暴露运行时（测试驱动用；生产无副作用）。
  if (typeof window !== 'undefined') {
    window.__dshInputHistoryStore = {
      snapshotHistory: function (key) { return key ? controllerFor(key).getHistory() : []; },
      snapshotController: function (key) { return key ? controllerFor(key)._state : null; },
      resetController: function (key) { if (key) controllerFor(key).reset(); },
      recordSubmitDraft: recordSubmitDraft,
    };
  }

  // ───────────────────────── DOM 粘合 ─────────────────────────

  /** 找到当前会话的输入框（React 受控 textarea，与 dsh-file-drop 同款）。 */
  function findComposer() {
    var ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return ae;
    if (typeof document === 'undefined') return null;
    var root = document.querySelector('[data-slot="conversation.session"]');
    var scope = root || document;
    return scope.querySelector('textarea');
  }

  /** 当前草稿：优先 DOM 真值（textarea.value），回退 input 快照 draft。 */
  function draftOf(env) {
    var c = findComposer();
    if (c && typeof c.value === 'string') return c.value;
    var inp = env && env.inputRef && env.inputRef.current;
    if (inp && typeof inp.draft === 'string') return inp.draft;
    return '';
  }

  /** 输入框是否为空（DOM 真值优先）。 */
  function isDraftEmpty() {
    var c = findComposer();
    if (c && typeof c.value === 'string') return c.value === '';
    var inp = activeEnv && activeEnv.inputRef && activeEnv.inputRef.current;
    return !inp || inp.draft === '' || inp.draft == null;
  }

  /** 输入机是否忙（adjudicating/submitting），忙时回车不会真正发送。 */
  function isMachineBusy(env) {
    var inp = env && env.inputRef && env.inputRef.current;
    return !!inp && (inp.phase === 'adjudicating' || inp.phase === 'submitting');
  }

  /** 记录一条「已发送草稿」进入历史（连续重复去重 + 复位导航指针）。 */
  function recordSubmitDraft(key, draft) {
    controllerFor(key).append(draft);     // append 内部处理空草稿/连续去重 + reset
  }

  function setDraftAndPlaceCaret(inputActions, text) {
    try {
      inputActions.setDraft(text);
    } catch (_e) { return; }
    // 尽力把光标放到末尾（回溯体验）；失败静默。
    try {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          var c = findComposer();
          if (c && typeof c.setSelectionRange === 'function') {
            try { c.focus(); } catch (_e2) { /* 聚焦失败不挡功能 */ }
            var len = String(c.value || '').length;
            c.setSelectionRange(len, len);
          }
        });
      }
    } catch (_e3) { /* 光标位置非关键，静默 */ }
  }

  function isArrow(e) {
    return e && (e.key === 'ArrowUp' || e.key === 'ArrowDown');
  }
  function hasModifiers(e) {
    return !!(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey);
  }
  function isComposerTarget(e) {
    var t = e && e.target;
    if (!t || (t.tagName !== 'TEXTAREA' && t.isContentEditable !== true)) return false;
    var ae = typeof document !== 'undefined' ? document.activeElement : null;
    return ae === t;
  }
  function isComposing(e) {
    var n = e && e.nativeEvent;
    return !!(n && (n.isComposing || n.keyCode === 229));
  }

  function onKeydown(e) {
    if (!activeEnv || !activeEnv.inputActions || typeof activeEnv.inputActions.setDraft !== 'function') return;

    // —— 上下键历史回溯 ——
    if (isArrow(e)) {
      if (hasModifiers(e) || !isComposerTarget(e)) return;
      var ctrl = controllerFor(activeEnv.key);

      if (ctrl.isNavigating()) {
        // 回溯中：↑/↓ 都交给本插件（此时草稿非空，但已是历史条目，不误判）。
        var text = e.key === 'ArrowUp' ? ctrl.up() : ctrl.down();
        if (text === null) return;
        e.preventDefault();
        e.stopPropagation();
        setDraftAndPlaceCaret(activeEnv.inputActions, text);
        return;
      }

      // 未回溯：仅空草稿才触发（避免打断正在输入的多行内容）。
      if (!isDraftEmpty()) return;
      var text2 = e.key === 'ArrowUp' ? ctrl.up(draftOf(activeEnv)) : null;
      if (text2 === null) return;
      e.preventDefault();
      e.stopPropagation();
      setDraftAndPlaceCaret(activeEnv.inputActions, text2);
      return;
    }

    // —— 回车发送（绕过 actions.submit 的 keyboard.submit 路径）：记录草稿 ——
    if (e && (e.key === 'Enter' || e.keyCode === 13)) {
      if (e.shiftKey || e.repeat || isComposing(e) || isMachineBusy(activeEnv)) return;
      recordSubmitDraft(activeEnv.key, draftOf(activeEnv));
      // 不 preventDefault / 不拦截，交内核处理发送。
    }
  }

  // 用户手动编辑（原生 input 事件）→ 复位导航指针。setDraft 走 React 受控
  // 路径，不派发原生 input 事件，因此这里命中的必然是用户输入。
  function onInput(e) {
    if (!activeEnv) return;
    var t = e && e.target;
    if (!t || (t.tagName !== 'TEXTAREA' && t.isContentEditable !== true)) return;
    controllerFor(activeEnv.key).reset();
  }

  var listenersAttached = false;
  function attachGlobalListeners() {
    if (listenersAttached) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('input', onInput, true);
    listenersAttached = true;
  }

  // ───────────────────────── 槽位注册（拿 inputActions/input/session） ─────────────────────────

  function attachSlot(ctx, react) {
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    function HistorySlot(props) {
      props = props || {};
      var inputActions = props.inputActions;
      var input = props.input;       // input 状态快照（含 draft/phase/imageIds）
      var session = props.session;   // 会话快照（含 chat.nodes/order）

      var inputRef = useRef(input);
      useEffect(function () { inputRef.current = input; });

      useEffect(function () {
        if (!inputActions || typeof inputActions.setDraft !== 'function' || typeof inputActions.submit !== 'function') return;
        var key = inputActions;
        var env = { key: key, inputActions: inputActions, inputRef: inputRef };
        activeEnv = env;

        // 播种：首次挂载且历史为空时，用真实消息回填（已发送的旧消息）。
        var ctrl = controllerFor(key);
        if (ctrl.getHistory().length === 0) {
          var real = extractUserMessages(session);
          if (real && real.length > 0) ctrl.setHistory(real);
        }

        // 发送按钮路径：包装 submit 记录草稿（回车路径由 keydown 捕获记录）。
        var orig = inputActions.submit;
        inputActions.submit = function () {
          recordSubmitDraft(key, draftOf(env));
          return orig();
        };

        return function () {
          inputActions.submit = orig;
          if (activeEnv === env) activeEnv = null;
        };
      }, [inputActions]);

      return null;
    }

    try {
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-input-history',
          order: 5, // 无视觉元素；仅需登记到该槽位拿到 inputActions/input/session
        }, HistorySlot);
      }, 'dsh-input-history: terminal-style input history');
    } catch (_e) { /* 槽位系统不可用（旧内核）：仅保留全局监听降级 */ }
  }

  // ───────────────────────── 注册 ─────────────────────────
  window.__ModuleLoader__.load({
    id: 'dsh-input-history',
    factory: function (require) {
      // RV4 A1：apply 使用 ctx.slots —— 必须在模块工厂的 inject 清单里声明
      // "slots"，否则模块系统代理抛 "cannot get property 'slots' without inject"。
      var inject = ["slots"];
      var react = null;
      try {
        react = require("react");
      } catch (_e) { /* 缺 react：不注册槽位，全局监听（无会话上下文）降级为 no-op */ }

      function apply(ctx) {
        attachGlobalListeners();
        if (react && ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          attachSlot(ctx, react);
        }
      }
      var module = { exports: {} };
      module.exports = { inject: inject, apply: apply, core: core };
      return module.exports;
    },
  });
})();
