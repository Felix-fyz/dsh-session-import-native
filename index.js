/**
 * Host half of `@local/dsh-session-import-native`.
 *
 * DeepSeek Harness persists every conversation as `session.v4.jsonl.zstd`: a
 * concatenation of independently decodable Zstandard frames whose first frame
 * is exactly the session header line and whose later frames carry event
 * batches. This plugin reads such logs from any folder, rewrites them into a
 * fresh durable session of the *current* profile (through `sessionPersistence`),
 * attaches that session to its working-directory workspace, and exposes the
 * whole operation to the Web UI plus a `/dsh-import` command.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Zstandard little-endian frame magic. */
const ZSTD_MAGIC = 4247762216
/** Maximum files discovered under one root. */
const MAX_FILES = 600
/** Maximum directory depth walked under one root. */
const MAX_DEPTH = 6

/** Event kinds kept when rewriting a foreign log into this profile. */
const KEEP_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'assistant/attempt',
  'session/title',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
])
/** Event kinds that carry a surface intent. */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

export const inject = ['commands', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'webServer', 'workingDirectory']

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 * @param {Buffer} buffer
 * @returns {{ start: number, end: number }[]}
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`不是有效的 zstd 会话日志（偏移 ${offset} 处缺少帧头）`)
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('会话日志帧头损坏')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('会话日志数据块类型损坏')
      offset += blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < 0) return frames
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decode one stored log, plaintext `.jsonl` or concatenated zstd frames.
 * @param {string} file
 * @returns {string}
 */
function decodeLogFile(file) {
  const buffer = readFileSync(file)
  if (buffer.length === 0) throw new Error('文件为空')
  if (buffer[0] === 0x7b) return buffer.toString('utf8')
  const frames = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('无法识别的会话日志编码')
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Parse a stored log into its header and raw event records.
 * @param {string} file
 */
function parseLog(file) {
  const text = decodeLogFile(file)
  let header
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      break
    }
    if (header === undefined) {
      if (record.type !== 'session') throw new Error('会话日志缺少头部记录')
      header = record
      continue
    }
    events.push(record)
  }
  if (header === undefined) throw new Error('会话日志缺少头部记录')
  return { header, events }
}

/** Replace attachment blocks that point at another profile's attachment store. */
function portableContent(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    if (block.type === 'image') {
      const name = block.attachment && typeof block.attachment.name === 'string' ? block.attachment.name : ''
      return { type: 'text', text: name === '' ? '[图片]' : `[图片：${name}]` }
    }
    if (block.type === 'file') {
      const name = block.attachment && typeof block.attachment.name === 'string' ? block.attachment.name : ''
      return { type: 'text', text: name === '' ? '[附件]' : `[附件：${name}]` }
    }
    return block
  })
}

/**
 * Rewrite foreign events into the current vocabulary with contiguous seqs.
 * Runtime bookkeeping (`job/*`, delivery acks, retry markers, approval cards)
 * is dropped; conversation, tool activity, titles and turn structure remain.
 * @param {unknown[]} raw
 */
function toPortableEvents(raw) {
  const events = []
  for (const event of raw) {
    if (event === null || typeof event !== 'object') continue
    if (typeof event.type !== 'string' || !KEEP_TYPES.has(event.type)) continue
    if (event.data === null || typeof event.data !== 'object') continue
    const data = event.data
    if (data.message !== null && typeof data.message === 'object' && Array.isArray(data.message.content)) {
      data.message = { ...data.message, content: portableContent(data.message.content) }
    }
    if (event.type === 'session/title') {
      delete data.messageSeqs
      const title = typeof data.title === 'string' ? data.title.trim() : ''
      data.title = title === '' ? '未命名会话' : title
    }
    const next = {
      type: event.type,
      seq: events.length,
      time: Number(event.time) || Date.now(),
      data,
    }
    if (SURFACE_TYPES.has(event.type)) next.surfaceOp = 'append'
    events.push(next)
  }
  return events
}

