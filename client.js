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

    /** Show a bottom-left floating toast prompt. */
    function showToastLayer(message, undoFn, actionText = '撤销') {
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
      requestAnimationFrame(() => {
        toastEl.style.opacity = '1';
        toastEl.style.transform = 'translateY(0)';
      });

      setTimeout(() => {
        toastEl.style.opacity = '0';
        toastEl.style.transform = 'translateY(10px)';
        setTimeout(() => toastEl.remove(), 200);
      }, 4000);
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

    /** Make signed API requests. */
    async function api(ctx, path, options = {}) {
      const response = await fetch(path, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-dsh-plugin': 'session-trash',
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const message = payload?.error?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload.data;
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

      const currentTitle = (sessionId, fallback) => {
        try {
          const byId = ctx?.sessions?.list?.getSnapshot()?.byId ?? {};
          const title = byId[sessionId]?.title;
          // 如果浏览器 store 中的标题就是 sessionId 本身，说明该会话已被归档、
          // 浏览器 store 中只剩占位符，此时应优先使用服务端返回的 fallback 标题
          // （服务端从 archivedTitles 或日志解析中获取了正确的名称）。
          if (title && title !== sessionId) return title;
          return fallback;
        } catch {
          return fallback;
        }
      };

      const loadItems = useCallback(async () => {
        setError(null);
        try {
          const value = await api(ctx, `${API_PREFIX}/list`);
          setItems(value?.items ?? []);
        } catch (err) {
          setError(err.message || '加载回收站列表失败');
        } finally {
          setLoading(false);
        }
      }, [ctx]);

      useEffect(() => {
        loadItems();
        const offEvent = ctx?.on?.('workspace/archived-sessions-changed', () => loadItems());
        const offRpc = ctx?.typert?.on?.('host/archived-sessions-changed', () => loadItems());
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

          showToastLayer(`已恢复会话「${currentTitle(session.sessionId, session.title) || session.title || session.sessionId}」`, async () => {
            try {
              await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId: session.sessionId } });
              loadItems();
              try { refreshSessionViews(ctx); } catch {}
            } catch (e) {
              console.error('撤销失败', e);
            }
          });
        } catch (err) {
          showToastLayer(`恢复失败: ${err.message}`);
        }
      };

      /** 物理彻底删除单个会话 */
      const handlePurgeSingle = async (sessionId, sessionTitle) => {
        setConfirmModal({
          title: '确认彻底删除',
          body: `确定要永久删除会话「${sessionTitle}」吗？此操作不可撤销，历史对话记录将被完全清除。`,
          onConfirm: async () => {
            try {
              const result = await api(ctx, `${API_PREFIX}/purge`, { method: 'POST', body: { sessionIds: [sessionId] } });
              const failedIds = new Set((result?.errors ?? []).map((e) => e.sessionId));
              if (failedIds.has(sessionId)) {
                const errItem = result.errors.find((e) => e.sessionId === sessionId);
                showToastLayer(`删除失败: ${errItem?.message || '未知错误'}`);
              } else {
                purgeFromBrowserSessionStore(ctx, [sessionId]);
                showToastLayer(`已彻底删除会话`);
              }
              setConfirmModal(null);
              loadItems();
            } catch (err) {
              showToastLayer(`删除失败: ${err.message}`);
            }
          },
        });
      };

      /** 物理彻底删除指定工作区下的所有/选中的归档会话 */
      const handlePurgeWorkspace = async (workspacePath, workspaceTitle, groupItems) => {
        setConfirmModal({
          title: '彻底删除归档会话',
          body: `确定要永久删除工作区「${workspaceTitle}」下的 ${groupItems.length} 个会话吗？此操作不可撤销。`,
          onConfirm: async () => {
            try {
              const ids = groupItems.map((i) => i.sessionId);
              const result = await api(ctx, `${API_PREFIX}/purge-workspace`, { method: 'POST', body: { workspacePath, sessionIds: ids } });
              const failedIds = new Set((result?.errors ?? []).map((e) => e.sessionId));
              const succeededIds = ids.filter((id) => !failedIds.has(id));
              purgeFromBrowserSessionStore(ctx, succeededIds);
              setConfirmModal(null);
              setActiveWorkspaceMenu(null);
              loadItems();
              showToastLayer(`已彻底删除所选归档会话`);
            } catch (err) {
              showToastLayer(`删除失败: ${err.message}`);
            }
          },
        });
      };

      /** 彻底删除全部归档会话 */
      const handleEmptyAll = () => {
        setConfirmModal({
          title: '全部删除归档会话',
          body: `确定要永久删除全部 ${items.length} 个归档会话吗？此操作不可撤销。`,
          onConfirm: async () => {
            try {
              const ids = items.map((i) => i.sessionId);
              await api(ctx, `${API_PREFIX}/empty`, { method: 'POST' });
              purgeFromBrowserSessionStore(ctx, ids);
              setConfirmModal(null);
              loadItems();
              showToastLayer(`已清空回收站中全部 ${items.length} 个会话`);
            } catch (err) {
              showToastLayer(`清空失败: ${err.message}`);
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
          showToastLayer(`获取会话记录失败: ${err.message}`);
        } finally {
          setPreviewLoading(false);
        }
      };

      // 提取工作区下拉列表
      const workspaceOptions = React.useMemo(() => {
        const map = new Map();
        for (const item of items) {
          const key = item.workspacePath || item.cwd || '其他';
          const title = item.workspaceTitle || (item.cwd ? item.cwd.split('/').pop() : '其他项目');
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
          const key = item.workspacePath || item.cwd || '其他工作区';
          const title = item.workspaceTitle || (item.cwd ? item.cwd.split('/').pop() : '未命名项目');
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
              '会话回收站'
            ),
            h('p', { className: 'dsh-trash-subtitle' }, `共 ${items.length} 个已归档会话`)
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
            placeholder: '搜索已归档聊天...',
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
            h('option', { value: '' }, '所有项目'),
            workspaceOptions.map((w) => h('option', { key: w.path, value: w.path }, w.title))
          ),

          h('select', {
            className: 'dsh-trash-select',
            value: sortOrder,
            onChange: (e) => setSortOrder(e.target.value),
          },
            h('option', { value: 'desc' }, '最近删除 (降序)'),
            h('option', { value: 'asc' }, '最早删除 (正序)')
          ),

          items.length > 0 &&
            h('button', {
              className: 'dsh-trash-btn-danger-outline',
              onClick: handleEmptyAll,
            },
              renderTrashIcon({ className: 'dsh-trash-icon-btn' }),
              '全部删除'
            )
        ),

        // List Content
        loading
          ? h('div', { className: 'dsh-trash-state' }, '加载已归档会话...')
          : error
          ? h('div', { className: 'dsh-trash-state dsh-trash-state--error' }, error)
          : items.length === 0
          ? h('div', { className: 'dsh-trash-state' }, '回收站暂无会话')
          : groupedWorkspaces.length === 0
          ? h('div', { className: 'dsh-trash-state' }, '未找到匹配的归档会话')
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
                      h('span', { className: 'dsh-trash-group-count' }, `${group.items.length} 个聊天`),
                      h('div', { className: 'dsh-more-menu-container dsh-trash-more-wrap' },
                        h('button', {
                          type: 'button',
                          className: 'dsh-trash-more-btn',
                          title: '项目操作',
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
                                handlePurgeWorkspace(group.path, hasSelected ? `${group.title} (选中的 ${groupSelectedIds.length} 项)` : group.title, targets);
                              },
                            },
                              renderTrashIcon({ className: 'dsh-trash-icon-menu' }),
                              hasSelected ? `彻底删除选中 (${groupSelectedIds.length})` : '彻底删除项目全部'
                            )
                          )
                      )
                    )
                  ),

                  // Session Cards List
                  h('div', { className: 'dsh-trash-cards' },
                    group.items.map((item) => {
                      const displayTitle = currentTitle(item.sessionId, item.title) || item.sessionId;
                      const path = item.cwd || item.workspacePath || '-';
                      const isChecked = selectedSessionIds.has(item.sessionId);

                      return h('div', {
                        key: item.sessionId,
                        className: isChecked ? 'dsh-trash-card dsh-trash-card--checked' : 'dsh-trash-card',
                        onMouseEnter: (e) => {
                          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                          const rect = e.currentTarget.getBoundingClientRect();
                          hoverTimerRef.current = setTimeout(() => {
                            setHoverTooltip({
                              title: displayTitle,
                              id: item.sessionId,
                              path: path,
                              x: rect.left,
                              y: rect.top - 8,
                            });
                          }, 200);
                        },
                        onMouseLeave: () => {
                          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                          setHoverTooltip(null);
                        },
                      },
                        // 微圆复选框
                        h('input', {
                          type: 'checkbox',
                          className: 'dsh-trash-checkbox',
                          checked: isChecked,
                          onChange: (e) => {
                            e.stopPropagation();
                            toggleSelectSession(item.sessionId);
                          },
                        }),

                        h('div', { className: 'dsh-trash-card-main' },
                          // Title
                          h('div', { className: 'dsh-trash-card-title' }, displayTitle),
                          // Metadata Row (时间, 轮数, 容量 Badge)
                          h('div', { className: 'dsh-trash-card-meta' },
                            h('span', { className: 'dsh-trash-card-meta-item' }, formatTime(item.archivedAt)),
                            h('span', { className: 'dsh-trash-card-meta-item' }, `${item.turnCount ?? 0} 轮对话`),
                            h('span', { className: 'dsh-trash-badge' },
                              renderDiskIcon({ className: 'dsh-trash-icon-badge' }),
                              formatFileSize(item.fileSize)
                            )
                          )
                        ),

                        // Action Buttons (微型极简胶囊按钮，大幅留出左侧空间)
                        h('div', { className: 'dsh-trash-card-actions' },
                          h('button', {
                            type: 'button',
                            className: 'dsh-trash-btn-ghost',
                            onClick: () => handleOpenPreview(item),
                          },
                            renderEyeIcon({ className: 'dsh-trash-icon-sm' }),
                            '查看'
                          ),
                          h('button', {
                            type: 'button',
                            className: 'dsh-trash-btn-ghost',
                            onClick: () => handleUnarchive(item),
                          },
                            renderRestoreIcon({ className: 'dsh-trash-icon-sm' }),
                            '还原'
                          ),
                          h('button', {
                            type: 'button',
                            className: 'dsh-trash-btn-danger-text',
                            onClick: () => handlePurgeSingle(item.sessionId, displayTitle),
                          },
                            renderTrashIcon({ className: 'dsh-trash-icon-sm' }),
                            '彻底删除'
                          )
                        )
                      );
                    })
                  )
                );
              })
            ),

        // Footer Summary
        items.length > 0 && h('div', { className: 'dsh-trash-footer' }, `共 ${items.length} 个归档会话`),

        // Modal 1: 查看内容 Message Preview Modal
        previewSession &&
          h('div', { className: 'dsh-trash-overlay', onClick: () => setPreviewSession(null) },
            h('div', { className: 'dsh-trash-preview', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'dsh-trash-preview-header' },
                h('div', { className: 'dsh-trash-preview-title' }, `查看会话：${previewSession.title}`),
                h('button', {
                  className: 'dsh-trash-close',
                  onClick: () => setPreviewSession(null),
                }, '✕')
              ),
              h('div', { className: 'dsh-trash-preview-body' },
                previewLoading
                  ? h('div', { className: 'dsh-trash-preview-state' }, '正在读取历史对话记录...')
                  : previewMessages.length === 0
                  ? h('div', { className: 'dsh-trash-preview-state' }, '暂无对话记录')
                  : previewMessages.map((msg, index) =>
                      h('div', { key: index, className: 'dsh-trash-message' },
                        h('div', { className: 'dsh-trash-message-header' },
                          h('span', { className: 'dsh-trash-message-role' }, msg.role === 'user' ? '👤 用户' : '🤖 助手'),
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
              h('div', { className: 'dsh-trash-modal-actions' },
                h('button', { className: 'dsh-trash-btn-cancel', onClick: () => setConfirmModal(null) }, '取消'),
                h('button', { className: 'dsh-trash-btn-confirm', onClick: confirmModal.onConfirm }, '确定删除')
              )
            )
          ),

        // Tooltip: 悬停展示全标题 & ID & 路径（left/top 由 JS 按鼠标位置内联给出）
        hoverTooltip &&
          h('div', {
            className: 'dsh-trash-tooltip',
            style: { left: `${hoverTooltip.x}px`, top: `${hoverTooltip.y}px` },
          },
            h('div', { className: 'dsh-trash-tooltip-title' }, hoverTooltip.title),
            h('div', { className: 'dsh-trash-tooltip-sub' }, `ID: ${hoverTooltip.id}`),
            h('div', { className: 'dsh-trash-tooltip-sub' }, `路径: ${hoverTooltip.path}`)
          )
      );
    }

    /** Header Action component for active session header */
    function DeleteSessionAction(props) {
      const ctx = props.ctx;
      const session = props.session || props.activeSession;
      const sessionId =
        props.sessionId ||
        props.id ||
        session?.id ||
        session?.sessionId ||
        ctx?.sessions?.active?.getSnapshot()?.session?.id ||
        ctx?.sessions?.currentId;

      const handleArchive = async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (!sessionId) {
          showToastLayer('无法识别当前活动会话 ID');
          return;
        }
        const title = (session?.title || currentTitle(sessionId, '')) ?? '';
        try {
          await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId, title } });
          purgeFromBrowserSessionStore(ctx, [sessionId]);
          showToastLayer(`已将会话「${title || '当前会话'}」移入回收站`, async () => {
            try {
              await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId } });
            } catch (e) {
              console.error('撤销失败', e);
            }
          });
        } catch (err) {
          showToastLayer(`移入回收站失败: ${err.message}`);
        }
      };

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-trash-header-action',
          title: '移入回收站',
          onClick: handleArchive,
        },
        renderTrashIcon({ width: 14, height: 14 })
      );
    }

    const SESSION_ARIA_ZH = /^会话“(.+?)”的操作$/;
    const SESSION_ARIA_EN = /^Session actions for (.+)$/;

    function sessionTitleFromLabel(label) {
      const zh = SESSION_ARIA_ZH.exec(label ?? '');
      if (zh) return zh[1];
      const en = SESSION_ARIA_EN.exec(label ?? '');
      if (en) return en[1];
      return undefined;
    }

    function buildTitleIndex(ctx) {
      const byId = ctx?.sessions?.list?.getSnapshot()?.byId ?? {};
      const index = new Map();
      for (const [id, record] of Object.entries(byId)) {
        const title = record?.title;
        if (!title) continue;
        const list = index.get(title) ?? [];
        list.push(id);
        index.set(title, list);
      }
      return index;
    }


    /** 解析相对时间标签为"新→旧"的数值等级（越小越新）；解析失败返回 null */
    function timeAgeRank(label) {
      const s = String(label || '').trim();
      if (s === 'now' || s === '刚刚') return 0;
      let m = s.match(/^(\d+)\s*(min|h|d)$/);
      if (m) return { min: 1, h: 60, d: 1440 }[m[2]] * Number(m[1]);
      m = s.match(/^(\d+)\s*(分钟|小时|天)$/);
      if (m) return { 分钟: 1, 小时: 60, 天: 1440 }[m[2]] * Number(m[1]);
      return null;
    }

    /** 提取一行的时间标签文本（class 是哈希值，用文本模式识别） */
    function timeLabelOf(row) {
      for (const child of row.children) {
        const text = String(child?.textContent ?? '').trim();
        if (/^(刚刚|now|\d+\s*(min|h|d|分钟|小时|天))$/.test(text)) return text;
      }
      return '';
    }

    /** 收集同一列表作用域（组/平铺列表）内按 DOM 顺序排列的所有会话行 */
    function siblingSessionRows(row) {
      const scope = row.parentElement?.parentElement ?? row.parentElement ?? row;
      try {
        return [...scope.querySelectorAll('div[role="treeitem"]:not([aria-expanded])')];
      } catch {
        return [];
      }
    }

    /** 把按钮/占位按钮插到行内标题前（与标题同排，保证所有行占位一致） */
    function insertButtonIntoRow(row, el, title) {
      let anchor = null;
      if (title) {
        anchor = [...row.children].find((child) => child.textContent === title || child.textContent?.includes(title));
      }
      if (!anchor) {
        // 标题为空（空白会话行）：标题 span 是最后一个元素子节点（children: [slot, title]），
        // 插到它前面 → [slot, button, title]，与正常行位置一致，避免被 React 重渲染移除。
        const elements = [...row.children].filter((c) => c.nodeType === 1);
        anchor = elements[elements.length - 1] ?? null;
      }
      if (anchor) {
        row.insertBefore(el, anchor);
      } else if (row.firstElementChild) {
        row.insertBefore(el, row.firstElementChild);
      } else {
        row.prepend(el);
      }
    }

    /** 无法解析会话 ID 时插入等宽隐形占位按钮：行布局与其它行保持一致，不再"往左靠" */
    function injectSpacerButton(row, title) {
      const spacer = document.createElement('button');
      spacer.type = 'button';
      spacer.className = 'dsh-trash-row-btn dsh-trash-row-btn--spacer';
      spacer.setAttribute('aria-hidden', 'true');
      spacer.tabIndex = -1;
      row.dataset.dshTrashSpacer = 'true';
      insertButtonIntoRow(row, spacer, title);
    }

    /** Inject per-row delete icon into left sidebar session tree */
    function injectRowDelete(ctx) {
      if (typeof document === 'undefined') return;
      const snapshot = ctx?.sessions?.list?.getSnapshot?.() ?? {};
      const byId = snapshot.byId ?? {};
      const titleIndex = buildTitleIndex(ctx);
      // 归档集合：sessions 列表快照未携带，但 workspaces 快照携带（同步可用）。
      const archived = new Set(
        (ctx?.workspaces?.list?.getSnapshot?.()?.archivedSessionIds) ||
        ctx?.get?.('workspaces')?.list?.getSnapshot?.()?.archivedSessionIds ||
        []
      );
      const rows = document.querySelectorAll('[role="treeitem"], [data-session-id], [data-tree-node-id], a[href*="/session/"], .dsh-session-item');

      for (const row of rows) {
        // 先移除旧的占位按钮：允许后续解析成功时升级为真实删除按钮
        row.querySelectorAll('.dsh-trash-row-btn--spacer').forEach((el) => el.remove());
        delete row.dataset.dshTrashSpacer;

        // 自愈：标记已设置但按钮丢失（例如��� React 重渲染移除）时，清除标记重新注入
        if (row.dataset.dshTrashInjected === 'true' && !row.querySelector('[data-dsh-session-recycle-bin-delete]')) {
          delete row.dataset.dshTrashInjected;
          row.classList.remove('dsh-trash-row');
        }

        if (row.querySelector('[data-dsh-session-recycle-bin-delete]') || row.dataset.dshTrashInjected === 'true') continue;

        let sessionId = row.dataset.sessionId || row.dataset.treeNodeId;
        let title = '';

        const actionBtn = [...row.querySelectorAll('button')].find((b) => {
          const l = b.getAttribute('aria-label') ?? '';
          return SESSION_ARIA_ZH.test(l) || SESSION_ARIA_EN.test(l);
        });

        if (actionBtn) {
          title = sessionTitleFromLabel(actionBtn.getAttribute('aria-label')) || '';
          if (title && titleIndex.has(title)) {
            // 只考虑"可见"候选：排除已归档、空白、子代理会话
            const liveIds = (titleIndex.get(title) || []).filter((id) => {
              const rec = byId[id];
              if (!rec) return false;
              if (rec.blank || rec.origin === 'subagent') return false;
              if (archived.has(id)) return false;
              return true;
            });
            if (liveIds.length === 1) {
              sessionId = liveIds[0];
            } else if (liveIds.length > 1) {
              const currentId = snapshot.current;
              // ① 选中行消歧：当前选中的行就是 current 会话（唯一确定事实）
              if (row.getAttribute('aria-selected') === 'true' && currentId && liveIds.includes(currentId)) {
                sessionId = currentId;
              } else {
                // ② 位置消歧（仅当列表按更新时间排序时可安全使用）：
                //    同名行按 DOM 顺序取号，候选按 byRecency（updatedAt 降序、id 升序）排序对应。
                //    用同名行的相对时间标签校验顺序单调（新→旧），不一致则放弃（安全回退占位）。
                const sameTitled = siblingSessionRows(row).filter((r) => {
                  const b = [...r.querySelectorAll('button')].find((btn) => {
                    const l = btn.getAttribute('aria-label') ?? '';
                    return SESSION_ARIA_ZH.test(l) || SESSION_ARIA_EN.test(l);
                  });
                  return b && sessionTitleFromLabel(b.getAttribute('aria-label')) === title;
                });
                const index = sameTitled.indexOf(row);
                let orderValid = index !== -1;
                if (orderValid) {
                  let prev = -1;
                  for (const r of sameTitled) {
                    const rank = timeAgeRank(timeLabelOf(r));
                    if (rank === null || rank < prev) { orderValid = false; break; }
                    prev = rank;
                  }
                }
                if (orderValid) {
                  const ordered = [...liveIds].sort((a, b) => {
                    const ua = byId[a]?.updatedAt ?? 0;
                    const ub = byId[b]?.updatedAt ?? 0;
                    if (ub !== ua) return ub - ua;
                    return a < b ? -1 : 1;
                  });
                  if (index >= 0 && index < ordered.length) sessionId = ordered[index];
                }
              }
            }
          }
        }

        if (!sessionId && row.getAttribute('href')) {
          const m = row.getAttribute('href').match(/\/session\/([^\/]+)/);
          if (m) sessionId = m[1];
        }

        // 空白新建会话兜底：DSH 只渲染"当前"的空白会话行且带 aria-selected=true，
        // 因此选中的空白行即可安全确定为 current 空白会话。
        if (!sessionId && !actionBtn && row.tagName === 'DIV' && !row.hasAttribute('aria-expanded')
            && row.getAttribute('aria-selected') === 'true') {
          const currentId = snapshot.current;
          if (currentId && snapshot.byId?.[currentId]?.blank === true) {
            sessionId = currentId;
          }
        }

        if (!sessionId) {
          // 无法解析 ID 的会话行（如同名且未选中且无法安全消歧的行、个别过渡状态）：
          // 插入等宽隐形占位按钮保持行对齐；只处理"会话形态"的行，
          // 不触碰工作区行（含 aria-expanded）与搜索结果行（button 元素）。
          const sessionLike = actionBtn || (row.tagName === 'DIV' && !row.hasAttribute('aria-expanded'));
          if (sessionLike) injectSpacerButton(row, title);
          continue;
        }
        row.dataset.dshTrashInjected = 'true';
        row.classList.add('dsh-trash-row');

        if (!title && sessionId) {
          title = currentTitle(sessionId, '');
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dsh-trash-row-btn';
        button.dataset.dshSessionRecycleBinDelete = sessionId;
        button.title = '移入回收站';
        button.setAttribute('aria-label', '移入回收站');
        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
          '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
          '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

        button.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId, title } });
            purgeFromBrowserSessionStore(ctx, [sessionId]);
            showToastLayer(`已将会话「${title || '会话'}」移入回收站`, async () => {
              await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId } });
            });
          } catch (err) {
            showToastLayer(`移入回收站失败: ${err.message}`);
          }
        });

        // 挂载到左侧空白处（标题前面或左侧 Icon 旁边）
        insertButtonIntoRow(row, button, title);
      }
    }

    /** Inject Trash Icon into settings sidebar */
    function injectSettingsMenuIcon() {
      if (typeof document === 'undefined') return;
      const candidates = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && el.textContent?.trim() === '会话回收站'
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

    /** Watch sidebar tree mutations */
    function startSidebarRowDelete(ctx) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      let raf = 0;
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          try {
            injectRowDelete(ctx);
            injectSettingsMenuIcon();
          } catch (error) {
            console.error('session-trash: sidebar row inject failed', error);
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

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'trash',
            order: 200,
            label: () => '会话回收站',
            icon: renderTrashIcon({ width: 16, height: 16 }),
            iconName: 'trash',
            Icon: TrashIcon,
            renderIcon: () => renderTrashIcon(),
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
            label: () => '删除会话',
          },
          (props) => DeleteSessionAction({ ...props, ctx })
        )
      );

      ctx.effect(() => startSidebarRowDelete(ctx));
    }

    exports.apply = apply;
    exports.inject = ['slots', 'connection', 'typert', 'sessions', 'workspaces'];

    return module.exports;
  },
});
