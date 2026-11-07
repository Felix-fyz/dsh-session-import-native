/**
 * Client half of `@local/dsh-session-import-native`.
 *
 * Adds a sidebar-footer action that opens an import dialog in the frame-wide
 * overlay layer. The dialog scans a folder through the Host routes registered
 * by `index.js`, lists DeepSeek Harness's own stored sessions, and imports the
 * selected logs into this profile.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-import-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const NS = 'sessionImportNative'

    const DICTIONARIES = {
      zh: {
        button: '导入 DeepSeek 对话',
        title: '导入 DeepSeek 自己的对话',
        hint: '选择一个 sessions 目录，或直接选择单个 session.v4.jsonl.zstd 文件。',
        pathPlaceholder: 'C:\\Users\\…\\.dsh\\sessions',
        scan: '扫描',
        scanning: '正在扫描…',
        empty: '这个位置没有找到会话日志（session.v4.jsonl.zstd）。',
        failed: '扫描失败',
        all: '全选',
        none: '取消全选',
        selected: '已选 {n} 个',
        total: '共 {n} 个会话',
        importedBadge: '已导入',
        target: '工作区',
        messages: '{n} 条消息',
        cancel: '取消',
        run: '导入 {n} 个',
        running: '导入中…',
        result_ok: '导入完成：成功 {ok} 个。',
        result_partial: '完成：成功 {ok} 个，失败 {fail} 个。',
        retryHint: '失败项可以修好路径后再导入。',
        quick: '常用位置：',
        close: '关闭',
        autoCreate: '原目录不存在时自动创建（取消勾选则导入到默认工作区）',
      },
      en: {
        button: 'Import DeepSeek chats',
        title: 'Import DeepSeek sessions',
        hint: 'Pick a sessions folder, or a single session.v4.jsonl.zstd file.',
        pathPlaceholder: 'C:\\Users\\…\\.dsh\\sessions',
        scan: 'Scan',
        scanning: 'Scanning…',
        empty: 'No session logs (session.v4.jsonl.zstd) found here.',
        failed: 'Scan failed',
        all: 'Select all',
        none: 'Clear',
        selected: '{n} selected',
        total: '{n} sessions',
        importedBadge: 'imported',
        target: 'workspace',
        messages: '{n} messages',
        cancel: 'Cancel',
        run: 'Import {n}',
        running: 'Importing…',
        result_ok: 'Imported {ok} session(s).',
        result_partial: 'Done: {ok} imported, {fail} failed.',
        retryHint: 'Fix the folder path and import the failed ones again.',
        quick: 'Quick locations: ',
        close: 'Close',
        autoCreate: 'Recreate a missing original folder (otherwise import to the default workspace)',
      },
    }

    const COLORS = {
      bg: 'var(--dsw-alias-bg-overlay, #ffffff)',
      layer: 'var(--dsw-alias-bg-layer-2, #f5f6f8)',
      border: 'var(--dsw-alias-border-l1, #d8dee6)',
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      dim: 'var(--dsw-alias-label-secondary, #57606a)',
      accent: 'var(--dsw-alias-brand-primary, #0969da)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      err: 'var(--dsw-alias-state-error-primary, #cf222e)',
    }

    const S = {
      backdrop: {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0, 0, 0, 0.38)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        pointerEvents: 'auto',
      },
      panel: {
        width: '640px',
        maxWidth: '92vw',
        maxHeight: '82vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: COLORS.bg,
        color: COLORS.text,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '14px',
        padding: '18px',
        boxShadow: '0 18px 50px rgba(0, 0, 0, 0.35)',
        font: '13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      title: { fontSize: '15px', fontWeight: '600' },
      row: { display: 'flex', gap: '8px', alignItems: 'center' },
      input: {
        flex: '1',
        minWidth: '0',
        background: COLORS.layer,
        color: COLORS.text,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '8px',
        padding: '8px 10px',
        font: 'inherit',
        outline: 'none',
      },
      button: {
        border: 'none',
        borderRadius: '8px',
        padding: '8px 14px',
        font: 'inherit',
        cursor: 'pointer',
        background: COLORS.accent,
        color: '#ffffff',
        fontWeight: '500',
      },
      ghost: {
        border: `1px solid ${COLORS.border}`,
        borderRadius: '8px',
        padding: '6px 12px',
        font: 'inherit',
        cursor: 'pointer',
        background: 'transparent',
        color: COLORS.dim,
      },
      chip: {
        border: `1px solid ${COLORS.border}`,
        background: 'transparent',
        color: COLORS.dim,
        borderRadius: '999px',
        padding: '3px 10px',
        fontSize: '11.5px',
        cursor: 'pointer',
      },
      list: {
        flex: '1',
        overflowY: 'auto',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '10px',
        background: COLORS.layer,
        minHeight: '180px',
      },
      item: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 10px',
        borderBottom: `1px solid ${COLORS.border}`,
      },
      itemTitle: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '12.8px',
        fontWeight: '500',
      },
      itemMeta: {
        color: COLORS.dim,
        fontSize: '11px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      badge: {
        flex: 'none',
        fontSize: '10.5px',
        color: COLORS.ok,
        border: `1px solid ${COLORS.ok}`,
        borderRadius: '999px',
        padding: '0 7px',
        lineHeight: '17px',
      },
      foot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
      note: { color: COLORS.dim, fontSize: '11.5px' },
      result: {
        margin: 0,
        maxHeight: '110px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: COLORS.layer,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '8px',
        padding: '8px 10px',
        fontSize: '11.5px',
      },
    }

    /* ---------------------------------------------------------------- state */

    let dialogOpen = false
    const openListeners = new Set()
    const subscribeOpen = (listener) => {
      openListeners.add(listener)
      return () => openListeners.delete(listener)
    }
    const setDialogOpen = (next) => {
      dialogOpen = next
      for (const listener of openListeners) listener()
    }
    const useDialogOpen = () => useSyncExternalStore(subscribeOpen, () => dialogOpen, () => dialogOpen)

    /* ---------------------------------------------------------------- utils */

    function formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      const two = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
    }

    function fill(template, params) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /* -------------------------------------------------------------- dialog */

    function Dialog({ t }) {
      const [path, setPath] = useState('')
      const [roots, setRoots] = useState([])
      const [fallbackCwd, setFallbackCwd] = useState('')
      const [sessions, setSessions] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [error, setError] = useState('')
      const [selected, setSelected] = useState({})
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [autoCreate, setAutoCreate] = useState(true)

      const scan = useCallback(async (target) => {
        setScanning(true)
        setError('')
        setResult(null)
        try {
          const payload = await postJson('/dsh-session-import/scan', { path: target })
          setSessions(payload.sessions ?? [])
          setSelected({})
        } catch (failure) {
          setSessions([])
          setError(failure.message)
        } finally {
          setScanning(false)
        }
      }, [])

      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch('/dsh-session-import/config')
            const payload = await response.json()
            if (!alive || !payload.ok) return
            setRoots(payload.roots ?? [])
            setFallbackCwd(payload.fallbackCwd ?? '')
            setPath(payload.defaultPath ?? '')
            await scan(payload.defaultPath ?? '')
          } catch (failure) {
            if (alive) setError(failure.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [scan])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') setDialogOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      const usable = useMemo(() => (sessions ?? []).filter((session) => session.usable !== false), [sessions])
      const selectedFiles = useMemo(
        () => Object.keys(selected).filter((file) => selected[file] === true),
        [selected],
      )
      const allSelected = usable.length > 0 && usable.every((session) => selected[session.file] === true)

      const toggle = (session) => {
        if (session.usable === false) return
        setSelected((previous) => ({ ...previous, [session.file]: previous[session.file] !== true }))
      }

      const toggleAll = () => {
        if (allSelected) {
          setSelected({})
          return
        }
        const next = {}
        for (const session of usable) next[session.file] = true
        setSelected(next)
      }

      const run = async () => {
        if (selectedFiles.length === 0 || busy) return
        setBusy(true)
        setResult(null)
        try {
          const payload = await postJson('/dsh-session-import/import', {
            files: selectedFiles,
            fallbackCwd,
            missingCwd: autoCreate ? 'create' : 'fallback',
          })
          const ok = (payload.imported ?? []).length
          const fail = (payload.failed ?? []).length
          const line = fail === 0 ? fill(t('result_ok'), { ok }) : fill(t('result_partial'), { ok, fail })
          const details = (payload.failed ?? []).slice(0, 4).map((item) => `✗ ${item.file}\n  ${item.error}`).join('\n')
          setResult({ ok, text: details === '' ? line : `${line}\n${details}` })
          setSelected({})
          await scan(path)
        } catch (failure) {
          setResult({ ok: 0, text: `${t('failed')}: ${failure.message}` })
        } finally {
          setBusy(false)
        }
      }

      const count = sessions === null ? 0 : sessions.length

      return h(
        'div',
        { style: S.backdrop, onClick: (event) => { if (event.target === event.currentTarget) setDialogOpen(false) } },
        h(
          'div',
          { style: S.panel, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
          h(
            'div',
            { style: S.head },
            h('div', { style: S.title }, t('title')),
            h('button', { style: S.ghost, onClick: () => setDialogOpen(false), title: t('close') }, '✕'),
          ),
          h('div', { style: S.note }, t('hint')),
          h(
            'div',
            { style: S.row },
            h('input', {
              style: S.input,
              value: path,
              spellCheck: false,
              placeholder: t('pathPlaceholder'),
              onChange: (event) => setPath(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') scan(path)
              },
            }),
            h(
              'button',
              { style: S.button, disabled: scanning, onClick: () => scan(path) },
              scanning ? t('scanning') : t('scan'),
            ),
          ),
          roots.length > 1
            ? h(
              'div',
              { style: { ...S.row, flexWrap: 'wrap' } },
              h('span', { style: S.note }, t('quick')),
              roots.map((root) => h(
                'button',
                {
                  key: root.path,
                  style: S.chip,
                  onClick: () => {
                    setPath(root.path)
                    scan(root.path)
                  },
                },
                root.label,
              )),
            )
            : null,
          h(
            'label',
            { style: { display: 'flex', gap: '6px', alignItems: 'center', color: COLORS.dim, fontSize: '11.5px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: autoCreate,
              onChange: (event) => setAutoCreate(event.target.checked),
            }),
            t('autoCreate'),
          ),
          h(
            'div',
            { style: { ...S.row, justifyContent: 'space-between' } },
            h('span', { style: S.note }, fill(t('total'), { n: count })),
            usable.length > 0
              ? h('button', { style: S.chip, onClick: toggleAll }, allSelected ? t('none') : t('all'))
              : null,
          ),
          h(
            'div',
            { style: S.list },
            scanning
              ? h('div', { style: { padding: '24px', textAlign: 'center', color: COLORS.dim } }, t('scanning'))
              : null,
            !scanning && error !== ''
              ? h('div', { style: { padding: '18px', color: COLORS.err } }, `${t('failed')}: ${error}`)
              : null,
            !scanning && error === '' && sessions !== null && sessions.length === 0
              ? h('div', { style: { padding: '24px', textAlign: 'center', color: COLORS.dim } }, t('empty'))
              : null,
            !scanning
              ? (sessions ?? []).map((session) => h(
                'div',
                {
                  key: session.file,
                  style: { ...S.item, opacity: session.usable === false ? 0.55 : 1, cursor: session.usable === false ? 'default' : 'pointer' },
                  onClick: () => toggle(session),
                },
                h('input', {
                  type: 'checkbox',
                  checked: selected[session.file] === true,
                  disabled: session.usable === false,
                  onChange: () => toggle(session),
                  onClick: (event) => event.stopPropagation(),
                  style: { marginTop: '3px' },
                }),
                h(
                  'div',
                  { style: { flex: '1', minWidth: '0' } },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                    h('span', { style: S.itemTitle, title: session.title }, session.title || session.name),
                    session.imported ? h('span', { style: S.badge }, t('importedBadge')) : null,
                  ),
                  h(
                    'div',
                    { style: S.itemMeta, title: session.cwd },
                    `${formatTime(session.createdAt)} · ${fill(t('messages'), { n: session.messages })} · ${t('target')}: ${session.cwd || '—'}`,
                  ),
                  session.usable === false
                    ? h('div', { style: { ...S.itemMeta, color: COLORS.err } }, session.error ?? '')
                    : null,
                ),
              ))
              : null,
          ),
          result !== null
            ? h('pre', { style: { ...S.result, color: result.ok > 0 ? COLORS.ok : COLORS.err } }, result.text)
            : null,
          h(
            'div',
            { style: S.foot },
            h('span', { style: S.note }, fill(t('selected'), { n: selectedFiles.length })),
            h(
              'div',
              { style: { display: 'flex', gap: '8px' } },
              h('button', { style: S.ghost, onClick: () => setDialogOpen(false) }, t('cancel')),
              h(
                'button',
                { style: S.button, disabled: busy || selectedFiles.length === 0, onClick: run },
                busy ? t('running') : fill(t('run'), { n: selectedFiles.length }),
              ),
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ entries */

    function FooterAction({ t, wide }) {
      const open = useDialogOpen()
      return h(
        'button',
        {
          title: t('button'),
          'aria-label': t('button'),
          'aria-pressed': open,
          onClick: () => setDialogOpen(!open),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%',
            background: 'transparent',
            border: 'none',
            color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
            cursor: 'pointer',
            padding: '6px 10px',
            borderRadius: '8px',
            fontSize: '12.5px',
            textAlign: 'left',
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, #eef1f5)' },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
        },
        h('span', { style: { fontSize: '14px', lineHeight: 1 } }, '⇩'),
        wide === false ? null : h('span', null, t('button')),
      )
    }

    function DialogHost({ t }) {
      const open = useDialogOpen()
      return open ? h(Dialog, { t }) : null
    }

    /* -------------------------------------------------------------- plugin */

    return {
      name: '@local/dsh-session-import-native',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-import-native: locale')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-session-import-native.open',
          order: 20,
          label: () => t('button'),
        }, (props) => h(FooterAction, { ...props, t }))), 'session-import-native: footer action')

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-import-native.dialog',
          order: 40,
        }, (props) => h(DialogHost, { ...props, t }))), 'session-import-native: dialog overlay')
      },
    }
  },
})
