import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * FF14 国服物价查询（数据源：Universalis API v2）
 *
 * 命令
 *   #市场 <物品名>        例：#市场 优纯银锭
 *   #市场 <物品名> hq     按 HQ 价格排序
 *   #市场 <物品ID>        例：#市场 44148
 *
 * ── 接口事实（2026-10-23 实测）──
 *   ✅ 中国区可直接用区域名 "中国"（也接受 "China"），返回全服挂单
 *   ❌ 没有物品名搜索接口 /search、/items、/items/search 全 404，只认数字 itemID
 *      ⇒ 中文名 → ID 必须走本地索引 plugins/example/data/market-items.json
 *         （来源：游戏解包数据 thewakingsands/ffxiv-datamining-cn + /marketable 交集）
 *   ✅ 单服查询 {world}/{itemId} 返回 minPriceNQ / minPriceHQ / unitsForSale / listings
 *   ✅ 价格是玩家上传的实时挂单，2.5 秒一次全量刷新；只有我们这层做了 90 秒缓存
 *   ⚠️ minPrice 混了 HQ 和 NQ，比价必须用 minPriceNQ / minPriceHQ 分开看
 *      （实测 优纯银锭 神意之地 minPrice=14 是 HQ，NQ 要 243）
 *
 * ── 索引怎么更新 ──
 *   ① 每周静默自检：拉 /marketable（95KB / 约 3 秒）跟本地 ID 比对，
 *      零差异就什么都不做；有差异才下载 Item.csv 重建（19MB，约 31 秒）。
 *   ② 管理员命令：#市场更新        → 先比对，有差异才下载
 *                  #市场更新 强制   → 跳过比对，无条件重建
 *   重建走「下载 → 解析 → 与 /marketable 取交集 → 写临时文件 → rename」，
 *   成功后把内存索引置空，下次查询自动重载，**不用重启 bot**。
 *
 *   CSV 来源（2026-10-23 实测速度，按此顺序回退）：
 *     gcore.jsdelivr.net 608KB/s ✅｜cdn.jsdelivr.net 478KB/s ✅
 *     raw.githubusercontent 12.5KB/s（下 19MB 要 25 分钟，只作最后兜底）
 *   CSV 格式：第 1 行数字序号、第 2 行字段名、第 3 行类型；key 在第 1 列，Name 在第 11 列。
 *   上游 thewakingsands 约 1.5~2 个月随国服版本更新，不是实时
 *   ⇒ 新物品上线当天按名字查不到是正常的，可以先用 #市场 <物品ID>。
 *   当前快照：游戏版本 2026.09.01，16845 条，467 KB
 */

const API = 'https://universalis.app/api/v2'
const REGION = '中国'
const INDEX_FILE = path.join(process.cwd(), 'plugins/example/data/market-items.json')

const TOP_N = 5
const CONCURRENCY = 10
const TIMEOUT_MS = 12000
const CACHE_TTL_MS = 90 * 1000
const USER_CD_MS = 15 * 1000
const WORLD_TTL_MS = 12 * 60 * 60 * 1000

/* 索引更新 */
const CSV_MIRRORS = [
  'https://gcore.jsdelivr.net/gh/thewakingsands/ffxiv-datamining-cn@master/Item.csv',
  'https://cdn.jsdelivr.net/gh/thewakingsands/ffxiv-datamining-cn@master/Item.csv',
  'https://raw.githubusercontent.com/thewakingsands/ffxiv-datamining-cn/master/Item.csv'
]
const CSV_TIMEOUT_MS = 240 * 1000
const CHECK_FIRST_DELAY_MS = 5 * 60 * 1000       // 启动后 5 分钟做首次自检
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // 之后每 7 天
const UA = 'Yunzai-Bot/1.0 (FF14 market plugin)'

/** 接口挂掉时的兜底（2026-10-23 的国服 4 大区 28 服） */
const FALLBACK_WORLDS = {
  陆行鸟: ['红玉海', '神意之地', '拉诺西亚', '幻影群岛', '萌芽池', '宇宙和音', '沃仙曦染', '晨曦王座'],
  莫古力: ['白银乡', '白金幻象', '神拳痕', '潮风亭', '旅人栈桥', '拂晓之间', '龙巢神殿', '梦羽宝境'],
  猫小胖: ['紫水栈桥', '延夏', '静语庄园', '摩杜纳', '海猫茶屋', '柔风海湾', '琥珀原'],
  豆豆柴: ['水晶塔', '银泪湖', '太阳海岸', '伊修加德', '红茶川']
}

