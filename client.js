/**
 * Browser half of the session-trash bundle.
 *
 * Hand-written `__ModuleLoader__` package shell (same shape as the built
 * in-box client bundles; zero build step). The module table the shell
 * kernel constructs serves this file at /plugins/<pkg>/client.js; the
 * kernel then adopts it as a Cordis plugin entry and calls `apply(ctx)`.
 *
 * Registers:
 *   1. 「会话回收站」settings section (`settings.section`) — a two-tab
 *      manager: 回收站 (multi-select restore / permanent-delete / empty)
 *      and 全部会话 (multi-select delete→trash / permanent-delete).
 *   2. 「删除会话」session header action
 *      (`conversation.session.header.actions`) — move the active session
 *      into the recycle bin.
 *
 * All data flows over the plugin's OWN HTTP routes on the host webserver
 * (/api/session-trash/*, the `x-dsh-plugin` header is the CSRF seam):
 *   GET  /api/session-trash/list       archived sessions
 *   GET  /api/session-trash/sessions   every session (+workspace, archived)
 *   POST /api/session-trash/archive    { sessionId }  → trash
 *   POST /api/session-trash/unarchive  { sessionId }  → restore
 *   POST /api/session-trash/purge      { sessionIds } → permanent delete
 *   POST /api/session-trash/empty                       → purge all archived
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

    /** Standard trash can icon, 14px, inherits `currentColor`. */
    const TRASH_ICON_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      '<rect x="5" y="6" width="14" height="15" rx="1.5"/>' +
      '<line x1="10" y1="10" x2="10" y2="17"/><line x1="14" y1="10" x2="14" y2="17"/></svg>';

    /** Standard restore/undo icon, 14px, inherits `currentColor`. */
    const RESTORE_ICON_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

    /** React Trash icon component for settings menu slot and headers. */
    const TrashIcon = (props) =>
      h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: '16',
          height: '16',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          ...props,
        },
        h('path', { d: 'M3 6h18' }),
        h('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
        h('rect', { x: '5', y: '6', width: '14', height: '15', rx: '1.5' }),
        h('line', { x1: '10', y1: '10', x2: '10', y2: '17' }),
        h('line', { x1: '14', y1: '10', x2: '14', y2: '17' })
      );

    /**
     * Show a bottom-left floating layer notification (toast prompt).
     * @param {string} message - Message text.
     * @param {Function} [undoFn] - Optional callback when clicking '还原'.
     */
    function showToastLayer(message, undoFn, actionText = '撤销') {
      if (typeof document === 'undefined') return;

      let container = document.getElementById('dsh-session-recycle-bin-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'dsh-session-recycle-bin-toast-container';
        Object.assign(container.style, {
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: '10000',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          pointerEvents: 'none',
        });
        document.body.appendChild(container);
      }

      const toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        backgroundColor: '#2d3748',
        color: '#ffffff',
        padding: '10px 18px',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        fontSize: '13px',
        pointerEvents: 'auto',
        transition: 'all 0.2s ease',
        opacity: '0',
        transform: 'translateY(10px)',
      });

      const textSpan = document.createElement('span');
      textSpan.textContent = message;
      toastEl.appendChild(textSpan);

      if (undoFn) {
        const btn = document.createElement('button');
        btn.textContent = actionText;
        Object.assign(btn.style, {
          backgroundColor: '#4a5568',
          color: '#63b3ed',
          border: 'none',
          padding: '4px 10px',
          borderRadius: '4px',
          fontSize: '12px',
          cursor: 'pointer',
          marginLeft: '4px',
        });
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
      }, 5000);
    }

    /* ── HTTP helper for the plugin routes ─────────────────────────────── */

    const API_PREFIX = '/api/session-trash';
    const CSRF_HEADER = 'x-dsh-plugin';

    /**
     * Call one plugin HTTP route. The host envelope is
     * `{ ok: true, data }` / `{ ok: false, error: { code, message } }`.
     * @param {import('@deepseek-ai/cordis').Context} ctx - browser kernel context.
     * @param {string} path - route path, e.g. '/api/session-trash/list'.
     * @param {{method?: string, body?: object}} [options]
     * @returns {Promise<any>} the `data` half of a successful response.
     */
    async function api(ctx, path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER]: 'session-trash',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const error = new Error(data?.error?.message ?? `HTTP ${response.status}`);
        error.code = data?.error?.code;
        throw error;
      }
      return data.data;
    }

    /* ── 会话回收站 settings section ───────────────────────────────────── */

    /**
     * Two-tab session manager with multi-select batch operations:
     *   · 回收站 — archived sessions; batch restore / batch permanent-delete /
     *     empty.
     *   · 全部会话 — every session grouped by workspace; multi-select
     *     delete→trash (archive) or permanent-delete.
     */
    function TrashTab({ ctx }) {
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(() => new Set());
      const [confirmModal, setConfirmModal] = useState(null); // { kind, ids }
      const [toast, setToast] = useState(null);

      /** Cross-reference the latest title from the sessions service. */
      const currentTitle = (sessionId, fallback) => {
        try {
          const byId = ctx?.sessions?.list?.getSnapshot()?.byId ?? {};
          return byId[sessionId]?.title || fallback;
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
        const offEvent = ctx?.on?.('workspace/archived-sessions-changed', () => {
          loadItems();
        });
        const offRpc = ctx?.typert?.on?.('host/archived-sessions-changed', () => {
          loadItems();
        });
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

      useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
      }, [toast]);

      const showToast = (message, undoFn) => setToast({ message, undoFn });

      const toggle = (sessionId) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        });
      };

      const toggleAll = () => {
        setSelected((prev) => {
          const ids = items.map((i) => i.sessionId);
          const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
          const next = new Set(prev);
          if (allSelected) for (const id of ids) next.delete(id);
          else for (const id of ids) next.add(id);
          return next;
        });
      };

      const clearSelection = () => setSelected(new Set());

      /** Restore one archived session (with an undo that re-archives). */
      const handleUnarchive = async (session) => {
        try {
          await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId: session.sessionId } });
          clearSelection();
          loadItems();
          showToastLayer(`已恢复会话「${currentTitle(session.sessionId, session.title) || session.sessionId}」`, async () => {
            try {
              await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId: session.sessionId } });
              loadItems();
            } catch (e) {
              console.error('撤销失败', e);
            }
          });
        } catch (err) {
          showToastLayer(`恢复失败: ${err.message}`);
        }
      };

    /** Purge deleted session IDs from browser-side session store and DOM tree. */
    function purgeFromBrowserSessionStore(ctx, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      for (const id of ids) {
        try {
          if (ctx?.sessions?.list?.getSnapshot) {
            const snapshot = ctx.sessions.list.getSnapshot();
            if (snapshot?.byId) delete snapshot.byId[id];
            if (Array.isArray(snapshot?.ids)) {
              const idx = snapshot.ids.indexOf(id);
              if (idx !== -1) snapshot.ids.splice(idx, 1);
            }
          }
          if (ctx?.sessions?.byId) delete ctx.sessions.byId[id];

          ctx?.sessions?.removeSession?.(id);
          ctx?.sessions?.deleteSession?.(id);
          ctx?.sessions?.remove?.(id);
          ctx?.sessions?.delete?.(id);
          ctx?.emit?.('session/deleted', { id, sessionId: id });
          ctx?.emit?.('session/permanently-deleted', { id, sessionId: id });

          if (typeof document !== 'undefined') {
            const btn = document.querySelector(`[data-dsh-session-recycle-bin-delete="${id}"]`);
            if (btn) {
              const row = btn.closest('[role="treeitem"]') || btn.closest('li') || btn.closest('.dsh-trash-row');
              row?.remove();
            }
          }
        } catch (e) {
          console.error('session-trash: browser session purge error', e);
        }
      }
    }

      /** Permanently delete the given session ids (batch). */
      const handlePurge = async (ids) => {
        try {
          const result = await api(ctx, `${API_PREFIX}/purge`, { method: 'POST', body: { sessionIds: ids } });
          const failedIds = new Set((result?.errors ?? []).map((e) => e.sessionId));
          const succeededIds = ids.filter((id) => !failedIds.has(id));
          purgeFromBrowserSessionStore(ctx, succeededIds);
          clearSelection();
          setConfirmModal(null);
          loadItems();
          if (result?.errors?.length > 0) {
            const hasRunning = result.errors.some((e) => e.code === 'SESSION_RUNNING' || e.message?.includes('运行中'));
            if (hasRunning) {
              showToastLayer(`无法彻底删除：存在正在运行中的会话，请等待结束后再试`);
            } else {
              showToastLayer(`已彻底删除 ${result.deletedCount} 个，${result.errors.length} 个失败`);
            }
          } else {
            showToastLayer(`已彻底删除 ${result?.deletedCount ?? ids.length} 个会话`);
          }
        } catch (err) {
          const msg = err.code === 'SESSION_RUNNING' ? '无法彻底删除：会话正在运行中，请等待结束后再试' : `删除失败: ${err.message}`;
          showToastLayer(msg);
        }
      };

      const selectedIds = [...selected].filter((id) => items.some((i) => i.sessionId === id));
      const allSelected = items.length > 0 && items.every((i) => selected.has(i.sessionId));

      const confirmLabel = '确认彻底删除';
      const confirmBody = `确定要永久删除选中的 ${confirmModal?.ids?.length ?? 0} 个会话吗？此操作不可撤销，会话的全部历史对话记录将被清除。`;

      return h('div', { style: styles.container },
        // Header
        h('div', { style: styles.header },
          h('div', null,
            h('h2', { style: { ...styles.title, display: 'flex', alignItems: 'center', gap: '8px' } },
              h(TrashIcon, { width: '20', height: '20' }),
              '会话回收站'
            ),
            h('p', { style: styles.subtitle }, `共 ${items.length} 个已归档会话，可还原或彻底删除`)
          )
        ),
        // Selection toolbar
        items.length > 0 &&
          h('div', { style: styles.toolbar },
            h('label', { style: styles.toolbarCheck },
              h('input', { type: 'checkbox', style: styles.checkbox, checked: allSelected, onChange: toggleAll }),
              '全选'
            ),
            selectedIds.length > 0 && h('span', { style: styles.toolbarCount }, `已选 ${selectedIds.length} 项`),
            h('div', { style: styles.toolbarActions },
              h('button', { key: 'restore', style: styles.toolBtn, disabled: selectedIds.length === 0, onClick: () => {
                  const target = items.find((i) => i.sessionId === selectedIds[0]);
                  handleUnarchive(target ?? { sessionId: selectedIds[0], title: selectedIds[0] });
                } }, '还原'),
              h('button', { key: 'purge', style: { ...styles.toolBtn, ...styles.toolBtnDanger }, disabled: selectedIds.length === 0, onClick: () => setConfirmModal({ kind: 'purge', ids: selectedIds }) }, '彻底删除'),
            )
          ),
        // Content
        loading
          ? h('div', { style: styles.stateBox }, '加载中...')
          : error
          ? h('div', { style: { ...styles.stateBox, color: '#e53e3e' } }, error)
          : items.length === 0
          ? h('div', { style: styles.stateBox }, '回收站暂无会话')
          : h('div', { style: styles.list },
              items.map((item) =>
                h('div', { key: item.sessionId, style: { ...styles.card, ...(selected.has(item.sessionId) ? styles.cardSelected : {}) }, title: `ID: ${item.sessionId}\n路径: ${item.cwd || '-'}` },
                  h('input', {
                    type: 'checkbox',
                    style: styles.checkbox,
                    checked: selected.has(item.sessionId),
                    onChange: () => toggle(item.sessionId),
                    onClick: (e) => e.stopPropagation(),
                  }),
                  h('div', { style: styles.cardInfo, onClick: () => toggle(item.sessionId) },
                    h('div', { style: styles.itemTitle }, currentTitle(item.sessionId, item.title) || item.sessionId),
                    h('div', { style: styles.itemSubMeta }, `ID: ${item.sessionId}${item.cwd ? ` · ${item.cwd}` : ''}`),
                    item.workspaceTitle &&
                      h('div', { style: styles.itemMeta }, `工作区: ${item.workspaceTitle}${item.workspacePath ? ` (${item.workspacePath})` : ''}`)
                  ),
                  h('div', { style: styles.cardActions },
                    h('button', { style: styles.restoreBtn, onClick: () => handleUnarchive(item) }, '还原'),
                    h('button', { style: styles.deleteBtn, onClick: () => setConfirmModal({ kind: 'purge', ids: [item.sessionId] }) }, '彻底删除')
                  )
                )
              )
            ),
        // Footer
        items.length > 0 && h('div', { style: styles.footer }, `共 ${items.length} 个归档会话`),
        // Toast
        toast &&
          h('div', { style: styles.toast },
            h('span', null, toast.message),
            toast.undoFn &&
              h('button', {
                style: styles.undoBtn,
                onClick: () => {
                  toast.undoFn();
                  setToast(null);
                },
              }, '撤销')
          ),
        // Confirmation Modal
        confirmModal &&
          h('div', { style: styles.modalOverlay },
            h('div', { style: styles.modalContent },
              h('h3', { style: styles.modalTitle }, confirmLabel),
              h('p', { style: styles.modalBody }, confirmBody),
              h('div', { style: styles.modalActions },
                h('button', { style: styles.cancelBtn, onClick: () => setConfirmModal(null) }, '取消'),
                h('button', {
                  style: styles.confirmBtn,
                  onClick: () => {
                    handlePurge(confirmModal.ids);
                  },
                }, '确认')
              )
            )
          )
      );
    }

    /* ── 删除会话 session header action ────────────────────────────────── */

    /**
     * Session-header action: move the current session into the recycle bin.
     * No confirmation — the session is recoverable from the recycle bin and
     * the host broadcast (`host/archived-sessions-changed`) hides the row
     * from the sidebar immediately.
     */
    function DeleteSessionAction({ sessionId, ctx }) {
      const [isArchived, setIsArchived] = useState(false);

      if (!sessionId) return null;

      const actionTitle = isArchived ? '还原会话' : '删除会话';

      return h(
        'button',
        {
          type: 'button',
          title: actionTitle,
          'aria-label': actionTitle,
          style: styles.headerAction,
          // dangerouslySetInnerHTML for the inline SVG (static, plugin-authored).
          dangerouslySetInnerHTML: { __html: isArchived ? RESTORE_ICON_SVG : TRASH_ICON_SVG },
          onClick: async () => {
            try {
              if (isArchived) {
                await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId } });
                setIsArchived(false);
                showToastLayer('已还原会话', async () => {
                  await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId } });
                  setIsArchived(true);
                });
              } else {
                await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId } });
                setIsArchived(true);
                showToastLayer('已将会话放入回收站', async () => {
                  await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId } });
                  setIsArchived(false);
                });
              }
            } catch (err) {
              const msg = err.code === 'SESSION_RUNNING' ? '无法删除：会话正在运行中，请等待结束后再删除' : `${actionTitle}失败: ${err.message}`;
              showToastLayer(msg);
            }
          },
        }
      );
    }

    /* ── 侧边栏会话行删除图标（DOM 增强） ──────────────────────────────── */

    /*
     * The stock session-row "⋯" menu (rename/fork/archive) is hardcoded in
     * dsh-client-ui-workspace with no plugin slot, so a small delete icon is
     * injected directly into each sidebar session row. Rows are matched by
     * their action button's aria-label (`会话“{title}”的操作` /
     * `Session actions for {title}`), and the title is mapped back to a
     * session id through the `sessions` service's `byId` index. A
     * MutationObserver re-syncs after every sidebar re-render; injection is
     * idempotent via a data attribute marker.
     */

    const SESSION_ARIA_ZH = /^会话“(.+?)”的操作$/;
    const SESSION_ARIA_EN = /^Session actions for (.+)$/;

    function sessionTitleFromLabel(label) {
      const zh = SESSION_ARIA_ZH.exec(label ?? '');
      if (zh) return zh[1];
      const en = SESSION_ARIA_EN.exec(label ?? '');
      if (en) return en[1];
      return undefined;
    }

    function isSessionActionButton(button) {
      const label = button.getAttribute('aria-label') ?? '';
      return SESSION_ARIA_ZH.test(label) || SESSION_ARIA_EN.test(label);
    }

    /** Reverse title → session ids from the sessions service. */
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

    /** Inject the per-row button styles once (themed via DSH CSS variables). */
    let rowStyleInjected = false;
    function ensureRowStyle() {
      if (rowStyleInjected || typeof document === 'undefined') return;
      rowStyleInjected = true;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-session-recycle-bin';
      tag.textContent = [
        /* The icon is revealed on row hover, matching the stock "⋯" affordance. */
        '.dsh-trash-row-btn{',
        '  background:none;border:none;padding:2px;width:22px;height:22px;flex:none;',
        '  display:inline-flex;align-items:center;justify-content:center;',
        '  cursor:pointer;border-radius:5px;opacity:0;transition:opacity .12s ease,color .12s ease,background .12s ease;',
        '  color:var(--dsw-alias-label-tertiary,#a0aec0);',
        '}',
        '.dsh-trash-row:hover .dsh-trash-row-btn,',
        '.dsh-trash-row:focus-within .dsh-trash-row-btn{opacity:.65;}',
        '.dsh-trash-row-btn:hover,',
        '.dsh-trash-row-btn:focus-visible{opacity:1;color:var(--dsw-alias-state-error-primary,#e53e3e);',
        '  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
        '.dsh-trash-row-btn:focus-visible{outline:2px solid var(--dsw-alias-state-focus,#3182ce);outline-offset:-1px;}',
        '.dsh-trash-row-btn svg{display:block;}',
      ].join('\n');
      document.head.appendChild(tag);
    }

    /** Inject one small delete button per sidebar session row. */
    function injectRowDelete(ctx) {
      ensureRowStyle();
      const index = buildTitleIndex(ctx);
      for (const row of document.querySelectorAll('[role="treeitem"]')) {
        if (row.querySelector('[data-dsh-session-recycle-bin-delete]')) continue;
        const actionButton = [...row.querySelectorAll('button')].find(isSessionActionButton);
        if (!actionButton) continue;
        const title = sessionTitleFromLabel(actionButton.getAttribute('aria-label'));
        if (!title) continue;
        const ids = index.get(title);
        if (!ids || ids.length !== 1) continue; // ambiguous title → skip
        const sessionId = ids[0];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dsh-trash-row-btn';
        button.dataset.dshSessionRecycleBinDelete = sessionId;
        button.title = '删除会话';
        button.setAttribute('aria-label', '删除会话');
        button.innerHTML = TRASH_ICON_SVG;
        button.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          try {
            await api(ctx, `${API_PREFIX}/archive`, { method: 'POST', body: { sessionId } });
            showToastLayer(`已将会话「${title}」放入回收站`, async () => {
              await api(ctx, `${API_PREFIX}/unarchive`, { method: 'POST', body: { sessionId } });
            });
          } catch (err) {
            const msg = err.code === 'SESSION_RUNNING' ? '无法删除：会话正在运行中，请等待结束后再删除' : `删除会话失败: ${err.message}`;
            showToastLayer(msg);
          }
        });
        row.classList.add('dsh-trash-row');
        // Insert directly before the title span (after the status dots).
        const titleSpan = [...row.children].find((child) => child.textContent === title);
        row.insertBefore(button, titleSpan ?? row.firstChild);
      }
    }

    /** Inject the Trash Icon into the settings left sidebar menu item. */
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
            temp.innerHTML = TRASH_ICON_SVG;
            const newSvg = temp.firstElementChild;
            if (newSvg) {
              newSvg.dataset.dshTrashIconInjected = 'true';
              if (svg.getAttribute('class')) newSvg.setAttribute('class', svg.getAttribute('class'));
              svg.parentNode?.replaceChild(newSvg, svg);
            }
          }
        } else if (!itemContainer.querySelector('[data-dsh-trash-icon-injected]')) {
          const temp = document.createElement('div');
          temp.innerHTML = TRASH_ICON_SVG;
          const newSvg = temp.firstElementChild;
          if (newSvg) {
            newSvg.dataset.dshTrashIconInjected = 'true';
            itemContainer.insertBefore(newSvg, textEl);
          }
        }
      }
    }

    /** Watch the sidebar tree and keep per-row delete buttons and settings icon in sync. */
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
            // best effort; the observer retries on the next mutation
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

    /* ── plugin body ───────────────────────────────────────────────────── */

    /**
     * Browser kernel plugin entry. Registers the session manager settings
     * section, the session-header delete action, and keeps per-row sidebar
     * delete icons injected.
     * @param {import('@deepseek-ai/cordis').Context} ctx - browser kernel context.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'trash',
            order: 200,
            label: () => '会话回收站',
            icon: h(TrashIcon, { width: 16, height: 16 }),
            iconName: 'trash',
            Icon: TrashIcon,
            renderIcon: () => h(TrashIcon),
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

      // DOM augmentation for the per-row sidebar delete icons (disposed with
      // the plugin: the returned cleanup is the effect's disposer).
      ctx.effect(() => startSidebarRowDelete(ctx));
    }

    exports.apply = apply;
    exports.inject = ['slots', 'connection', 'typert', 'sessions'];
    return module.exports;
  },
});

/* ── shared inline styles ─────────────────────────────────────────────── */

