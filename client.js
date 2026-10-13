/**
 * Browser half of the session-trash bundle.
 * Hand-written `__ModuleLoader__` package shell for DeepSeek Harness.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-recycle-bin',
  factory: (require) => {
    'use strict';
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    const API_PREFIX = '/api/session-trash';

    /**
     * Host toast timing, mirrored so a plugin notice lives as long as a host
     * one: `LONG_TOAST_HOLD_MS` in dsh-client-ui-workspace is 6e3 (this layer
     * used 4000), and Toast.module.css fades over 1000ms after that hold.
     */
    const TOAST_HOLD_MS = 6000;
    const TOAST_FADE_MS = 1000;

    /** Host tooltip delay for an icon-only action button (dsh-client-ui-workspace). */
    const TOOLTIP_DELAY_MS = 500;

    /**
     * Hover info card timing: `OPEN` matches the panel's existing 200ms hover
     * delay, `CLOSE` is the grace period that lets the pointer travel from the
     * row onto the card without it vanishing on the way.
     */
    const TOOLTIP_OPEN_DELAY_MS = 200;
    const TOOLTIP_CLOSE_DELAY_MS = 250;

    /**
     * Sub-session (delegation children) display limits: rows rendered before the
     * "N more" control, and the list length above which the permanent-delete
     * confirmation scrolls its own list instead of growing the dialog.
     */
    const CHILD_ROW_LIMIT = 50;
    const CASCADE_DIALOG_LIST_LIMIT = 8;

    const MESSAGES = {
      en: {
        undo: 'Undo',
        loadFailed: 'Failed to load the recycle bin',
        restored: 'Restored session “{title}”',
        undoFailed: 'Undo failed',
        restoreFailed: 'Restore failed: {message}',
        confirmPermanentTitle: 'Confirm permanent deletion',
        confirmPermanentBody: 'Permanently delete the session “{title}”? This cannot be undone and its conversation history will be erased.',
        deleteFailed: 'Deletion failed: {message}',
        unknownError: 'Unknown error',
        deleted: 'Session permanently deleted',
        deleteArchivedTitle: 'Permanently delete archived sessions',
        deleteWorkspaceBody: 'Permanently delete {count} session(s) from the workspace “{title}”? This cannot be undone.',
        deletedSelected: 'Selected archived sessions permanently deleted',
        deleteAllTitle: 'Delete all archived sessions',
        deleteAllBody: 'Permanently delete all {count} archived session(s)? This cannot be undone.',
        emptied: 'Permanently deleted all {count} session(s) from the recycle bin',
        emptyFailed: 'Failed to empty the recycle bin: {message}',
        historyFailed: 'Failed to load session history: {message}',
        other: 'Other',
        otherProjects: 'Other projects',
        otherWorkspaces: 'Other workspaces',
        unnamedProject: 'Unnamed project',
        unnamedSession: 'Unnamed session',
        recycleBin: 'Session Recycle Bin',
        archivedCount: '{count} archived session(s)',
        searchPlaceholder: 'Search archived sessions...',
        allProjects: 'All projects',
        newestFirst: 'Recently deleted (newest first)',
        oldestFirst: 'Oldest deleted (oldest first)',
        deleteAll: 'Delete all',
        loading: 'Loading archived sessions...',
        empty: 'The recycle bin is empty',
        noMatches: 'No matching archived sessions found',
        sessionCount: '{count} session(s)',
        projectActions: 'Project actions',
        selectedSuffix: '{title} ({count} selected)',
        deleteSelected: 'Permanently delete selected ({count})',
        deleteProject: 'Permanently delete all in project',
        turnCount: '{count} turn(s)',
        view: 'View',
        restore: 'Restore',
        permanentlyDelete: 'Permanently delete',
        previewTitle: 'Session: {title}',
        loadingHistory: 'Loading conversation history...',
        noHistory: 'No conversation history',
        user: '👤 User',
        assistant: '🤖 Assistant',
        cancel: 'Cancel',
        confirmDelete: 'Confirm deletion',
        storagePath: 'Storage path: {path}',
        noActiveSession: 'Could not identify the active session ID',
        movedToBin: 'Moved session “{title}” to the recycle bin',
        currentSession: 'Current session',
        session: 'Session',
        moveFailed: 'Failed to move session to the recycle bin: {message}',
        moveToBin: 'Move to Recycle Bin',
        sessionRunning: 'The session is currently running and cannot be deleted.',
        // Sub-session (delegation children) badge, inline list and cascade delete.
        listSeparator: ', ',
        childrenCount: '{count} sub-session(s)',
        childrenBadgeLabel: 'Sub-sessions of this session: {count}',
        childrenRunning: 'Running',
        childrenRunningHint: 'Can be deleted once it finishes',
        childrenMore: '{count} more',
        childrenEmpty: 'No sub-sessions',
        childrenJustNow: 'Just now',
        childrenMinutesAgo: '{count} min ago',
        childrenHoursAgo: '{count} h ago',
        childrenYesterday: 'Yesterday',
        childrenThisWeek: 'This week',
        childrenEarlier: 'Earlier',
        selectSessionOnly: 'Selects this session only, not its sub-sessions',
        childrenRunningBlocked: 'Sub-session “{titles}” is still running — delete it after it finishes.',
        childrenNoneSelected: 'Select at least one sub-session first.',
        cascadeDeleteTitle: 'Confirm permanent deletion',
        cascadeDeleteBody: 'Permanently delete {parents} main session(s) + {children} sub-session(s) ({size} in total)? This cannot be undone.',
        orphanCardTitle: 'Deleted main session · {count} sub-session(s) kept',
        orphanKept: 'Kept',
      },
      zh: {
        undo: '撤销',
        loadFailed: '加载回收站列表失败',
        restored: '已恢复会话「{title}」',
        undoFailed: '撤销失败',
        restoreFailed: '恢复失败: {message}',
        confirmPermanentTitle: '确认彻底删除',
        confirmPermanentBody: '确定要永久删除会话「{title}」吗？此操作不可撤销，历史对话记录将被完全清除。',
        deleteFailed: '删除失败: {message}',
        unknownError: '未知错误',
        deleted: '已彻底删除会话',
        deleteArchivedTitle: '彻底删除归档会话',
        deleteWorkspaceBody: '确定要永久删除工作区「{title}」下的 {count} 个会话吗？此操作不可撤销。',
        deletedSelected: '已彻底删除所选归档会话',
        deleteAllTitle: '全部删除归档会话',
        deleteAllBody: '确定要永久删除全部 {count} 个归档会话吗？此操作不可撤销。',
        emptied: '已清空回收站中全部 {count} 个会话',
        emptyFailed: '清空失败: {message}',
        historyFailed: '获取会话记录失败: {message}',
        other: '其他',
        otherProjects: '其他项目',
        otherWorkspaces: '其他工作区',
        unnamedProject: '未命名项目',
        unnamedSession: '未命名会话',
        recycleBin: '会话回收站',
        archivedCount: '共 {count} 个已归档会话',
        searchPlaceholder: '搜索已归档聊天...',
        allProjects: '所有项目',
        newestFirst: '最近删除 (降序)',
        oldestFirst: '最早删除 (正序)',
        deleteAll: '全部删除',
        loading: '加载已归档会话...',
        empty: '回收站暂无会话',
        noMatches: '未找到匹配的归档会话',
        sessionCount: '{count} 个聊天',
        projectActions: '项目操作',
        selectedSuffix: '{title} (选中的 {count} 项)',
        deleteSelected: '彻底删除选中 ({count})',
        deleteProject: '彻底删除项目全部',
        turnCount: '{count} 轮对话',
        view: '查看',
        restore: '还原',
        permanentlyDelete: '彻底删除',
        previewTitle: '查看会话：{title}',
        loadingHistory: '正在读取历史对话记录...',
        noHistory: '暂无对话记录',
        user: '👤 用户',
        assistant: '🤖 助手',
        cancel: '取消',
        confirmDelete: '确定删除',
        storagePath: '存储路径: {path}',
        noActiveSession: '无法识别当前活动会话 ID',
        movedToBin: '已将会话「{title}」移入回收站',
        currentSession: '当前会话',
        session: '会话',
        moveFailed: '移入回收站失败: {message}',
        moveToBin: '移入回收站',
        sessionRunning: '会话正在运行中，无法删除',
        // 子会话（委派后代）徽标、行内清单与级联删除
        listSeparator: '、',
        childrenCount: '{count} 个子会话',
        childrenBadgeLabel: '该会话的子会话数：{count}',
        childrenRunning: '运行中',
        childrenRunningHint: '结束后可删除',
        childrenMore: '还有 {count} 条',
        childrenEmpty: '没有子会话',
        childrenJustNow: '刚刚',
        childrenMinutesAgo: '{count} 分钟前',
        childrenHoursAgo: '{count} 小时前',
        childrenYesterday: '昨天',
        childrenThisWeek: '本周',
        childrenEarlier: '更早',
        selectSessionOnly: '仅选择该会话，不含其子会话',
        childrenRunningBlocked: '子会话「{titles}」仍在运行中，结束后才能删除。',
        childrenNoneSelected: '请先勾选至少一个子会话。',
        cascadeDeleteTitle: '彻底删除会话',
        cascadeDeleteBody: '确定要彻底删除 {parents} 个主会话 + {children} 个子会话（共 {size}）吗？此操作不可撤销。',
        orphanCardTitle: '已删除的主会话 · 保留 {count} 个子会话',
        orphanKept: '已保留',
      },
    };

    /**
     * Host locale service (0.1.5 Web app mounts `@deepseek-ai/dsh-client-locale`
     * as `locale`). It owns the Language row in Settings and resolves explicit
     * choice → browser → English; the browser is only its fallback, so asking
     * the browser directly would disagree with the rest of the app whenever the
     * two differ.
     *
     * NEVER add 'locale' to exports.inject: older cohorts (0.1.1/0.1.2) have no
     * such service, and a missing injection parks the whole fiber INACTIVE (the
     * same failure the typert inject caused before). Probe it via ctx.get.
     */
    const LOCALE_NS = 'session-trash';
    let hostLocale;
    let hostTranslate;

    function attachHostLocale(ctx) {
      hostLocale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
      if (!hostLocale || typeof hostLocale.register !== 'function' || typeof hostLocale.bind !== 'function') return;
      try {
        const dispose = hostLocale.register(LOCALE_NS, MESSAGES);
        ctx.effect?.(() => dispose, 'session-trash: locale dictionaries');
      } catch {
        // A twin instance may already own the namespace; `bind` still resolves
        // the same dictionaries, so fall through and probe below.
      }
      try {
        const bound = hostLocale.bind(LOCALE_NS);
        // Trust the service only once OUR keys resolve through it — translate()
        // returns the raw key when the namespace carries no dictionary.
        if (bound('recycleBin') !== 'recycleBin') hostTranslate = bound;
      } catch { /* keep the built-in table */ }
    }

    function browserLocale() {
      return window?.navigator?.language || window?.navigator?.languages?.[0] || '';
    }

    /** Active language for the built-in table: host choice first, browser second. */
    function activeLocale() {
      let active;
      try {
        active = hostLocale?.getLocale?.()?.active ?? hostLocale?.getSnapshot?.()?.active;
      } catch { /* service teardown — fall back to the browser */ }
      return /^zh(?:-|$)/i.test(String(active || browserLocale())) ? 'zh' : 'en';
    }

    function t(key, params = {}) {
      if (hostTranslate) {
        try { return hostTranslate(key, params); } catch { /* fall through */ }
      }
      const template = MESSAGES[activeLocale()]?.[key] ?? MESSAGES.en[key] ?? key;
      return String(template).replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? ''));
    }

    function localizedError(error) {
      if (error?.code === 'SESSION_RUNNING') return t('sessionRunning');
      return error?.message || t('unknownError');
    }

    function localizeServerFallback(value) {
      if (value === '未命名会话' || value === 'Unnamed session') return t('unnamedSession');
      if (value === '其他项目' || value === 'Other projects') return t('otherProjects');
      if (value === '其他工作区' || value === 'Other workspaces') return t('otherWorkspaces');
      return value;
    }

    /** Safe icon helper functions (zero-fail direct element creation) */
    function renderTrashIcon(props = {}) {
      const { style, ...rest } = props;
      return h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: props.width || '15',
          height: props.height || '15',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style,
          ...rest,
        },
        h('path', { d: 'M3 6h18' }),
        h('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
        h('path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }),
        h('line', { x1: '10', y1: '11', x2: '10', y2: '17' }),
        h('line', { x1: '14', y1: '11', x2: '14', y2: '17' })
      );
    }

    function renderFolderIcon(props = {}) {
      const { style, ...rest } = props;
      return h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: props.width || '16',
          height: props.height || '16',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style,
          ...rest,
        },
        h('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' })
      );
    }

    function renderEyeIcon(props = {}) {
      const { style, ...rest } = props;
      return h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: props.width || '14',
          height: props.height || '14',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style,
          ...rest,
        },
        h('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
        h('circle', { cx: '12', cy: '12', r: '3' })
      );
    }

    function renderRestoreIcon(props = {}) {
      const { style, ...rest } = props;
      return h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: props.width || '14',
          height: props.height || '14',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style,
          ...rest,
        },
        h('polyline', { points: '1 4 1 10 7 10' }),
        h('path', { d: 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10' })
      );
    }

    function renderDiskIcon(props = {}) {
      const { style, ...rest } = props;
      return h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: props.width || '14',
          height: props.height || '14',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style,
          ...rest,
        },
        h('rect', { x: '3', y: '6', width: '18', height: '12', rx: '3' }),
        h('line', { x1: '3', y1: '12', x2: '21', y2: '12' }),
        h('circle', { cx: '7', cy: '15', r: '1', fill: 'currentColor' }),
        h('circle', { cx: '11', cy: '15', r: '1', fill: 'currentColor' })
      );
    }

    const TrashIcon = (props) => renderTrashIcon(props);

    /**
     * Sub-session glyph for the children badge: one parent path forking into a
     * child, the same metaphor as the delegated sessions the badge counts.
     * Defaults match renderDiskIcon so both badges stay the same size.
     */
    function renderChildrenIcon(props = {}) {
      const { style, ...rest } = props;
      return h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: props.width || '14',
          height: props.height || '14',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style,
          ...rest,
        },
        h('line', { x1: '6', y1: '3', x2: '6', y2: '15' }),
        h('circle', { cx: '18', cy: '6', r: '3' }),
        h('circle', { cx: '6', cy: '18', r: '3' }),
        h('path', { d: 'M18 9a9 9 0 0 1-9 9' })
      );
    }

    /**
     * Inject the plugin stylesheet (external client.css) exactly once.
     * The host serves it at GET /api/session-trash/client.css; all colors
     * are CSS variables that adapt to the OS light/dark color mode.
     */
    function injectStylesheet() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsh-session-recycle-bin-stylesheet')) return;
      const link = document.createElement('link');
      link.id = 'dsh-session-recycle-bin-stylesheet';
      link.rel = 'stylesheet';
      link.href = '/api/session-trash/client.css';
      (document.head ?? document.documentElement).appendChild(link);
    }

    /** Show a top-centre floating toast prompt, matching the host's own. */
    function showToastLayer(message, undoFn, actionText = t('undo'), holdMs = TOAST_HOLD_MS) {
      if (typeof document === 'undefined') return;

      let container = document.getElementById('dsh-session-recycle-bin-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'dsh-session-recycle-bin-toast-container';
        container.className = 'dsh-trash-toast-container';
        document.body.appendChild(container);
      }

      const toastEl = document.createElement('div');
      toastEl.className = 'dsh-trash-toast';

      const textSpan = document.createElement('span');
      textSpan.textContent = message;
      toastEl.appendChild(textSpan);

      if (undoFn) {
        const btn = document.createElement('button');
        btn.textContent = actionText;
        btn.className = 'dsh-trash-toast-undo';
        btn.addEventListener('click', async () => {
          try {
            await undoFn();
          } catch (err) {
            console.error('Toast restore failed:', err);
          }
          toastEl.remove();
        });
        toastEl.appendChild(btn);
      }

      container.appendChild(toastEl);
      // One value drives BOTH the CSS fade delay and this unmount, exactly as
      // the host's Toast does; the entry animation is CSS-only (the previous
      // version drove opacity/transform from JS and timed out at 4000ms).
      toastEl.style.setProperty('--dsh-toast-hold', `${holdMs}ms`);
      setTimeout(() => toastEl.remove(), holdMs + TOAST_FADE_MS);
    }

    /** Formats file size in KB or MB */
    function formatFileSize(bytes) {
      if (!bytes || bytes <= 0) return '0 KB';
      const kb = bytes / 1024;
      if (kb < 1024) return `${kb.toFixed(1)} KB`;
      return `${(kb / 1024).toFixed(1)} MB`;
    }

    /** Formats timestamp into YYYY/M/D HH:mm */
    function formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${year}/${month}/${day} ${hours}:${minutes}`;
    }

    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * Relative age, for the row where an absolute timestamp does not fit.
     *
     * Buckets are calendar-based, not "N hours ago" arithmetic: a 23:30 event
     * read at 00:10 is "yesterday", not "0 hours ago". The absolute timestamp
     * is never lost — the caller keeps it in the row's `title` tooltip.
     */
    function formatRelativeTime(ts) {
      if (!ts) return '';
      const then = new Date(ts);
      const now = new Date();
      const ageMs = now.getTime() - then.getTime();
      if (ageMs < 60 * 1000) return t('childrenJustNow');
      const minutes = Math.floor(ageMs / 60000);
      if (minutes < 60) return t('childrenMinutesAgo', { count: minutes });
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (then.getTime() >= startOfToday) return t('childrenHoursAgo', { count: Math.floor(minutes / 60) });
      if (then.getTime() >= startOfToday - DAY_MS) return t('childrenYesterday');
      if (then.getTime() >= startOfToday - 6 * DAY_MS) return t('childrenThisWeek');
      return t('childrenEarlier');
    }

    /** Make signed API requests. */
    async function api(ctx, path, options = {}) {
      const response = await fetch(path, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          // The host's only contract header: the minimal CSRF custom header the
          // routes require on non-GET requests. No locale header is sent — the
          // host does not read one, and server fallback labels are localized on
          // this side by localizeServerFallback().
          'x-dsh-plugin': 'session-trash',
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        // Only the deferred /children request passes one: closing the settings
        // section must not let a late grouping response land on a dead panel.
        signal: options.signal,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const message = payload?.error?.message || `HTTP ${response.status}`;
        const error = new Error(message);
        error.code = payload?.error?.code;
        throw error;
      }
      return payload.data;
    }

    /**
     * Display form of a log path: the part under the user's home reads `~/…`.
     * The browser has no HOME to compare against, so the two shapes a DSH
     * profile can sit under are matched by prefix and anything else is shown
     * unchanged; the row keeps the FULL path in its `title`.
     */
    function abbreviateHomePath(path) {
      return String(path ?? '')
        .replace(/^(?:\/Users|\/home)\/[^/]+\//, '~/')
        .replace(/^\/root\//, '~/')
        .replace(/^([A-Za-z]:\\Users)\\[^\\]+\\/, '~\\');
    }

    /**
     * Ids /purge could not delete. The frozen route contract reports them as
     * `failed`; builds before it used `errors`, and a plugin may be loaded
     * against either, so read both rather than silently reporting success.
     */
    function purgeFailures(result) {
      const list = result?.failed ?? result?.errors ?? [];
      return Array.isArray(list) ? list : [];
    }

    /**
     * `orphans` arrives as { [missingParentId]: ChildInfo[] } (a deleted main
     * session whose children were kept). Keep the host's key order and drop
     * groups with no children — there is nothing to show for those.
     */
    function orphanGroups(orphans) {
      if (!orphans || typeof orphans !== 'object') return [];
      return Object.keys(orphans)
        .map((parentId) => ({
          parentId,
          children: Array.isArray(orphans[parentId]) ? orphans[parentId] : [],
        }))
        .filter((group) => group.children.length > 0);
    }

    /** 强制浏览器端 sessions / workspaces 服务从服务端重新拉取权威列表 */
    function refreshSessionViews(ctx) {
      try { ctx?.sessions?.refresh?.(); } catch {}
      try {
        const workspaces = ctx?.get?.('workspaces') ?? ctx?.workspaces;
        workspaces?.refresh?.();
      } catch {}
    }

    /** 同步浏览器端会话存储
     *  注意：sessions.list 快照的真实结构是 { items, current, state, phase, error, ... }，
     *  并没有 byId / order 字段；原地改快照也无法触发 zustand 通知（是空操作）。
     *  正确做法是调用 sessions.refresh() + workspaces.refresh() 从服务端重新拉取，
     *  让已物理删除的会话消失、已还原的会话重新出现。 */
    function purgeFromBrowserSessionStore(ctx, sessionIds) {
      if (!sessionIds || sessionIds.length === 0) return;
      refreshSessionViews(ctx);
    }

    /** ── 轻量级 Markdown 渲染器（自包含，不依赖外部库，仅用 React.createElement） ── */

    // 行内解析：code span / bold / italic / strikethrough / link / image
    function parseInline(text, keyPrefix) {
      const nodes = [];
      const parts = String(text).split(/(`[^`]+`)/g);
      parts.forEach((part, i) => {
        if (!part) return;
        const codeMatch = part.match(/^`([^`]+)`$/);
        if (codeMatch) {
          nodes.push(h('code', { key: `${keyPrefix}-c${i}`, className: 'dsh-trash-md-code-inline' }, codeMatch[1]));
          return;
        }
        pushInlineTokens(nodes, part, `${keyPrefix}-${i}`);
      });
      return nodes;
    }

    function pushInlineTokens(nodes, text, keyPrefix) {
      const tokenRe = /(\!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
      let lastIndex = 0;
      let m;
      let k = 0;
      while ((m = tokenRe.exec(text)) !== null) {
        if (m.index > lastIndex) {
          nodes.push(text.slice(lastIndex, m.index));
        }
        const tok = m[0];
        const key = `${keyPrefix}-t${k++}`;
        const imgMatch = tok.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
        if (imgMatch) {
          nodes.push(h('a', { key, href: imgMatch[2], target: '_blank', rel: 'noreferrer' }, imgMatch[1] || imgMatch[2]));
          lastIndex = m.index + tok.length;
          continue;
        }
        const linkMatch = tok.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
        if (linkMatch) {
          nodes.push(h('a', { key, href: linkMatch[2], target: '_blank', rel: 'noreferrer', className: 'dsh-trash-md-link' }, linkMatch[1] || linkMatch[2]));
          lastIndex = m.index + tok.length;
          continue;
        }
        const boldMatch = tok.match(/^\*\*([^*]+)\*\*$/);
        if (boldMatch) {
          nodes.push(h('strong', { key }, parseInline(boldMatch[1], key)));
          lastIndex = m.index + tok.length;
          continue;
        }
        const italicMatch = tok.match(/^\*([^*]+)\*$/);
        if (italicMatch) {
          nodes.push(h('em', { key }, parseInline(italicMatch[1], key)));
          lastIndex = m.index + tok.length;
          continue;
        }
        const strikeMatch = tok.match(/^~~([^~]+)~~$/);
        if (strikeMatch) {
          nodes.push(h('s', { key }, parseInline(strikeMatch[1], key)));
          lastIndex = m.index + tok.length;
          continue;
        }
        lastIndex = m.index + tok.length;
      }
      if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
      }
    }

    // 块级解析 → React 节点数组
    function renderMarkdown(content) {
      const lines = String(content || '').split('\n');
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        // 围栏代码块
        const fenceMatch = line.match(/^```([\w+-]*)\s*$/);
        if (fenceMatch) {
          const lang = fenceMatch[1] || '';
          const buf = [];
          i++;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) {
            buf.push(lines[i]);
            i++;
          }
          i++;
          blocks.push({ type: 'code', lang, code: buf.join('\n') });
          continue;
        }
        // 空行
        if (!line.trim()) {
          i++;
          continue;
        }
        // 分隔线
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push({ type: 'hr' });
          i++;
          continue;
        }
        // 标题
        const headMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headMatch) {
          blocks.push({ type: 'header', level: headMatch[1].length, text: headMatch[2] });
          i++;
          continue;
        }
        // 引用
        if (/^\s*>\s?/.test(line)) {
          const buf = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*>\s?/, ''));
            i++;
          }
          blocks.push({ type: 'quote', text: buf.join('\n') });
          continue;
        }
        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
            i++;
          }
          blocks.push({ type: 'ulist', items });
          continue;
        }
        // 有序列表
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
            i++;
          }
          blocks.push({ type: 'olist', items });
          continue;
        }
        // 表格：当前行含 | 且下一行为分隔行
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
          const headerRow = line;
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
            rows.push(lines[i]);
            i++;
          }
          blocks.push({ type: 'table', header: headerRow, rows });
          continue;
        }
        // 段落：收集连续的非空、非块起始行
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|---+$)/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'para', text: buf.join('\n') });
      }

      return blocks.map((block, idx) => {
        const key = `md-${idx}`;
        switch (block.type) {
          case 'code':
            return h('pre', { key, className: 'dsh-trash-md-codeblock' },
              block.lang ? h('div', { key: `${key}-lang`, className: 'dsh-trash-md-lang' }, block.lang) : null,
              h('code', { key: `${key}-code`, className: 'dsh-trash-md-codeblock-content' }, block.code)
            );
          case 'hr':
            return h('hr', { key, className: 'dsh-trash-md-hr' });
          case 'header': {
            const lvl = Math.min(block.level, 6);
            const tag = `h${lvl}`;
            return h(tag, { key }, parseInline(block.text, key));
          }
          case 'quote':
            return h('blockquote', { key, className: 'dsh-trash-md-quote' }, renderMarkdown(block.text));
          case 'ulist':
            return h('ul', { key, className: 'dsh-trash-md-list' },
              block.items.map((item, j) => h('li', { key: `${key}-${j}`, className: 'dsh-trash-md-list-item' }, parseInline(item, `${key}-${j}`)))
            );
          case 'olist':
            return h('ol', { key, className: 'dsh-trash-md-list' },
              block.items.map((item, j) => h('li', { key: `${key}-${j}`, className: 'dsh-trash-md-list-item' }, parseInline(item, `${key}-${j}`)))
            );
          case 'table': {
            const parseRow = (row) => row.split('|').map((c) => c.trim()).filter((c, j, arr) => !(j === 0 && c === '') && !(j === arr.length - 1 && c === ''));
            const headerCells = parseRow(block.header);
            return h('div', { key, className: 'dsh-trash-md-table-wrap' },
              h('table', { key: `${key}-table`, className: 'dsh-trash-md-table' },
                h('thead', null,
                  h('tr', null, headerCells.map((c, j) => h('th', { key: `${key}-h${j}`, className: 'dsh-trash-md-th' }, parseInline(c, `${key}-h${j}`))))
                ),
                h('tbody', null,
                  block.rows.map((row, r) => h('tr', { key: `${key}-r${r}` },
                    parseRow(row).map((c, j) => h('td', { key: `${key}-c${r}-${j}`, className: 'dsh-trash-md-td' }, parseInline(c, `${key}-c${r}-${j}`)))
                  ))
                )
              )
            );
          }
          default:
            return h('p', { key, className: 'dsh-trash-md-p' }, parseInline(block.text, key));
        }
      });
    }

    /**
     * Resolve a session's display title from the browser store, falling back to
     * the caller's value. MODULE-LEVEL on purpose: the header action and the
     * sidebar row injector are module-level functions and cannot see a helper
     * declared inside the TrashTab component (that produced a synchronous
     * ReferenceError inside the click handler — the "button does nothing" bug).
     */
    function resolveSessionTitle(ctx, sessionId, fallback) {
      try {
        const byId = ctx?.sessions?.list?.getSnapshot?.()?.byId ?? {};
        const title = byId[sessionId]?.title;
        // 如果浏览器 store 中的标题就是 sessionId 本身，说明该会话已被归档、
        // 浏览器 store 中只剩占位符，此时应优先使用服务端返回的 fallback 标题
        // （服务端从 archivedTitles 或日志解析中获取了正确的名称）。
        if (title && title !== sessionId) return title;
        return fallback;
      } catch {
        return fallback;
      }
    }

    /** 当前活动会话 ID：sessions.list 快照的 `current` 字段（0.1.1-rc.2 与 0.1.5-rc.1 均提供）。 */
    function activeSessionId(ctx) {
      try {
        return ctx?.sessions?.list?.getSnapshot?.()?.current ?? undefined;
      } catch {
        return undefined;
      }
    }

    /** TrashTab Component */
    function TrashTab({ ctx }) {
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [searchQuery, setSearchQuery] = useState('');
      const [filterWorkspace, setFilterWorkspace] = useState('');
      const [sortOrder, setSortOrder] = useState('desc');
      const [confirmModal, setConfirmModal] = useState(null);
      const [previewSession, setPreviewSession] = useState(null);
      const [previewMessages, setPreviewMessages] = useState([]);
      const [previewLoading, setPreviewLoading] = useState(false);
      const [activeWorkspaceMenu, setActiveWorkspaceMenu] = useState(null);
      const [selectedSessionIds, setSelectedSessionIds] = useState(new Set());
      const [hoverTooltip, setHoverTooltip] = useState(null);
      const hoverTimerRef = React.useRef(null);
      const tooltipCloseRef = React.useRef(null);
      const tooltipRef = React.useRef(null);

      // ── Hover info card ──────────────────────────────────────────────────
      // The card must be able to dismiss ITSELF: the row's onMouseLeave can
      // never fire again once that row is gone, so deleting the last row used
      // to leave the card floating over an empty panel.
      const cancelTooltipClose = () => {
        if (tooltipCloseRef.current) clearTimeout(tooltipCloseRef.current);
        tooltipCloseRef.current = null;
      };

      const closeTooltip = () => {
        cancelTooltipClose();
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
        setHoverTooltip(null);
      };

      const scheduleTooltipClose = () => {
        cancelTooltipClose();
        tooltipCloseRef.current = setTimeout(() => {
          tooltipCloseRef.current = null;
          // A text selection being dragged past the card edge is not a reason
          // to take the text away; Esc and the other closers still work.
          const selected = typeof window?.getSelection === 'function'
            ? String(window.getSelection() ?? '')
            : '';
          if (selected) return;
          setHoverTooltip(null);
        }, TOOLTIP_CLOSE_DELAY_MS);
      };

      /** Anchor the card to the row it describes — never to the pointer. */
      const openTooltipFor = (item, displayTitle, rect) => {
        setHoverTooltip({
          sessionId: item.sessionId,
          title: displayTitle,
          id: item.sessionId,
          // null when the host found no log (ghost session): the row is then
          // omitted entirely rather than showing an empty value.
          logPath: typeof item.logPath === 'string' && item.logPath ? item.logPath : null,
          anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
          placement: 'above',
          left: rect.left,
          top: rect.top - 8,
        });
      };

      // Every dismissal route that does not depend on the hovered row surviving:
      // Esc, wheel, a click outside the card, a viewport resize, and the card's
      // own mouseleave (delayed so the pointer can travel onto it).
      useEffect(() => {
        if (!hoverTooltip) return undefined;
        const onPointerDown = (e) => {
          const card = tooltipRef.current;
          if (card && typeof card.contains === 'function' && card.contains(e.target)) return;
          closeTooltip();
        };
        const onKeyDown = (e) => { if (e.key === 'Escape') closeTooltip(); };
        const onResize = () => closeTooltip();
        const onScroll = () => closeTooltip();
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', onResize);
        window.addEventListener('wheel', onScroll, { passive: true });
        window.addEventListener('scroll', onScroll, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('resize', onResize);
          window.removeEventListener('wheel', onScroll);
          window.removeEventListener('scroll', onScroll, true);
        };
      }, [hoverTooltip]);

      // A list change can delete the hovered session without a click on it.
      useEffect(() => {
        if (!hoverTooltip) return;
        if (!items.some((item) => item.sessionId === hoverTooltip.sessionId)) closeTooltip();
      }, [items, hoverTooltip]);

      // Measured placement: clamp into the viewport and flip below the row when
      // there is no room above it. Runs on the real box, so a long title cannot
      // push the card off-screen.
      useEffect(() => {
        const el = tooltipRef.current;
        if (!hoverTooltip || !el || typeof el.getBoundingClientRect !== 'function') return;
        const box = el.getBoundingClientRect();
        const viewportWidth = Number(window?.innerWidth) || 0;
        const viewportHeight = Number(window?.innerHeight) || 0;
        const margin = 8;
        let placement = hoverTooltip.placement;
        if (viewportHeight > 0) {
          if (placement === 'above' && hoverTooltip.anchor.top - box.height - margin < 0) placement = 'below';
          else if (placement === 'below' && hoverTooltip.anchor.bottom + box.height + margin > viewportHeight) placement = 'above';
        }
        const wantedLeft = viewportWidth > 0
          ? Math.min(Math.max(hoverTooltip.anchor.left, margin), Math.max(margin, viewportWidth - box.width - margin))
          : hoverTooltip.anchor.left;
        const wantedTop = placement === 'above'
          ? hoverTooltip.anchor.top - margin
          : hoverTooltip.anchor.bottom + margin;
        if (wantedLeft === hoverTooltip.left && wantedTop === hoverTooltip.top && placement === hoverTooltip.placement) return;
        setHoverTooltip((prev) => (prev ? { ...prev, left: wantedLeft, top: wantedTop, placement } : prev));
      }, [hoverTooltip]);

      // ── Sub-sessions (delegated children) ────────────────────────────────
      // `childIndex` is the /children answer: null means "not known" (never
      // fetched, failed, or degraded) — and an unknown count renders NO badge
      // rather than a wrong one. `uncheckedChildren` holds only the opt-OUT
      // ids, so a freshly grouped child is checked by default.
      const [childIndex, setChildIndex] = useState(null);
      const [childEpoch, setChildEpoch] = useState(0);
      const [expandedCards, setExpandedCards] = useState(() => new Set());
      const [uncheckedChildren, setUncheckedChildren] = useState(() => ({}));
      const [fullChildLists, setFullChildLists] = useState(() => new Set());
      const childRequestRef = React.useRef({ signature: null, promise: null, controller: null, retried: null });

      const toggleSelectSession = (sessionId) => {
        setSelectedSessionIds((prev) => {
          const next = new Set(prev);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        });
      };

      // 点击外部自动隐藏工作区 ... 更多菜单 (捕获阶段 pointerdown)
      useEffect(() => {
        const handleClickOutside = (e) => {
          if (e?.target?.closest && e.target.closest('.dsh-more-menu-container')) {
            return;
          }
          setActiveWorkspaceMenu(null);
        };
        document.addEventListener('pointerdown', handleClickOutside, true);
        return () => document.removeEventListener('pointerdown', handleClickOutside, true);
      }, []);

      const currentTitle = (sessionId, fallback) => resolveSessionTitle(ctx, sessionId, fallback);

      const loadItems = useCallback(async () => {
        setError(null);
        try {
          const value = await api(ctx, `${API_PREFIX}/list`);
          setItems(value?.items ?? []);
          // A fresh /list snapshot is the only thing that can add or remove a
          // card, so it is also what re-asks for the sub-session grouping.
          setChildEpoch((epoch) => epoch + 1);
        } catch (err) {
          setError(err.message || t('loadFailed'));
        } finally {
          setLoading(false);
        }
      }, [ctx]);

      /**
       * Ask the host for the sub-session grouping that backfills the badges.
       *
       * Deferred on purpose: the panel paints the /list snapshot first, so the
       * first screen stays zero-I/O and this grouping only backfills numbers.
       * Dedupe is by id signature while a request is in flight, and aborting
       * supersedes the previous request instead of racing it.
       *
       * The body carries NO sessionIds. The host narrows a report it had to
       * build by scanning the whole lineage anyway, so omitting the list costs
       * the same — and it is the only way the orphans of an already-deleted
       * main session are reported: a parent id that is not requested is never
       * returned (tests/session-trash-children.test.js, "an unrequested parent
       * id is not reported"), and a kept child's parent is by definition not in
       * the trash list. Cards match against `data.groups` below.
       */
      const loadChildGroups = useCallback((signature) => {
        const state = childRequestRef.current;
        if (state.signature === signature && state.promise) return state.promise;
        state.controller?.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const run = (async () => {
          try {
            const data = await api(ctx, `${API_PREFIX}/children`, {
              method: 'POST',
              body: {},
              signal: controller?.signal,
            });
            if (controller?.signal?.aborted) return;
            // degraded ⇒ the host could not answer authoritatively. Surfacing
            // nothing is the only honest option: a badge is a count claim.
            if (!data || data.degraded === true) {
              setChildIndex(null);
              return;
            }
            setChildIndex({ groups: data.groups ?? {}, orphans: orphanGroups(data.orphans) });
          } catch (err) {
            // Failure is silent and terminal for this signature: one attempt
            // per /list refresh, so a broken route cannot become a retry storm.
            if (controller?.signal?.aborted) return;
            setChildIndex(null);
          }
        })();
        state.signature = signature;
        state.promise = run;
        state.controller = controller;
        run.finally(() => {
          if (state.promise === run) state.promise = null;
        });
        return run;
      }, [ctx]);

      const childIds = React.useMemo(
        () => items.map((item) => item.sessionId).filter(Boolean),
        [items]
      );
      const childSignature = childIds.join('|');

      useEffect(() => {
        if (loading || childIds.length === 0) return undefined;
        loadChildGroups(childSignature);
        // Closing the settings section (or reloading the list) cancels the
        // grouping request the closed panel can no longer use.
        return () => {
          const state = childRequestRef.current;
          state.controller?.abort();
          state.controller = null;
          state.promise = null;
          state.signature = null;
        };
      }, [loading, childSignature, childEpoch, loadChildGroups]);

      useEffect(() => {
        loadItems();
        const offEvent = ctx?.on?.('workspace/archived-sessions-changed', () => loadItems());
        const offRpc = ctx?.get?.('typert')?.on?.('host/archived-sessions-changed', () => loadItems());
        const offPurge = ctx?.on?.('workspace/session-permanently-deleted', ({ sessionId }) => {
          if (sessionId) purgeFromBrowserSessionStore(ctx, [sessionId]);
          loadItems();
        });
        return () => {
          offEvent?.();
          offRpc?.();
          offPurge?.();
        };
      }, [loadItems, ctx]);

      /** 恢复单个会话 */
      const handleUnarchive = async (session) => {
        try {
          await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId: session.sessionId } });
          loadItems();

          // 触发 Harness 官方 sessions / workspaces 服务重新拉取活跃列表
          // （fetch/load/reload 并不存在，正确方法是 refresh()）
          refreshSessionViews(ctx);

          showToastLayer(t('restored', { title: currentTitle(session.sessionId, session.title) || session.title || session.sessionId }), async () => {
            try {
              await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId: session.sessionId } });
              loadItems();
              try { refreshSessionViews(ctx); } catch {}
            } catch (e) {
              console.error(t('undoFailed'), e);
            }
          });
        } catch (err) {
          showToastLayer(t('restoreFailed', { message: localizedError(err) }));
        }
      };

      /** 物理彻底删除单个会话 */
      const handlePurgeSingle = async (sessionId, sessionTitle) => {
        setConfirmModal({
          title: t('confirmPermanentTitle'),
          body: t('confirmPermanentBody', { title: sessionTitle }),
          onConfirm: async () => {
            try {
              const result = await api(ctx, `${API_PREFIX}/purge`, { method: 'POST', body: { sessionIds: [sessionId] } });
              const failures = purgeFailures(result);
              const failedIds = new Set(failures.map((e) => e.sessionId));
              if (failedIds.has(sessionId)) {
                const errItem = failures.find((e) => e.sessionId === sessionId);
                showToastLayer(t('deleteFailed', { message: localizedError(errItem) }));
              } else {
                purgeFromBrowserSessionStore(ctx, [sessionId]);
                showToastLayer(t('deleted'));
              }
              setConfirmModal(null);
              closeTooltip();
              loadItems();
            } catch (err) {
              showToastLayer(t('deleteFailed', { message: localizedError(err) }));
            }
          },
        });
      };

      /** 物理彻底删除指定工作区下的所有/选中的归档会话 */
      const handlePurgeWorkspace = async (workspacePath, workspaceTitle, groupItems) => {
        setConfirmModal({
          title: t('deleteArchivedTitle'),
          body: t('deleteWorkspaceBody', { title: workspaceTitle, count: groupItems.length }),
          onConfirm: async () => {
            try {
              const ids = groupItems.map((i) => i.sessionId);
              const result = await api(ctx, `${API_PREFIX}/purge-workspace`, { method: 'POST', body: { workspacePath, sessionIds: ids } });
              const failedIds = new Set(purgeFailures(result).map((e) => e.sessionId));
              const succeededIds = ids.filter((id) => !failedIds.has(id));
              purgeFromBrowserSessionStore(ctx, succeededIds);
              setConfirmModal(null);
              setActiveWorkspaceMenu(null);
              loadItems();
              showToastLayer(t('deletedSelected'));
            } catch (err) {
              showToastLayer(t('deleteFailed', { message: localizedError(err) }));
            }
          },
        });
      };

      /** 彻底删除全部归档会话 */
      const handleEmptyAll = () => {
        setConfirmModal({
          title: t('deleteAllTitle'),
          body: t('deleteAllBody', { count: items.length }),
          onConfirm: async () => {
            try {
              const ids = items.map((i) => i.sessionId);
              await api(ctx, `${API_PREFIX}/empty`, { method: 'POST' });
              purgeFromBrowserSessionStore(ctx, ids);
              setConfirmModal(null);
              loadItems();
              showToastLayer(t('emptied', { count: items.length }));
            } catch (err) {
              showToastLayer(t('emptyFailed', { message: localizedError(err) }));
            }
          },
        });
      };

      /** 打开预览 Modal */
      const handleOpenPreview = async (session) => {
        const title = currentTitle(session.sessionId, session.title) || session.sessionId;
        setPreviewSession({ ...session, title });
        setPreviewLoading(true);
        setPreviewMessages([]);
        try {
          const res = await api(ctx, `${API_PREFIX}/messages?sessionId=${encodeURIComponent(session.sessionId)}`);
          setPreviewMessages(res?.messages ?? []);
        } catch (err) {
          showToastLayer(t('historyFailed', { message: localizedError(err) }));
        } finally {
          setPreviewLoading(false);
        }
      };

      /** Sub-session rows grouped for one card ('orphan:<id>' keys the kept shells). */
      const childrenOf = (cardKey) => (childIndex ? (childIndex.groups[cardKey] ?? []) : null);

      const orphanCards = childIndex?.orphans ?? [];

      /** Opt-out set for one card: a child is checked unless the user cleared it. */
      const uncheckedOf = (cardKey) => uncheckedChildren[cardKey];

      const toggleChild = (cardKey, childId) => {
        setUncheckedChildren((prev) => {
          const current = new Set(prev[cardKey]);
          if (current.has(childId)) current.delete(childId);
          else current.add(childId);
          return { ...prev, [cardKey]: current };
        });
      };

      const forgetCardSelection = (cardKey) => {
        setUncheckedChildren((prev) => {
          if (!(cardKey in prev)) return prev;
          const next = { ...prev };
          delete next[cardKey];
          return next;
        });
      };

      const toggleCardChildren = (cardKey) => {
        setExpandedCards((prev) => {
          const next = new Set(prev);
          if (next.has(cardKey)) next.delete(cardKey);
          else next.add(cardKey);
          return next;
        });
        // Fallback retry, once per id signature: a card whose grouping never
        // arrived is the only reason to ask again, and one extra attempt is
        // what keeps a broken route from becoming a retry storm.
        const state = childRequestRef.current;
        if (childIndex || state.retried === childSignature) return;
        state.retried = childSignature;
        loadChildGroups(childSignature);
      };

      const liveChildren = (children) => children.filter((child) => child.live);

      /** Deletable (checked, not running) child ids of one card. */
      const checkedChildIds = (cardKey, children) => {
        const off = uncheckedOf(cardKey);
        return children.filter((child) => !child.live && !off?.has(child.id)).map((child) => child.id);
      };

      /**
       * Permanent delete of a card AND its checked sub-sessions.
       *
       * `parentIds` are the ROW ids to purge and the un-checked children travel
       * as `excludeIds`: the host deletes each row plus all of its descendants
       * minus `excludeIds`, so listing the children again would only make the
       * two lists disagree. `parentCount` is what the dialog may call a main
       * session (0 for a kept-children shell, whose rows ARE children).
       */
      const handlePurgeCard = (cardKey, parentIds, parentCount, parentSize, children) => {
        if (parentIds.length === 0) {
          // /purge rejects an empty sessionIds[] after the fact; say so before.
          showToastLayer(t('childrenNoneSelected'));
          return;
        }
        const running = liveChildren(children);
        if (running.length > 0) {
          // Refused here, before the request: the host refuses too, but only the
          // panel can name WHICH sub-session is still running.
          showToastLayer(t('childrenRunningBlocked', {
            titles: running.map((child) => child.title || child.id).join(t('listSeparator')),
          }));
          return;
        }
        const doomed = children.filter((child) => !uncheckedOf(cardKey)?.has(child.id));
        const kept = children.filter((child) => uncheckedOf(cardKey)?.has(child.id));
        const size = (parentSize || 0) + doomed.reduce((sum, child) => sum + (child.fileSize || 0), 0);
        setConfirmModal({
          title: t('cascadeDeleteTitle'),
          body: t('cascadeDeleteBody', {
            parents: parentCount,
            children: doomed.length,
            size: formatFileSize(size),
          }),
          // A long cascade must not stretch the dialog past the viewport.
          items: doomed.length > CASCADE_DIALOG_LIST_LIMIT ? doomed : null,
          onConfirm: async () => {
            try {
              const result = await api(ctx, `${API_PREFIX}/purge`, {
                method: 'POST',
                body: { sessionIds: parentIds, excludeIds: kept.map((child) => child.id) },
              });
              const failures = purgeFailures(result);
              if (failures.length > 0) {
                showToastLayer(t('deleteFailed', { message: localizedError(failures[0]) }));
              } else {
                purgeFromBrowserSessionStore(ctx, parentIds);
                showToastLayer(t('deleted'));
              }
              setConfirmModal(null);
              // The hovered row is about to be unmounted, so its mouseleave can
              // no longer close the card: do it here.
              closeTooltip();
              forgetCardSelection(cardKey);
              setExpandedCards((prev) => {
                const next = new Set(prev);
                next.delete(cardKey);
                return next;
              });
              loadItems();
            } catch (err) {
              showToastLayer(t('deleteFailed', { message: localizedError(err) }));
            }
          },
        });
      };

      const childDisplayTitle = (child) => child.title || child.id;

      /**
       * "size · time" — each half dropped when the host reported null. A
       * sub-session with no cached projection has no size to report, and
       * printing 0 KB there would be a guess (same rule as the turn count).
       */
      const childMetaText = (child) => [
        typeof child.fileSize === 'number' ? formatFileSize(child.fileSize) : null,
        child.createdAt ? formatRelativeTime(child.createdAt) : null,
      ].filter(Boolean).join(' · ');

      /** The absolute timestamp the relative label replaced, kept in a tooltip. */
      const childTimeTitle = (child) => (child.createdAt ? formatTime(child.createdAt) : '');

      /**
       * The full "size · timestamp" for the row's own tooltip: the narrow panel
       * hides the meta line, and the data must not disappear with it.
       */
      const childMetaTitle = (child) => [
        typeof child.fileSize === 'number' ? formatFileSize(child.fileSize) : null,
        childTimeTitle(child) || null,
      ].filter(Boolean).join(' · ');

      /**
       * Compact sub-session row: checkbox, title, running pill, size · age, and
       * a 24px delete icon.
       *
       * The TITLE is the preview affordance (a real button, so it is reachable
       * by Tab and Enter) instead of a standing "view" pill: the row's width
       * budget at a 320px settings column cannot pay for a second text button,
       * and a hover-only control would be unusable by keyboard and touch.
       * Delete is an always-visible icon button for the same touch reason.
       */
      const renderChildRow = (cardKey, child) => h('div', {
        key: child.id,
        className: child.live ? 'dsh-trash-child dsh-trash-child--live' : 'dsh-trash-child',
        title: childMetaTitle(child),
      },
        h('input', {
          type: 'checkbox',
          className: 'dsh-trash-checkbox dsh-trash-child-check',
          checked: !child.live && !uncheckedOf(cardKey)?.has(child.id),
          disabled: child.live,
          'aria-label': childDisplayTitle(child),
          title: child.live ? t('childrenRunningHint') : childDisplayTitle(child),
          onChange: (e) => {
            e.stopPropagation();
            toggleChild(cardKey, child.id);
          },
        }),
        h('button', {
          type: 'button',
          className: 'dsh-trash-child-title',
          title: childDisplayTitle(child),
          // The accessible name carries size and age as well: the narrow panel
          // hides the meta LINE (display:none removes it from the a11y tree)
          // and a tooltip is not readable by keyboard or screen reader. Keeping
          // it here at EVERY width means one announcement path, not two.
          'aria-label': [t('previewTitle', { title: childDisplayTitle(child) }), childMetaText(child)]
            .filter(Boolean).join(' · '),
          onClick: (e) => {
            e.stopPropagation();
            handleOpenPreview({ sessionId: child.id, title: childDisplayTitle(child) });
          },
        }, childDisplayTitle(child)),
        child.live
          ? h('span', { className: 'dsh-trash-child-live', title: t('childrenRunningHint') }, t('childrenRunning'))
          : null,
        // Visual only: the same size/age is in the title button's name above,
        // so a screen reader must not hear it twice.
        h('span', {
          className: 'dsh-trash-child-meta',
          'aria-hidden': 'true',
          title: childTimeTitle(child),
        }, childMetaText(child)),
        // No restore for a sub-session: it never entered the recycle bin, so
        // there is nothing to put back — only the permanent delete.
        h('button', {
          type: 'button',
          className: 'dsh-trash-child-delete',
          'aria-label': t('permanentlyDelete'),
          title: t('permanentlyDelete'),
          disabled: child.live,
          onClick: (e) => {
            e.stopPropagation();
            if (child.live) return;
            handlePurgeSingle(child.id, childDisplayTitle(child));
          },
        }, renderTrashIcon({ className: 'dsh-trash-child-delete-icon' }))
      );

      /**
       * Full-width inline list under a card. `children === null` means the
       * grouping has not arrived (or was dropped): two skeleton rows hold the
       * exact height instead of the card jumping when the rows land.
       */
      const renderChildRegion = (cardKey, children) => {
        const regionId = `dsh-trash-children-${cardKey}`;
        if (children === null) {
          return h('div', { key: `${cardKey}:children`, id: regionId, className: 'dsh-trash-children', role: 'group' },
            h('div', { key: 'skeleton-1', className: 'dsh-trash-child dsh-trash-child--skeleton' }),
            h('div', { key: 'skeleton-2', className: 'dsh-trash-child dsh-trash-child--skeleton' })
          );
        }
        const showAll = fullChildLists.has(cardKey);
        const shown = showAll ? children : children.slice(0, CHILD_ROW_LIMIT);
        return h('div', { key: `${cardKey}:children`, id: regionId, className: 'dsh-trash-children', role: 'group' },
          shown.length === 0
            ? h('div', { key: 'empty', className: 'dsh-trash-children-empty' }, t('childrenEmpty'))
            : shown.map((child) => renderChildRow(cardKey, child)),
          children.length > shown.length
            ? h('button', {
                key: 'more',
                type: 'button',
                className: 'dsh-trash-children-more',
                onClick: (e) => {
                  e.stopPropagation();
                  setFullChildLists((prev) => new Set(prev).add(cardKey));
                },
              }, t('childrenMore', { count: children.length - shown.length }))
            : null
        );
      };

      /**
       * The badge IS the disclosure control: a button carrying
       * aria-expanded/aria-controls, so Enter and Space work for free and Esc
       * collapses. Rendered only when the count is known AND non-zero — an
       * unknown or empty count renders nothing at all, as before this feature.
       */
      const renderChildBadge = (cardKey, count) => {
        if (!count) return null;
        const expanded = expandedCards.has(cardKey);
        return h('button', {
          type: 'button',
          className: 'dsh-trash-badge dsh-trash-badge--children',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-controls': `dsh-trash-children-${cardKey}`,
          'aria-label': t('childrenBadgeLabel', { count }),
          title: t('childrenCount', { count }),
          onClick: (e) => {
            e.stopPropagation();
            toggleCardChildren(cardKey);
          },
          onKeyDown: (e) => {
            if (e.key !== 'Escape' || !expanded) return;
            e.stopPropagation();
            toggleCardChildren(cardKey);
          },
        },
          renderChildrenIcon({ className: 'dsh-trash-icon-badge' }),
          h('span', { className: 'dsh-trash-badge-num' }, String(count))
        );
      };

      // 提取工作区下拉列表
      const workspaceOptions = React.useMemo(() => {
        const map = new Map();
        for (const item of items) {
          const key = item.workspacePath || item.cwd || t('other');
          const title = localizeServerFallback(item.workspaceTitle) || (item.cwd ? item.cwd.split('/').pop() : t('otherProjects'));
          if (!map.has(key)) map.set(key, { path: key, title });
        }
        return [...map.values()];
      }, [items]);

      // 过滤、排序并按工作区分组
      const groupedWorkspaces = React.useMemo(() => {
        let list = [...items];

        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          list = list.filter((i) => {
            const title = (currentTitle(i.sessionId, i.title) || i.sessionId).toLowerCase();
            return title.includes(q);
          });
        }

        if (filterWorkspace) {
          list = list.filter((i) => (i.workspacePath || i.cwd) === filterWorkspace);
        }

        // 按工作区分组（保持服务端返回的工作区顺序，与左侧 sidebar 一致）
        const groups = new Map();
        const groupOrder = [];
        for (const item of list) {
          const key = item.workspacePath || item.cwd || t('otherWorkspaces');
          const title = localizeServerFallback(item.workspaceTitle) || (item.cwd ? item.cwd.split('/').pop() : t('unnamedProject'));
          if (!groups.has(key)) {
            groups.set(key, { path: key, title, items: [] });
            groupOrder.push(key);
          }
          groups.get(key).items.push(item);
        }

        // 每个工作区内部按时间排序，不影响工作区之间的顺序
        for (const group of groups.values()) {
          group.items.sort((a, b) => {
            const timeA = a.archivedAt || 0;
            const timeB = b.archivedAt || 0;
            return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
          });
        }

        return groupOrder.map((key) => groups.get(key)).filter(Boolean);
      }, [items, searchQuery, filterWorkspace, sortOrder, ctx]);

      return h('div', { className: 'dsh-trash-container' },
        // Header
        h('div', { className: 'dsh-trash-header' },
          h('div', { className: 'dsh-trash-header-left' },
            h('h2', { className: 'dsh-trash-title' },
              renderTrashIcon({ className: 'dsh-trash-icon-title' }),
              t('recycleBin')
            ),
            h('p', { className: 'dsh-trash-subtitle' }, t('archivedCount', { count: items.length }))
          )
        ),

        // Top Bar: 搜索框
        h('div', { className: 'dsh-trash-search' },
          h('svg', { className: 'dsh-trash-search-icon', width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' },
            h('circle', { cx: '11', cy: '11', r: '8' }),
            h('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })
          ),
          h('input', {
            type: 'text',
            className: 'dsh-trash-search-input',
            placeholder: t('searchPlaceholder'),
            value: searchQuery,
            onChange: (e) => setSearchQuery(e.target.value),
          })
        ),

        // Filter Controls Toolbar
        h('div', { className: 'dsh-trash-toolbar' },
          h('select', {
            className: 'dsh-trash-select',
            value: filterWorkspace,
            onChange: (e) => setFilterWorkspace(e.target.value),
          },
            h('option', { value: '' }, t('allProjects')),
            workspaceOptions.map((w) => h('option', { key: w.path, value: w.path }, w.title))
          ),

          h('select', {
            className: 'dsh-trash-select',
            value: sortOrder,
            onChange: (e) => setSortOrder(e.target.value),
          },
            h('option', { value: 'desc' }, t('newestFirst')),
            h('option', { value: 'asc' }, t('oldestFirst'))
          ),

          items.length > 0 &&
            h('button', {
              className: 'dsh-trash-btn-danger-outline',
              onClick: handleEmptyAll,
            },
              renderTrashIcon({ className: 'dsh-trash-icon-btn' }),
              t('deleteAll')
            )
        ),

        // List Content
        loading
          ? h('div', { className: 'dsh-trash-state' }, t('loading'))
          : error
          ? h('div', { className: 'dsh-trash-state dsh-trash-state--error' }, error)
          : items.length === 0
          ? h('div', { className: 'dsh-trash-state' }, t('empty'))
          : groupedWorkspaces.length === 0
          ? h('div', { className: 'dsh-trash-state' }, t('noMatches'))
          : h('div', { className: 'dsh-trash-groups' },
              groupedWorkspaces.map((group) => {
                const groupSelectedIds = group.items.map((i) => i.sessionId).filter((id) => selectedSessionIds.has(id));
                const hasSelected = groupSelectedIds.length > 0;

                return h('div', { key: group.path, className: 'dsh-trash-group' },
                  // Workspace Section Header
                  h('div', { className: 'dsh-trash-group-header' },
                    h('div', { className: 'dsh-trash-group-title-group' },
                      renderFolderIcon({ className: 'dsh-trash-icon-folder' }),
                      h('span', { className: 'dsh-trash-group-title' }, group.title),
                      h('span', { className: 'dsh-trash-group-path', title: group.path }, group.path)
                    ),
                    h('div', { className: 'dsh-trash-group-right' },
                      h('span', { className: 'dsh-trash-group-count' }, t('sessionCount', { count: group.items.length })),
                      h('div', { className: 'dsh-more-menu-container dsh-trash-more-wrap' },
                        h('button', {
                          type: 'button',
                          className: 'dsh-trash-more-btn',
                          title: t('projectActions'),
                          onClick: (e) => {
                            e.stopPropagation();
                            setActiveWorkspaceMenu(activeWorkspaceMenu === group.path ? null : group.path);
                          },
                        }, '•••'),
                        activeWorkspaceMenu === group.path &&
                          h('div', { className: 'dsh-trash-menu' },
                            h('button', {
                              className: 'dsh-trash-menu-item--danger',
                              onClick: (e) => {
                                e.stopPropagation();
                                const targets = hasSelected
                                  ? group.items.filter((i) => selectedSessionIds.has(i.sessionId))
                                  : group.items;
                                handlePurgeWorkspace(group.path, hasSelected ? t('selectedSuffix', { title: group.title, count: groupSelectedIds.length }) : group.title, targets);
                              },
                            },
                              renderTrashIcon({ className: 'dsh-trash-icon-menu' }),
                              hasSelected ? t('deleteSelected', { count: groupSelectedIds.length }) : t('deleteProject')
                            )
                          )
                      )
                    )
                  ),

                  // Session Cards List
                  h('div', { className: 'dsh-trash-cards' },
                    group.items.map((item) => {
                      const displayTitle = currentTitle(item.sessionId, localizeServerFallback(item.title)) || item.sessionId;
                      const isChecked = selectedSessionIds.has(item.sessionId);
                      const children = childrenOf(item.sessionId);
                      const childCount = children ? children.length : 0;
                      const childrenExpanded = expandedCards.has(item.sessionId);

                      // The inline list is a SIBLING of the row, not a child of
                      // it: it must span the whole card width, and a click
                      // inside it must not be a click on the card.
                      return [
                        h('div', {
                          key: item.sessionId,
                          className: isChecked ? 'dsh-trash-card dsh-trash-card--checked' : 'dsh-trash-card',
                        },
                        // 微圆复选框：只选这一行本身，不通配它的子会话（子行的
                        // 勾选是另一件事——级联删除的范围），所以两者必须能一眼分辨。
                        h('input', {
                          type: 'checkbox',
                          className: 'dsh-trash-checkbox dsh-trash-checkbox--card',
                          checked: isChecked,
                          'aria-label': t('selectSessionOnly'),
                          title: t('selectSessionOnly'),
                          onChange: (e) => {
                            e.stopPropagation();
                            toggleSelectSession(item.sessionId);
                          },
                        }),

                        h('div', { className: 'dsh-trash-card-main' },
                          // Title: the ONLY hover target that opens the info
                          // card. The row itself must stay inert — hovering the
                          // action buttons has to leave their own native
                          // tooltips alone, and the meta row / badges / checkbox
                          // are not what the card describes. The card anchors to
                          // THIS box.
                          h('div', {
                            className: 'dsh-trash-card-title',
                            onMouseEnter: (e) => {
                              cancelTooltipClose();
                              if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                              const rect = e.currentTarget.getBoundingClientRect();
                              hoverTimerRef.current = setTimeout(() => {
                                hoverTimerRef.current = null;
                                openTooltipFor(item, displayTitle, rect);
                              }, TOOLTIP_OPEN_DELAY_MS);
                            },
                            // Delayed, not immediate: the pointer has to be
                            // able to cross the gap onto the card itself.
                            onMouseLeave: scheduleTooltipClose,
                          }, displayTitle),
                          // Metadata Row (时间, 轮数, 容量 Badge, 子会话 Badge)
                          h('div', { className: 'dsh-trash-card-meta' },
                            h('span', { className: 'dsh-trash-card-meta-item dsh-trash-card-meta-item--time' }, formatTime(item.archivedAt)),
                            // 轮数只有在投影缓存能给出「当前代际」记录时才显示。
                            // 为 null 表示未知（例如会话的检查点停留在升级前的
                            // 格式代际），此时宁可不显示，也不能谎报 0 轮。
                            typeof item.turnCount === 'number'
                              ? h('span', { className: 'dsh-trash-card-meta-item dsh-trash-card-meta-item--turns' }, t('turnCount', { count: item.turnCount }))
                              : null,
                            h('span', { className: 'dsh-trash-badge' },
                              renderDiskIcon({ className: 'dsh-trash-icon-badge' }),
                              formatFileSize(item.fileSize)
                            ),
                            renderChildBadge(item.sessionId, childCount)
                          )
                        ),

                        // Action Buttons (微型极简胶囊按钮，大幅留出左侧空间)。
                        // 文案包一层 span：窄容器里只隐藏文字、保留图标，因此每颗
                        // 按钮都必须自带 aria-label/title，收起后仍有可访问名称。
                        h('div', { className: 'dsh-trash-card-actions' },
                          h('button', {
                            type: 'button',
                            className: 'dsh-trash-btn-ghost',
                            'aria-label': t('view'),
                            title: t('view'),
                            onClick: () => handleOpenPreview(item),
                          },
                            renderEyeIcon({ className: 'dsh-trash-icon-sm' }),
                            h('span', { className: 'dsh-trash-btn-label' }, t('view'))
                          ),
                          h('button', {
                            type: 'button',
                            className: 'dsh-trash-btn-ghost',
                            'aria-label': t('restore'),
                            title: t('restore'),
                            onClick: () => handleUnarchive(item),
                          },
                            renderRestoreIcon({ className: 'dsh-trash-icon-sm' }),
                            h('span', { className: 'dsh-trash-btn-label' }, t('restore'))
                          ),
                          h('button', {
                            type: 'button',
                            className: 'dsh-trash-btn-danger-text',
                            'aria-label': t('permanentlyDelete'),
                            title: t('permanentlyDelete'),
                            onClick: () => (
                              childCount > 0
                                ? handlePurgeCard(item.sessionId, [item.sessionId], 1, item.fileSize, children)
                                : handlePurgeSingle(item.sessionId, displayTitle)
                            ),
                          },
                            renderTrashIcon({ className: 'dsh-trash-icon-sm' }),
                            h('span', { className: 'dsh-trash-btn-label' }, t('permanentlyDelete'))
                          )
                        )
                        ),
                        childrenExpanded ? renderChildRegion(item.sessionId, children) : null,
                      ];
                    })
                  )
                );
              })
            ),

        // Kept sub-sessions of an already-deleted main session. They never
        // entered the recycle bin, so there is nothing to restore — only to
        // view and to delete. The next /children answer drops the shell once
        // its last child is gone.
        orphanCards.length > 0 && h('div', { className: 'dsh-trash-cards' },
          orphanCards.map((group) => {
            const cardKey = `orphan:${group.parentId}`;
            const expanded = expandedCards.has(cardKey);
            return [
              h('div', { key: cardKey, className: 'dsh-trash-card dsh-trash-card--orphan' },
                h('div', { className: 'dsh-trash-card-main' },
                  h('div', { className: 'dsh-trash-card-title' }, t('orphanCardTitle', { count: group.children.length })),
                  // No timestamp and no size of its own: the MAIN session is
                  // gone, so anything shown here would be the children's data
                  // wearing the parent's label.
                  h('div', { className: 'dsh-trash-card-meta' },
                    h('span', { className: 'dsh-trash-tag-kept' }, t('orphanKept')),
                    renderChildBadge(cardKey, group.children.length)
                  )
                ),
                h('div', { className: 'dsh-trash-card-actions' },
                  // "View" is the first kept child: the parent that used to own
                  // this row no longer exists to preview.
                  h('button', {
                    type: 'button',
                    className: 'dsh-trash-btn-ghost',
                    'aria-label': t('view'),
                    title: t('view'),
                    onClick: () => handleOpenPreview({
                      sessionId: group.children[0].id,
                      title: childDisplayTitle(group.children[0]),
                    }),
                  },
                    renderEyeIcon({ className: 'dsh-trash-icon-sm' }),
                    h('span', { className: 'dsh-trash-btn-label' }, t('view'))
                  ),
                  // Batch delete of the checked kept children: the deleted
                  // parent cannot cascade for them, so they are the row ids.
                  h('button', {
                    type: 'button',
                    className: 'dsh-trash-btn-danger-text',
                    'aria-label': t('permanentlyDelete'),
                    title: t('permanentlyDelete'),
                    onClick: () => handlePurgeCard(
                      cardKey,
                      checkedChildIds(cardKey, group.children),
                      0,
                      group.children.reduce((sum, child) => sum + (child.fileSize || 0), 0),
                      group.children
                    ),
                  },
                    renderTrashIcon({ className: 'dsh-trash-icon-sm' }),
                    h('span', { className: 'dsh-trash-btn-label' }, t('permanentlyDelete'))
                  )
                )
              ),
              expanded ? renderChildRegion(cardKey, group.children) : null,
            ];
          })
        ),

        // Footer Summary
        items.length > 0 && h('div', { className: 'dsh-trash-footer' }, t('archivedCount', { count: items.length })),

        // Modal 1: 查看内容 Message Preview Modal
        previewSession &&
          h('div', { className: 'dsh-trash-overlay', onClick: () => setPreviewSession(null) },
            h('div', { className: 'dsh-trash-preview', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'dsh-trash-preview-header' },
                h('div', { className: 'dsh-trash-preview-title' }, t('previewTitle', { title: previewSession.title })),
                h('button', {
                  className: 'dsh-trash-close',
                  onClick: () => setPreviewSession(null),
                }, '✕')
              ),
              h('div', { className: 'dsh-trash-preview-body' },
                previewLoading
                  ? h('div', { className: 'dsh-trash-preview-state' }, t('loadingHistory'))
                  : previewMessages.length === 0
                  ? h('div', { className: 'dsh-trash-preview-state' }, t('noHistory'))
                  : previewMessages.map((msg, index) =>
                      h('div', { key: index, className: 'dsh-trash-message' },
                        h('div', { className: 'dsh-trash-message-header' },
                          h('span', { className: 'dsh-trash-message-role' }, msg.role === 'user' ? t('user') : t('assistant')),
                          msg.timestamp && h('span', { className: 'dsh-trash-message-time' }, formatTime(msg.timestamp))
                        ),
                        h('div', { className: msg.role === 'user' ? 'dsh-trash-bubble-user' : 'dsh-trash-bubble-assistant' },
                          h('div', { className: 'dsh-trash-md' }, renderMarkdown(msg.content))
                        )
                      )
                    )
              )
            )
          ),

        // Modal 2: 确认操作 Modal
        confirmModal &&
          h('div', { className: 'dsh-trash-overlay', onClick: () => setConfirmModal(null) },
            h('div', { className: 'dsh-trash-modal', onClick: (e) => e.stopPropagation() },
              h('h3', { className: 'dsh-trash-modal-title' }, confirmModal.title),
              h('p', { className: 'dsh-trash-modal-body' }, confirmModal.body),
              // A long cascade names what it will erase; past the limit the list
              // scrolls inside the dialog instead of growing it.
              confirmModal.items &&
                h('div', { className: 'dsh-trash-modal-list' },
                  confirmModal.items.map((child) => h('div', {
                    key: child.id,
                    className: 'dsh-trash-modal-list-item',
                    title: childDisplayTitle(child),
                  }, childDisplayTitle(child)))
                ),
              h('div', { className: 'dsh-trash-modal-actions' },
                h('button', { className: 'dsh-trash-btn-cancel', onClick: () => setConfirmModal(null) }, t('cancel')),
                h('button', { className: 'dsh-trash-btn-confirm', onClick: confirmModal.onConfirm }, t('confirmDelete'))
              )
            )
          ),

        // Hover info card: full title, id, and the session's log path on disk.
        // Anchored to the TITLE (left/top computed in JS), not to the pointer,
        // so it can be read, selected and clicked.
        hoverTooltip &&
          h('div', {
            ref: tooltipRef,
            className: `dsh-trash-tooltip dsh-trash-tooltip--${hoverTooltip.placement}`,
            style: { left: `${hoverTooltip.left}px`, top: `${hoverTooltip.top}px` },
            onMouseEnter: cancelTooltipClose,
            onMouseLeave: scheduleTooltipClose,
          },
            h('div', { className: 'dsh-trash-tooltip-title' }, hoverTooltip.title),
            h('div', { className: 'dsh-trash-tooltip-sub' }, `ID: ${hoverTooltip.id}`),
            // No log on disk -> no row at all (never an empty or "not found"
            // placeholder). The project path is already in the group header
            // above the card, so it is not repeated here.
            hoverTooltip.logPath
              ? h('div', {
                  className: 'dsh-trash-tooltip-sub',
                  title: hoverTooltip.logPath,
                }, t('storagePath', { path: abbreviateHomePath(hoverTooltip.logPath) }))
              : null
          )
      );
    }

    /** Header Action component for active session header */
    function DeleteSessionAction(props) {
      const ctx = props.ctx;
      const session = props.session || props.activeSession;
      // 会话 ID 来源（按代际依次回退）：插槽 props（<=0.1.2 提供 sessionId/session）→
      // sessions.list 快照的 current（0.1.5-rc.1 的插槽不再传 sessionId，但快照带 current）。
      const sessionId =
        props.sessionId ||
        props.id ||
        session?.id ||
        session?.sessionId ||
        activeSessionId(ctx) ||
        ctx?.sessions?.active?.getSnapshot()?.session?.id ||
        ctx?.sessions?.currentId;

      // Tooltip state for this icon-only action. React clears `currentTarget`
      // once a handler returns, so the rect is read synchronously and only the
      // state update is delayed.
      const [tipAt, setTipAt] = useState(null);
      const tipTimer = React.useRef(null);
      const showTooltip = (event) => {
        if (tipTimer.current) clearTimeout(tipTimer.current);
        const rect = event.currentTarget.getBoundingClientRect();
        const at = { x: rect.right, y: rect.bottom + 6 };
        tipTimer.current = setTimeout(() => setTipAt(at), TOOLTIP_DELAY_MS);
      };
      // Keyboard focus gets it immediately — a delayed bubble is useless to
      // someone tabbing through the header.
      const showTooltipNow = (event) => {
        if (tipTimer.current) clearTimeout(tipTimer.current);
        const rect = event.currentTarget.getBoundingClientRect();
        setTipAt({ x: rect.right, y: rect.bottom + 6 });
      };
      const hideTooltip = () => {
        if (tipTimer.current) clearTimeout(tipTimer.current);
        setTipAt(null);
      };
      useEffect(() => () => {
        if (tipTimer.current) clearTimeout(tipTimer.current);
      }, []);

      const handleArchive = async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (!sessionId) {
          showToastLayer(t('noActiveSession'));
          return;
        }
        const title = (session?.title || resolveSessionTitle(ctx, sessionId, '')) ?? '';
        try {
          await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId, title } });
          purgeFromBrowserSessionStore(ctx, [sessionId]);
          showToastLayer(t('movedToBin', { title: title || t('currentSession') }), async () => {
            try {
              await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId } });
            } catch (e) {
              console.error(t('undoFailed'), e);
            }
          });
        } catch (err) {
          showToastLayer(t('moveFailed', { message: localizedError(err) }));
        }
      };

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-trash-header-action',
            // No native `title`: the themed bubble below replaces it. An
            // OS-drawn tooltip cannot follow the palette or the reduced-motion
            // setting, and sitting beside the host's own themed tooltips it
            // read as an unstyled plugin. aria-label keeps the accessible name.
            'aria-label': t('moveToBin'),
            onMouseEnter: showTooltip,
            onMouseLeave: hideTooltip,
            onFocus: showTooltipNow,
            onBlur: hideTooltip,
            onClick: handleArchive,
          },
          renderTrashIcon({ width: 14, height: 14 })
        ),
        tipAt &&
          h(
            'div',
            {
              className: 'dsh-trash-tooltip-host',
              style: { left: `${tipAt.x}px`, top: `${tipAt.y}px` },
            },
            t('moveToBin')
          )
      );
    }


    /** Inject Trash Icon into settings sidebar */
    function injectSettingsMenuIcon() {
      if (typeof document === 'undefined') return;
      const candidates = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && el.textContent?.trim() === t('recycleBin')
      );
      for (const textEl of candidates) {
        const itemContainer =
          textEl.closest('button') ||
          textEl.closest('a') ||
          textEl.closest('[role="tab"]') ||
          textEl.closest('[role="button"]') ||
          textEl.closest('li') ||
          textEl.parentElement;
        if (!itemContainer) continue;

        const svg = itemContainer.querySelector('svg');
        if (svg) {
          if (!svg.dataset.dshTrashIconInjected) {
            svg.dataset.dshTrashIconInjected = 'true';
            const temp = document.createElement('div');
            temp.innerHTML =
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
              'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
              '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
              '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
            const newSvg = temp.firstElementChild;
            if (newSvg) {
              newSvg.dataset.dshTrashIconInjected = 'true';
              if (svg.getAttribute('class')) newSvg.setAttribute('class', svg.getAttribute('class'));
              svg.parentNode?.replaceChild(newSvg, svg);
            }
          }
        }
      }
    }

    /**
     * Keep the Settings → "会话回收站" nav item's icon in sync.
     *
     * v0.4.4 removed the sidebar row injection that used to share this
     * observer: DSH now ships its own archive hover button on every session
     * row (`sidebar.workspaces.session.row.action`), so a second, differently
     * worded trash affordance next to it did the same job under a different
     * verb. That also retired the dominant cost of this observer — the
     * per-mutation scan of every session row, with its title-index and
     * position-disambiguation passes — leaving only this idempotent icon swap.
     */
    function startSettingsIconSync() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      let raf = 0;
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          try {
            injectSettingsMenuIcon();
          } catch (error) {
            console.error('session-trash: settings icon inject failed', error);
          }
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement ?? document, { childList: true, subtree: true });
      schedule();
      return () => {
        observer.disconnect();
        if (raf) cancelAnimationFrame(raf);
      };
    }

    /** Plugin body apply */
    function apply(ctx) {
      injectStylesheet();
      // Adopt the host Language setting (and publish our dictionaries) before
      // anything renders a label.
      attachHostLocale(ctx);

      // DSH 0.1.5 的 settings.section 注册契约只接受 id / order / label
      // （见 dsh-cordis-client-runner 内置的 slot 目录：registerOptions 就这三项，
      //  label 的类型是 `string | (() => string)`）。设置面板按 order 升序把注册项
      //  排成一列，所以这里只传契约内字段；label 仍用 thunk，两代际都合法。
      //
      // order 必须落在「一定可见」的区间：0.1.5 的设置面板把导航列高度固定为约
      // 808px（17 项 × 44px），而面板 overflow:hidden、导航列 overflow:visible 且
      // 没有滚动条 —— 窗口可视高度放不下整个面板时，**列表末尾的条目会被直接裁掉，
      // 既看不见也滚不到**。原先取 200（倒数第二项），窗口稍矮（面板 < 808px，
      // 约等于视口 < 800px）就整项消失，这正是「设置里没有会话回收站」的真正原因。
      // 25 落在 20（mnemon「Memory System」）与 30（cost-meter「Cost」）之间，
      // 属于最上面几项，任何能看见设置导航的窗口都能看见它。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'trash',
            order: 25,
            label: () => t('recycleBin'),
          },
          (props) => TrashTab({ ...props, ctx })
        )
      );

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'delete-session',
            order: 400,
            // The label must name what the click does. The action archives to
            // the recycle bin (reversible, undoable via the toast) — it does
            // not delete anything — so it says "移入回收站", the same verb as
            // the panel and as the button's own title. It used to read
            // "删除会话" while the button tooltip said "移入回收站": one button,
            // two names, and a trash icon promising a permanence it did not
            // have.
            label: () => t('moveToBin'),
          },
          (props) => DeleteSessionAction({ ...props, ctx })
        )
      );

      ctx.effect(() => startSettingsIconSync());
    }

    exports.apply = apply;
    exports.inject = ['slots', 'connection', 'sessions', 'workspaces'];

    return module.exports;
  },
});