let index = null            // [{ id, name, key }]
let worlds = { at: 0, list: null }
const priceCache = new Map()   // `${itemId}|${q}` → { at, rows }
const inflight = new Map()     // 同物品并发合并
const userCd = new Map()

/* ───────────────────────── 工具 ───────────────────────── */

/** 中英混排的显示宽度（中文按 2 格算） */
function dispWidth (s) {
  let n = 0
  for (const ch of String(s)) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  }
  return n
}

function pad (s, width) {
  s = String(s)
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)))
}

/** 金币：10000 以上转万/亿，读起来快 */
function fmtGil (n) {
  if (n == null || !Number.isFinite(n)) return '-'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2).replace(/\.?0+$/, '')} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')} 万`
  return String(Math.round(n))
}

function fmtAgo (ts) {
  if (!ts) return '未知'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/* ───────────────────────── 物品索引 ───────────────────────── */

function loadIndex () {
  if (index) return index
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error('INDEX_MISSING')
  }
  const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
  index = Object.entries(raw.items)
    .map(([id, name]) => ({ id: Number(id), name, key: name.toLowerCase().replace(/[\s　]/g, '') }))
    .sort((a, b) => a.id - b.id)
  logger.info(`[market] 物品索引已载入：${index.length} 条`)
  return index
}

/** 名字 → 候选。exact 命中直接返回；否则按 精确 / 前缀 / 包含 排序 */
function searchItem (query) {
  const list = loadIndex()
  const q = query.toLowerCase().replace(/[\s　]/g, '')
  if (!q) return { type: 'none' }

  const exact = []
  const prefix = []
  const contains = []
  for (const it of list) {
    if (it.name === query) exact.push(it)
    else if (it.key === q) exact.push(it)
    else if (it.key.startsWith(q)) prefix.push(it)
    else if (it.key.includes(q)) contains.push(it)
  }

  if (exact.length === 1) return { type: 'one', item: exact[0] }
  if (exact.length > 1) return { type: 'many', list: exact.slice(0, 8) }

  const all = [...prefix, ...contains]
  if (!all.length) return { type: 'none' }
  // 前缀优先，其次名字越短越可能正是想要的
  all.sort((a, b) => (a.key.length - b.key.length) || (a.id - b.id))
  if (all.length === 1) return { type: 'one', item: all[0] }
  return { type: 'many', list: all.slice(0, 8) }
}

/* ───────────────────────── 索引重建 ───────────────────────── */

/**
 * Item.csv → Map<id, 中文名>；keep 非空时只保留其中的 id（省内存）
 *
 * ⚠️ 必须用字符状态机，不能按 \n 切行：
 *    Description 字段里有引号包裹的换行，例如
 *      4564,"解毒药",0,"",0,0,1,0,0,"净化毒素的药品。
 *      ↑ 这一行在引号内就被 \n 断开，按行解析会丢整条记录
 *    实测按行切只解析出 13124 条，状态机 16845 条（与 /marketable 完全一致）。
 *
 * 列信息：第 1 条记录是数字序号、第 2 条是字段名、第 3 条是类型，数据从第 4 条开始。
 *    key 在第 1 列，Name 在名字叫 Name 的那一列（当前是第 11 列，下标 10）。
 */