const styles = {
  container: {
    padding: '24px',
    maxWidth: '800px',
    margin: '0 auto',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
    borderBottom: '1px solid #e2e8f0',
    paddingBottom: '16px',
  },
  title: { margin: 0, fontSize: '20px', fontWeight: 600, color: '#1a202c' },
  subtitle: { margin: '4px 0 0 0', fontSize: '13px', color: '#718096' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '12px',
    padding: '8px 12px',
    borderRadius: '8px',
    background: '#f7fafc',
    border: '1px solid #edf2f7',
  },
  toolbarCheck: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#4a5568', cursor: 'pointer' },
  toolbarCount: { fontSize: '12px', color: '#718096' },
  toolbarActions: { display: 'flex', gap: '8px', marginLeft: 'auto' },
  toolBtn: {
    background: '#edf2f7',
    color: '#2b6cb0',
    border: '1px solid #cbd5e0',
    padding: '4px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  toolBtnDanger: { background: '#fff5f5', color: '#c53030', borderColor: '#feb2b2' },
  stateBox: { padding: '40px 0', textAlign: 'center', color: '#a0aec0', fontSize: '14px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 14px',
    borderRadius: '8px',
    border: '1px solid #e2e8f0',
    backgroundColor: '#ffffff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    cursor: 'pointer',
  },
  cardSelected: { borderColor: '#90cdf4', backgroundColor: '#ebf8ff' },
  checkbox: { width: '14px', height: '14px', flex: 'none', cursor: 'pointer' },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
  itemTitle: { fontSize: '14px', fontWeight: 600, color: '#2d3748', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemMeta: { fontSize: '12px', color: '#718096' },
  itemSubMeta: { fontSize: '11px', color: '#a0aec0', fontFamily: 'monospace' },
  cardActions: { display: 'flex', gap: '8px', flex: 'none' },
  restoreBtn: {
    backgroundColor: '#edf2f7',
    color: '#2b6cb0',
    border: 'none',
    padding: '5px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  deleteBtn: {
    backgroundColor: '#fff5f5',
    color: '#c53030',
    border: 'none',
    padding: '5px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  footer: { marginTop: '16px', fontSize: '12px', color: '#a0aec0', textAlign: 'right' },
  toast: {
    position: 'fixed',
    bottom: '24px',
    left: '24px',
    backgroundColor: '#2d3748',
    color: '#ffffff',
    padding: '10px 18px',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '13px',
    zIndex: 1000,
  },
  undoBtn: {
    backgroundColor: '#4a5568',
    color: '#63b3ed',
    border: 'none',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2000,
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '24px',
    width: '420px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
  },
  modalTitle: { margin: '0 0 12px 0', fontSize: '17px', color: '#1a202c' },
  modalBody: { margin: '0 0 20px 0', fontSize: '14px', color: '#4a5568', lineHeight: 1.5 },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '12px' },
  cancelBtn: {
    backgroundColor: '#edf2f7',
    color: '#4a5568',
    border: 'none',
    padding: '8px 16px',
    borderRadius: '6px',
    fontSize: '14px',
    cursor: 'pointer',
  },
  confirmBtn: {
    backgroundColor: '#e53e3e',
    color: '#ffffff',
    border: 'none',
    padding: '8px 16px',
    borderRadius: '6px',
    fontSize: '14px',
    cursor: 'pointer',
  },
  headerAction: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    padding: '5px',
    width: '26px',
    height: '26px',
    borderRadius: '7px',
    lineHeight: 1,
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-tertiary, #a0aec0)',
    opacity: 0.85,
    transition: 'color .12s ease, background .12s ease, opacity .12s ease',
  },
};