/** Latest folded title carried by the log. */
function titleOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'session/title') return String(events[index].data.title ?? '')
  }
  return ''
}

/** Number of human/assistant messages carried by the log. */
function messageCountOf(events) {
  let count = 0
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') count += 1
  }
  return count
}

/** Recursively collect stored session logs under a file or directory root. */
function collectLogFiles(root) {
  if (!existsSync(root)) throw new Error(`路径不存在：${root}`)
  const info = statSync(root)
  if (info.isFile()) return [root]
  const files = []
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(full, depth + 1)
        continue
      }
      if (/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name)) files.push(full)
    }
  }
  walk(root, 0)
  return files
}

/** Plugin-owned import ledger so one source file is not imported twice by accident. */
function ledgerFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'session-import-native', 'imported.json')
}

function loadLedger() {
  try {
    const parsed = JSON.parse(readFileSync(ledgerFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.imports !== null && typeof parsed.imports === 'object') return parsed
  } catch {
    /* a missing or corrupt ledger just means "nothing recorded yet" */
  }
  return { version: 1, imports: {} }
}

async function saveLedger(ledger) {
  const file = ledgerFile()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(ledger, null, 2), 'utf8')
}

/** Stable per-file key: absolute path plus size and mtime. */
function fileKey(file) {
  try {
    const info = statSync(file)
    return `${file}|${info.size}|${Math.trunc(info.mtimeMs)}`
  } catch {
    return file
  }
}

/** A sane destination for logs that carry no usable working directory. */
function defaultFallbackCwd(ctx) {
  try {
    const first = ctx.workspaceRegistry.list()[0]
    if (first !== undefined && typeof first.path === 'string') return first.path
  } catch {
    /* registry not ready yet */
  }
  return join(homedir(), 'Documents')
}

/** Suggested scan roots discovered on this machine. */
function suggestedRoots() {
  const home = homedir()
  const roots = [{ label: '本机会话目录', path: join(home, '.dsh', 'sessions') }]
  const desktop = join(home, 'Desktop')
  if (existsSync(desktop)) {
    let entries = []
    try {
      entries = readdirSync(desktop, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^sessions/i.test(entry.name)) continue
      roots.push({ label: `桌面 · ${entry.name}`, path: join(desktop, entry.name) })
    }
  }
  return roots.filter((root) => existsSync(root.path))
}

/** Describe one stored log for the picker. */
function describeSession(file, ledger) {
  const entry = {
    file,
    name: file.split(/[\\/]/).pop(),
    id: '',
    kind: 'session',
    title: '',
    cwd: '',
    createdAt: 0,
    version: 0,
    messages: 0,
    bytes: 0,
    imported: false,
  }
  try {
    entry.bytes = statSync(file).size
  } catch {
    /* size is cosmetic */
  }
  try {
    const { header, events } = parseLog(file)
    const portable = toPortableEvents(events)
    entry.id = String(header.id ?? '')
    entry.version = Number(header.version ?? 0)
    entry.cwd = typeof header.cwd === 'string' ? header.cwd : ''
    entry.createdAt = Number(header.createdAt ?? 0) || 0
    entry.title = titleOf(portable)
    entry.messages = messageCountOf(portable)
    entry.usable = portable.length > 0 && entry.version === 4
    if (!entry.usable) {
      entry.error = entry.version !== 4 ? `仅支持 v4 会话日志（此文件为 v${entry.version}）` : '没有可导入的对话内容'
    }
  } catch (error) {
    entry.usable = false
    entry.error = error instanceof Error ? error.message : String(error)
  }
  const record = ledger.imports[fileKey(file)]
  if (record !== undefined) {
    entry.imported = true
    entry.importedSessionId = record.sessionId
  }
  return entry
}

/**
 * Apply the caller's longest-matching path rewrite, so a log written before a
 * folder was moved or renamed lands in the folder that exists today.
 * @param {string} path
 * @param {unknown} map
 */