function parseItemCsv (text, keep) {
  const items = new Map()
  let nameCol = -1
  let record = 0        // 已完成的记录数
  let col = 0
  let field = ''
  let quoted = false
  let id = 0
  let idOk = false
  let name = null
  let keepField = false // 当前列要不要收集（省掉 92 列里 90 列的字符串拼接）

  const needCol = () => record === 1 || (record >= 3 && (col === 0 || col === nameCol))

  const endField = () => {
    if (record === 1 && field === 'Name') nameCol = col
    else if (record >= 3) {
      if (col === 0) { id = Number(field); idOk = /^\d+$/.test(field) } else if (col === nameCol) name = field
    }
    col++
    field = ''
    keepField = needCol()
  }

  const endRecord = () => {
    endField()   // 行尾那个字段没人提交，必须先收尾（否则最后一列永远读不到）
    if (record >= 3 && idOk && name) {
      const nm = name.trim()
      if (nm && (!keep || keep.has(id))) items.set(id, nm)
    }
    record++
    col = 0
    field = ''
    id = 0
    idOk = false
    name = null
    keepField = needCol()
  }

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (quoted) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) { if (keepField) field += '"'; i++ } // "" → "
        else quoted = false
      } else if (keepField) field += text[i]
    } else if (c === 34) quoted = true
    else if (c === 44) endField()      // ,
    else if (c === 10) endRecord()     // \n
    else if (c !== 13 && keepField) field += text[i]
  }
  if (field || col) endRecord()

  if (nameCol < 0) throw new Error('CSV_NO_NAME_COL')
  return items
}