function applyCwdMap(path, map) {
  if (!Array.isArray(map) || path === '') return path
  let best
  for (const entry of map) {
    if (entry === null || typeof entry !== 'object') continue
    const from = typeof entry.from === 'string' ? entry.from : ''
    const to = typeof entry.to === 'string' ? entry.to : ''
    if (from === '' || to === '') continue
    const normalizedFrom = from.replace(/[\\/]+$/, '')
    const lowerPath = path.toLowerCase()
    const lowerFrom = normalizedFrom.toLowerCase()
    if (lowerPath !== lowerFrom && !lowerPath.startsWith(`${lowerFrom}\\`) && !lowerPath.startsWith(`${lowerFrom}/`)) continue
    if (best === undefined || normalizedFrom.length > best.from.length) best = { from: normalizedFrom, to: to.replace(/[\\/]+$/, '') }
  }
  if (best === undefined) return path
  return best.to + path.slice(best.from.length)
}

/**
 * Import one stored log as a brand-new durable session of this profile.
 * @param {import('cordis').Context & Record<string, any>} ctx
 * @param {string} file
 * @param {{ fallbackCwd?: string, missingCwd?: 'create' | 'fallback', cwdMap?: unknown, minMessages?: number }} options
 */
async function importOne(ctx, file, options = {}) {
  const { header, events } = parseLog(file)
  const version = Number(header.version ?? 0)
  if (version !== 4) throw new Error(`仅支持 v4 会话日志（此文件为 v${version}）`)
  const portable = toPortableEvents(events)
  if (portable.length === 0) throw new Error('没有可导入的对话内容')
  const messages = messageCountOf(portable)
  if (typeof options.minMessages === 'number' && messages < options.minMessages) {
    throw new Error(`没有对话内容（0 条消息），已跳过`)
  }

  const rawCwd = typeof header.cwd === 'string' && isAbsolute(header.cwd) ? header.cwd : ''
  const sourceCwd = rawCwd === '' ? '' : applyCwdMap(rawCwd, options.cwdMap)
  const existsAsDirectory = sourceCwd !== '' && existsSync(sourceCwd) && statSync(sourceCwd).isDirectory()
  let cwd = ''
  if (existsAsDirectory) {
    cwd = sourceCwd
  } else if (sourceCwd !== '' && options.missingCwd === 'create') {
    cwd = sourceCwd
  } else if (typeof options.fallbackCwd === 'string' && isAbsolute(options.fallbackCwd)) {
    cwd = options.fallbackCwd
  } else {
    cwd = defaultFallbackCwd(ctx)
  }
  if (!isAbsolute(cwd)) throw new Error('无法确定目标工作区目录')
  await mkdir(cwd, { recursive: true })

  const id = `session-${randomUUID()}`
  const createdAt = Date.now()
  const sessionHeader = {
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }

  // Pre-flight validation: build (without entering) the session so a log the
  // current vocabulary cannot replay fails before anything durable is written.
  const store = ctx.get('sessions')
  if (store !== undefined && typeof store.prepare === 'function') {
    store.prepare(id, {
      seed: portable,
      meta: { cwd, createdAt, isSeeded: false },
    })
  }

  const handle = await ctx.sessionPersistence.create(sessionHeader)
  try {
    await handle.append(portable)
    await handle.flush()
  } finally {
    await handle.close()
  }

  let workspaceId
  try {
    const workspace = await ctx.workspaceRegistry.create(cwd)
    await workspace.attachSession(id)
    workspaceId = workspace.id
  } catch (error) {
    ctx.logger?.warn?.(`[session-import-native] 工作区绑定失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    sessionId: id,
    title: titleOf(portable),
    cwd,
    events: portable.length,
    messages,
    workspaceId,
  }
}

/** Read a JSON request body. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * Plugin entry.
 * @param {import('cordis').Context & Record<string, any>} ctx
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-session-import/config',
    handler: async (req, res) => {
      try {
        const ledger = loadLedger()
        send(res, 200, {
          ok: true,
          defaultPath: join(homedir(), '.dsh', 'sessions'),
          fallbackCwd: defaultFallbackCwd(ctx),
          roots: suggestedRoots(),
          imported: Object.keys(ledger.imports).length,
        })
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'webserver /dsh-session-import/config')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-session-import/scan',
    handler: async (req, res) => {
      try {
        const body = await readJson(req)
        const root = typeof body.path === 'string' && body.path.trim() !== '' ? body.path.trim() : join(homedir(), '.dsh', 'sessions')
        const ledger = loadLedger()
        const files = collectLogFiles(root)
        const sessions = []
        for (const file of files) sessions.push(describeSession(file, ledger))
        sessions.sort((left, right) => right.createdAt - left.createdAt)
        send(res, 200, { ok: true, root, total: sessions.length, sessions })
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'webserver /dsh-session-import/scan')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-session-import/import',
    handler: async (req, res) => {
      try {
        const body = await readJson(req)
        const files = Array.isArray(body.files) ? body.files.filter((file) => typeof file === 'string') : []
        if (files.length === 0) {
          send(res, 400, { ok: false, error: '没有选中会话' })
          return
        }
        const ledger = loadLedger()
        const imported = []
        const failed = []
        const skipped = []
        for (const file of files) {
          try {
            if (!existsSync(file)) throw new Error('文件不存在')
            const result = await importOne(ctx, file, {
              fallbackCwd: body.fallbackCwd,
              missingCwd: body.missingCwd === 'fallback' ? 'fallback' : 'create',
              cwdMap: body.cwdMap,
              minMessages: typeof body.minMessages === 'number' ? body.minMessages : undefined,
            })
            ledger.imports[fileKey(file)] = { sessionId: result.sessionId, at: new Date().toISOString(), cwd: result.cwd }
            imported.push({ file, ...result })
          } catch (error) {
            failed.push({ file, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (imported.length > 0) {
          try {
            await saveLedger(ledger)
          } catch (error) {
            ctx.logger?.warn?.(`[session-import-native] 记录导入台账失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        send(res, 200, { ok: true, imported, failed, skipped })
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'webserver /dsh-session-import/import')

  ctx.effect(() => ctx.commands.register({
    name: 'dsh-import',
    description: '导入 DeepSeek Harness 自己的会话日志（session.v4.jsonl.zstd；传目录可批量）',
    input: { hint: '<文件或目录路径>' },
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()
      if (raw === '') return { kind: 'error', text: '用法：/dsh-import <会话文件或 sessions 目录>' }
      try {
        const files = collectLogFiles(raw)
        if (files.length === 0) return { kind: 'error', text: `该路径下没有找到会话日志：${raw}` }
        const ledger = loadLedger()
        const imported = []
        const failed = []
        for (const file of files) {
          try {
            const result = await importOne(ctx, file, { fallbackCwd: defaultFallbackCwd(ctx), missingCwd: 'create' })
            ledger.imports[fileKey(file)] = { sessionId: result.sessionId, at: new Date().toISOString(), cwd: result.cwd }
            imported.push(result)
          } catch (error) {
            failed.push(`${file}：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (imported.length > 0) await saveLedger(ledger).catch(() => {})
        const lines = imported.map((item) => `  ✓ ${item.title || '未命名会话'}（${item.messages} 条消息，${item.cwd}）`)
        const tail = failed.length > 0 ? `\n失败 ${failed.length} 个：\n${failed.slice(0, 5).map((line) => `  ✗ ${line}`).join('\n')}` : ''
        return {
          kind: imported.length > 0 ? 'success' : 'error',
          text: `[session-import-native] 导入完成：成功 ${imported.length}/${files.length}${tail}\n${lines.slice(0, 30).join('\n')}`,
        }
      } catch (error) {
        return { kind: 'error', text: `导入失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'command dsh-import')
}