async function fetchMarketable () {
  const res = await fetch(`${API}/marketable`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error(`MARKETABLE_HTTP_${res.status}`)
  const list = await res.json()
  if (!Array.isArray(list) || list.length < 1000) throw new Error('MARKETABLE_BAD')
  return new Set(list.map(Number))
}

async function downloadCsv () {
  const errs = []
  for (const url of CSV_MIRRORS) {
    const host = new URL(url).host
    const t0 = Date.now()
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(CSV_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP_${res.status}`)
      const text = await res.text()
      if (text.length < 5e6) throw new Error(`TOO_SMALL(${text.length})`)
      return { text, mirror: host, bytes: Buffer.byteLength(text), ms: Date.now() - t0 }
    } catch (err) {
      errs.push(`${host}: ${err.message}`)
      logger.warn(`[market] CSV 镜像失败 ${host}：${err.message}`)
    }
  }
  throw new Error(`CSV_ALL_MIRRORS_FAILED (${errs.join(' | ')})`)
}

/** 从 GitHub 提交信息里读上游版本号（ver 2026.09.01.0000.0000）；失败不影响重建 */
async function fetchUpstreamVersion () {
  try {
    const res = await fetch('https://api.github.com/repos/thewakingsands/ffxiv-datamining-cn/commits?path=Item.csv&per_page=1', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return 'unknown'
    const d = await res.json()
    const m = String(d?.[0]?.commit?.message || '').match(/ver\s+([\d.]+)/i)
    return m ? m[1].replace(/(?:\.0+)+$/, '') : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function rebuildIndex () {
  if (globalThis.__marketUpdating) throw new Error('UPDATING')
  globalThis.__marketUpdating = true
  const t0 = Date.now()
  const tmp = `${INDEX_FILE}.tmp`
  try {
    const marketable = await fetchMarketable()
    const dl = await downloadCsv()
    const items = parseItemCsv(dl.text, marketable)
    if (items.size < 5000) throw new Error(`PARSE_TOO_FEW(${items.size})`)
    const gameVersion = await fetchUpstreamVersion()

    const body = {
      _note: '国服可交易物品中文名索引，来源 thewakingsands/ffxiv-datamining-cn + universalis /marketable',
      _gameVersion: gameVersion,
      _builtAt: new Date().toISOString().slice(0, 10),
      items: Object.fromEntries([...items].sort((a, b) => a[0] - b[0]))
    }
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8')
    fs.renameSync(tmp, INDEX_FILE)   // 原子替换，写坏了也不会毁掉旧索引
    index = null                     // 下次查询自动重载，不用重启
    const after = loadIndex().length
    return { after, bytes: dl.bytes, mirror: dl.mirror, dlMs: dl.ms, totalMs: Date.now() - t0, gameVersion }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch {}
    globalThis.__marketUpdating = false
  }
}

/** 比对 /marketable 与本地索引，只有出现新物品才重建 */
async function checkIndexUpdate () {
  let have
  try { have = new Set(loadIndex().map(x => x.id)) } catch { have = new Set() }
  const marketable = await fetchMarketable()
  const missing = [...marketable].filter(id => !have.has(id))
  const removed = [...have].filter(id => !marketable.has(id))
  if (!missing.length) return { changed: false, after: have.size, removed: removed.length }
  const r = await rebuildIndex()
  return { changed: true, added: missing.length, removed: removed.length, ...r }
}

/** 启动后 5 分钟自检一次，之后每 7 天一次（热重载会替换旧定时器） */
function scheduleIndexCheck () {
  const prev = globalThis.__marketIndexTimer
  if (prev) {
    clearTimeout(prev.first)
    clearInterval(prev.loop)
  }
  const run = async tag => {
    if (globalThis.__marketUpdating) return
    try {
      const r = await checkIndexUpdate()
      if (r.changed) logger.info(`[market] ${tag}新增 ${r.added} 个物品，已重建 → ${r.after} 条（${r.mirror}, ${r.dlMs}ms）`)
      else logger.info(`[market] ${tag}索引无需更新（${r.after} 条）`)
    } catch (err) {
      logger.warn(`[market] ${tag}失败：${err.message}`)
    }
  }
  const first = setTimeout(() => run('启动自检：'), CHECK_FIRST_DELAY_MS)
  const loop = setInterval(() => run('每周自检：'), CHECK_INTERVAL_MS)
  first.unref?.()
  loop.unref?.()
  globalThis.__marketIndexTimer = { first, loop }
}

/* ───────────────────────── 区服列表 ───────────────────────── */

async function getWorlds () {
  if (worlds.list && Date.now() - worlds.at < WORLD_TTL_MS) return worlds.list
  try {
    const [dcs, ws] = await Promise.all([
      fetchJson(`${API}/data-centers`),
      fetchJson(`${API}/worlds`)
    ])
    const nameById = new Map(ws.map(w => [w.id, w.name]))
    const list = []
    for (const dc of dcs) {
      if (dc.region !== REGION && dc.region !== 'China') continue
      for (const id of dc.worlds) {
        const name = nameById.get(id)
        if (name && !list.some(x => x.name === name)) list.push({ name, dc: dc.name })
      }
    }
    if (list.length >= 20) {
      worlds = { at: Date.now(), list }
      return list
    }
  } catch (err) {
    logger.warn(`[market] 区服列表拉取失败，用内置列表：${err.message}`)
  }
  const list = Object.entries(FALLBACK_WORLDS)
    .flatMap(([dc, names]) => names.map(name => ({ name, dc })))
  worlds = { at: Date.now(), list }
  return list
}

async function fetchJson (url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Yunzai-Bot/1.0 (FF14 market plugin)' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP_${res.status}`)
  return res.json()
}

/* ───────────────────────── 查价 ───────────────────────── */

async function fetchWorld (world, itemId) {
  const url = `${API}/${encodeURIComponent(world.name)}/${itemId}?listings=12&entries=0`
  const d = await fetchJson(url)
  const ls = Array.isArray(d.listings) ? d.listings : []
  const nq = ls.filter(x => !x.hq)
  const hq = ls.filter(x => x.hq)

  // 该价位能立刻买到的数量（只统计已拉回的 12 条，够用来判断"有几组"）
  const qtyAt = (arr, price) => price == null
    ? 0
    : arr.filter(x => x.pricePerUnit === price).reduce((n, x) => n + (x.quantity || 0), 0)

  const nqMin = d.minPriceNQ ?? (nq.length ? Math.min(...nq.map(x => x.pricePerUnit)) : null)
  const hqMin = d.minPriceHQ ?? (hq.length ? Math.min(...hq.map(x => x.pricePerUnit)) : null)

  return {
    world: world.name,
    dc: world.dc,
    nqMin,
    nqQty: qtyAt(nq, nqMin),
    hqMin,
    hqQty: qtyAt(hq, hqMin),
    units: d.unitsForSale || 0,
    upload: d.lastUploadTime || 0,
    hasData: d.hasData !== false
  }
}

async function queryPrices (itemId) {
  const cached = priceCache.get(itemId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows
  if (inflight.has(itemId)) return inflight.get(itemId)

  const job = (async () => {
    const list = await getWorlds()
    let failed = 0
    const rows = await mapLimit(list, CONCURRENCY, async world => {
      try {
        return await fetchWorld(world, itemId)
      } catch (err) {
        failed++
        return { world: world.name, dc: world.dc, nqMin: null, hqMin: null, units: 0, upload: 0, error: err.message }
      }
    })
    // 偶发超时的服再补一轮，避免因为几台服务器抖动就少显示几个区
    const broken = rows.filter(r => r.error)
    if (broken.length && broken.length < list.length) {
      failed -= broken.length
      await mapLimit(broken, 5, async row => {
        try {
          const again = await fetchWorld({ name: row.world, dc: row.dc }, itemId)
          Object.assign(row, again, { error: undefined })
        } catch {
          failed++
        }
      })
    }
    if (failed && failed === list.length) throw new Error('ALL_FAILED')
    priceCache.set(itemId, { at: Date.now(), rows })
    return rows
  })()

  inflight.set(itemId, job)
  try {
    return await job
  } finally {
    inflight.delete(itemId)
  }
}

/* ───────────────────────── 输出 ───────────────────────── */

function buildText (item, rows, hqMode, note) {
  const key = hqMode ? 'hqMin' : 'nqMin'
  const qtyKey = hqMode ? 'hqQty' : 'nqQty'
  const label = hqMode ? 'HQ' : 'NQ'

  const avail = rows.filter(r => r[key] != null && r[key] > 0)
  if (!avail.length) {
    return `【${item.name}】中国区没有任何${label}挂单`
  }

  avail.sort((a, b) => a[key] - b[key])
  const top = avail.slice(0, TOP_N)

  const totalUnits = rows.reduce((n, r) => n + (r.units || 0), 0)
  const newest = Math.max(...rows.map(r => r.upload || 0))
  const avg = Math.round(avail.reduce((n, r) => n + r[key], 0) / avail.length)

  const lines = [`📦 ${item.name}　·　${label}　·　中国区`, `最便宜的 ${top.length} 个服务器：`]

  top.forEach((r, i) => {
    const other = hqMode ? r.nqMin : r.hqMin
    const otherTag = other != null && other !== r[key] ? `　${hqMode ? 'NQ' : 'HQ'} ${fmtGil(other)}` : ''
    lines.push(
      `${i + 1}. ${pad(`${r.world}（${r.dc}）`, 19)}` +
      pad(fmtGil(r[key]) + ' 金', 11) +
      pad('×' + (r[qtyKey] || 1), 6) +
      `在售 ${r.units}${otherTag}`
    )
  })

  const minRow = top[0]
  lines.push('')
  lines.push(`全区最低 ${fmtGil(minRow[key])} 金（${minRow.world}）· 有货 ${avail.length}/${rows.length} 服`)
  lines.push(`各服最低价均值 ${fmtGil(avg)} 金 · 在售合计 ${totalUnits} 个（含 NQ/HQ）· 最近上传 ${fmtAgo(newest)}`)
  if (note) lines.push(note)
  lines.push('数据来源：Universalis · 玩家上传的实时挂单')
  return lines.join('\n')
}

/* ───────────────────────── 插件 ───────────────────────── */

export class market extends plugin {
  constructor () {
    super({
      name: 'FF14物价查询',
      dsc: '查国服物品在各大区服的最低挂单价与数量',
      event: 'message',
      rule: [
        { reg: '^#市场更新(?:\\s+(?:强制|force))?$', fnc: 'updateIndex', permission: 'admin' },
        { reg: '^#市场\\s+(.+)$', fnc: 'query' },
        { reg: '^#市场$', fnc: 'usage' }
      ]
    })
    scheduleIndexCheck()
  }

  async usage () {
    await this.e.reply([
      '用法：#市场 <物品名> [hq]',
      '例：#市场 优纯银锭',
      '　　#市场 优纯银锭 hq　（按 HQ 价排序）',
      '　　#市场 44148　　　　（直接用物品 ID）',
      '输出国服最便宜的 5 个服务器：挂单价 × 该价可买数量、该服在售总量',
      '管理员：#市场更新（有新物品才下载）/ #市场更新 强制'
    ].join('\n'))
    return true
  }

  /** 管理员：重建中文物品索引（每周也会自动检查一次） */
  async updateIndex () {
    if (globalThis.__marketUpdating) {
      await this.e.reply('[market] 正在更新中，等这次跑完')
      return true
    }

    const force = /强制|force/i.test(this.e.msg)
    const before = (() => { try { return loadIndex().length } catch { return 0 } })()

    if (!force) {
      // 先比 ID 差集（95KB / 约 3 秒），没新物品就不用下 19MB
      try {
        const marketable = await fetchMarketable()
        const have = new Set((() => { try { return loadIndex() } catch { return [] } })().map(x => x.id))
        const missing = [...marketable].filter(id => !have.has(id))
        if (!missing.length) {
          await this.e.reply(`[market] 索引已是最新：${have.size} 条，可交易物品无新增。\n要无条件重建用「#市场更新 强制」`)
          return true
        }
        await this.e.reply(`[market] 发现 ${missing.length} 个新物品，开始重建（下载 19MB，约 30~60 秒）…`)
      } catch (err) {
        await this.e.reply(`[market] 比对失败，直接尝试重建：${String(err.message).slice(0, 80)}`)
      }
    } else {
      await this.e.reply('[market] 强制重建索引（下载 19MB，约 30~60 秒）…')
    }

    try {
      const r = await rebuildIndex()
      const delta = r.after - before
      await this.e.reply([
        '[market] 索引重建完成',
        `条数 ${before} → ${r.after}${delta ? `（${delta > 0 ? '+' : ''}${delta}）` : '（无变化）'}`,
        `上游版本 ${r.gameVersion} · ${(r.bytes / 1048576).toFixed(1)}MB / ${(r.dlMs / 1000).toFixed(0)}s（${r.mirror}）`,
        '已生效，不用重启'
      ].join('\n'))
    } catch (err) {
      logger.error(`[market] 索引重建失败：${err.stack || err.message}`)
      await this.e.reply(`[market] 重建失败，旧索引未动：${String(err.message).slice(0, 160)}`)
    }
    return true
  }

  async query () {
    let raw = this.e.msg.replace(/^#市场\s+/, '').trim()
    const hqMode = /(?:\s|^)hq$/i.test(raw)
    if (hqMode) raw = raw.replace(/(?:\s|^)hq$/i, '').trim()
    if (!raw) return this.usage()

    const last = userCd.get(this.e.user_id) || 0
    if (Date.now() - last < USER_CD_MS) {
      await this.e.reply(`查太勤了，${Math.ceil((USER_CD_MS - (Date.now() - last)) / 1000)} 秒后再试`)
      return true
    }

    let item = null
    try {
      if (/^\d+$/.test(raw)) {
        const id = Number(raw)
        const hit = loadIndex().find(x => x.id === id)
        item = hit || { id, name: `物品 #${id}` }
      } else {
        const found = searchItem(raw)
        if (found.type === 'one') {
          item = found.item
        } else if (found.type === 'many') {
          await this.e.reply([
            `「${raw}」有 ${found.list.length} 个匹配，说准确点：`,
            ...found.list.map(x => `· ${x.name}`)
          ].join('\n'))
          return true
        }
      }
    } catch (err) {
      if (String(err.message) === 'INDEX_MISSING') {
        await this.e.reply('[market] 缺少 plugins/example/data/market-items.json 物品索引，无法把名字转成 ID')
        return true
      }
      throw err
    }

    if (!item) {
      await this.e.reply(`没找到「${raw}」。只能查可交易物品，名字要跟游戏内完全一致（例：优纯银锭）`)
      return true
    }

    userCd.set(this.e.user_id, Date.now())

    try {
      const rows = await queryPrices(item.id)
      // NQ 无货时自动改用 HQ（灵砂这类只有 HQ 的物品很常见），反之亦然
      const hasNq = rows.some(r => r.nqMin != null && r.nqMin > 0)
      const hasHq = rows.some(r => r.hqMin != null && r.hqMin > 0)
      let useHq = hqMode
      let note = ''
      if (!hqMode && !hasNq && hasHq) {
        useHq = true
        note = '＊ NQ 没有任何挂单，已自动按 HQ 显示'
      } else if (hqMode && !hasHq && hasNq) {
        useHq = false
        note = '＊ HQ 没有任何挂单，已自动按 NQ 显示'
      }
      await this.e.reply(buildText(item, rows, useHq, note))
      return true
    } catch (err) {
      logger.error(`[market] 查询失败：${err.stack || err.message}`)
      const tip = String(err.message) === 'ALL_FAILED'
        ? 'Universalis 全部服务器都请求失败，稍后再试'
        : String(err.message).slice(0, 120)
      await this.e.reply(`[market] 查询失败：${tip}`)
      return true
    }
  }
}
