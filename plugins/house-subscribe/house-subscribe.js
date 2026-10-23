import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * FF14 房屋订阅（数据源：艾欧泽亚售楼中心 house.ffxiv.cyou）
 *
 * 命令
 *   #房屋查询订阅 <服务器> [S|M|L]   订阅（谁订的都算数，同一个群里多人互不覆盖）
 *   #房屋查询退订 [服务器]           退掉自己在这个会话的订阅（不写服务器=全退）
 *   #房屋查询订阅列表                主人专属：看全部会话的订阅 + 已封禁的群
 *   #房屋查询 <服务器> [S|M|L]       立即查一次，不订阅（同样是合并转发）
 *   #清除订阅群聊 <群号>             管理员：清掉某个群里所有人的订阅
 *   #清除订阅个人 <QQ号>             管理员：清掉某人的私聊订阅
 *   #禁止订阅 <群号>                 管理员：封禁该群（同时清掉它已有订阅）
 *   #允许订阅 <群号>                 管理员：解除封禁
 *
 * 推送：每晚 21:00，把该会话所有订阅**合并成一条合并转发消息**：
 *   第 1 个气泡写数据来源，之后**每个服务器一个气泡**（同服不同尺寸在气泡内分段）。不 @ 任何人。
 *
 * 限流：不同服务器之间间隔 30 秒才请求下一个；同一服务器 30 秒内复用内存缓存。
 *   所有服务器都取完之后才统一发送（不会边取边发）。
 *
 * ── API 说明（字段含义取自站点前端内置的接口文档） ──
 *   GET https://house.ffxiv.cyou/api/sales?server=<服务器ID>
 *     Area       0 海雾村 / 1 薰衣草苗圃 / 2 高脚孤丘 / 3 白银乡 / 4 穹顶皓天
 *     Slot       小区编号，从 0 开始
 *     ID         房号，从 1 开始
 *     Size       0 S / 1 M / 2 L
 *     Price      当前价格
 *     LastSeen   上次上报时间（unix 秒）
 *     PurchaseType 0 不可购买 / 1 先到先得 / 2 抽签
 *     RegionType   1 仅限部队 / 2 仅限个人
 *
 * ⚠️ 数据是玩家上报的，不是官方接口。站点自己用「LastSeen 距今 > 24 小时 = 可能过时」
 *    标灰，这里沿用同一判据。
 * ⚠️「白银乡」既是服务器名（莫古力区 ID 1172）又是住宅区名（Area=3），订阅的是「服务器」。
 */

const API = 'https://house.ffxiv.cyou/api/sales'
const DATA = path.join(process.cwd(), 'plugins/example/data/house-subscribe.json')

const AREA = { 0: '海雾村', 1: '薰衣草苗圃', 2: '高脚孤丘', 3: '白银乡', 4: '穹顶皓天' }
const SIZE_NAME = { 0: 'S', 1: 'M', 2: 'L' }
const SIZE_FULL = { 0: '小屋', 1: '公馆', 2: '别墅' }
const PURCHASE = { 0: '不可购买', 1: '先到先得', 2: '抽签' }
const REGION = { 1: '部队', 2: '个人' }

/** 出现在转发第一个气泡里的数据来源声明 */
const SOURCE = '数据来源：艾欧泽亚售楼中心（house.ffxiv.cyou）· 玩家上报，非官方数据'

/** 数据超过这个秒数没更新就不算在售（站点同判据） */
const STALE_SEC = 24 * 60 * 60
/** 一个服务器气泡里最多列几套，超出只报个数 */
const MAX_ROWS = 10
/** 接口超时 */
const TIMEOUT_MS = 20000
/** 不同服务器之间的请求间隔（避免短时间频繁请求） */
const FETCH_GAP_MS = 30000
/** 同一服务器在这个时间内复用缓存 */
const CACHE_TTL_MS = 30000

/** 进程内的在售数据缓存：serverId → { at, rows } */
const salesCache = new Map()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 大区 → 服务器（ID 取自站点前端常量表） */
const SERVERS = [
  { area: '陆行鸟', list: [['红玉海', 1167], ['神意之地', 1081], ['拉诺西亚', 1042], ['幻影群岛', 1044], ['萌芽池', 1060], ['宇宙和音', 1173], ['沃仙曦染', 1174], ['晨曦王座', 1175]] },
  { area: '莫古力', list: [['白银乡', 1172], ['白金幻象', 1076], ['神拳痕', 1171], ['潮风亭', 1170], ['旅人栈桥', 1113], ['拂晓之间', 1121], ['龙巢神殿', 1166], ['梦羽宝境', 1176]] },
  { area: '猫小胖', list: [['紫水栈桥', 1043], ['延夏', 1169], ['静语庄园', 1106], ['摩杜纳', 1045], ['海猫茶屋', 1177], ['柔风海湾', 1178], ['琥珀原', 1179]] },
  { area: '豆豆柴', list: [['水晶塔', 1192], ['银泪湖', 1183], ['太阳海岸', 1180], ['伊修加德', 1186], ['红茶川', 1201]] }
]

/** 服务器名 → { id, name, area }；精确 → 前缀 → 包含，三级回退 */
function resolveServer (input) {
  const q = String(input || '').trim().replace(/\s+/g, '')
  if (!q) return null
  const all = SERVERS.flatMap(g => g.list.map(([name, id]) => ({ name, id, area: g.area })))
  let hit = all.find(x => x.name === q)
  if (!hit) hit = all.find(x => x.name.startsWith(q))
  if (!hit) hit = all.find(x => x.name.includes(q))
  return hit || null
}

/** 输入的是不是大区名（豆豆柴/莫古力…） */
function detectArea (input) {
  const q = String(input || '').trim().replace(/\s+/g, '')
  if (!q) return null
  return SERVERS.find(g => g.area === q || q.includes(g.area)) || null
}

/** 找不到服务器时的提示 */
function serverHint (input) {
  const area = detectArea(input)
  if (area) return `「${area.area}」是大区名，请指定具体服务器：${area.list.map(([n]) => n).join('、')}`
  return `没找到服务器「${input}」。国服服务器名例如：白银乡、红玉海、摩杜纳、水晶塔（写前两个字也能认）。`
}

/** 'L' / '大' / '别墅' → 2；不传 → 默认 L */
function parseSize (input) {
  if (input === undefined || input === null || input === '') return 2
  const s = String(input).trim().toUpperCase()
  if (['S', '小', '小屋'].includes(s)) return 0
  if (['M', '中', '公馆'].includes(s)) return 1
  if (['L', '大', '别墅'].includes(s)) return 2
  return null
}

/** 47500000 → 4750万 */
function fmtPrice (p) {
  if (!p) return '价格未知'
  const w = p / 10000
  return `${Number.isInteger(w) ? w : w.toFixed(1)}万`
}

function fmtTime (sec) {
  const d = new Date(sec * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 一条房源的一行文案 */
function houseLine (x) {
  const where = `${AREA[x.Area] ?? `区${x.Area}`} ${Number(x.Slot) + 1}区${x.ID}号`
  const tags = [PURCHASE[x.PurchaseType] || '在售', REGION[x.RegionType]].filter(Boolean).join('·')
  return `· ${where} · ${fmtPrice(x.Price)} · ${tags}`
}

export default class HouseSubscribe extends plugin {
  constructor () {
    super({
      name: 'FF14房屋订阅',
      dsc: '订阅某服务器房屋在售，每晚 21 点合并转发推送',
      event: 'message',
      priority: 3000,
      rule: [
        { reg: '^#禁止订阅\\s*(\\d*)$', fnc: 'banGroup', permission: 'admin' },
        { reg: '^#允许订阅\\s*(\\d*)$', fnc: 'unbanGroup', permission: 'admin' },
        { reg: '^#清除订阅群聊\\s*(\\d*)$', fnc: 'clearGroupSubs', permission: 'admin' },
        { reg: '^#清除订阅个人\\s*(\\d*)$', fnc: 'clearPrivateSubs', permission: 'admin' },
        { reg: '^#房屋查询订阅列表$', fnc: 'listSubs', permission: 'master' },
        { reg: '^#房屋查询退订(?:\\s+(.+))?$', fnc: 'unsubscribe' },
        { reg: '^#房屋查询订阅\\s*(.+)$', fnc: 'subscribe' },
        { reg: '^#房屋查询\\s*(.+)$', fnc: 'queryNow' }
      ]
    })
    this.task = [{
      name: 'FF14房屋订阅推送',
      cron: '0 21 * * *',
      fnc: () => this.pushAll()
    }]
  }

  /* ───────────────────────── 存储 ───────────────────────── */

  load () {
    try {
      const obj = JSON.parse(fs.readFileSync(DATA, 'utf8'))
      if (!Array.isArray(obj.targets)) obj.targets = []
      if (!Array.isArray(obj.banned)) obj.banned = []
      return obj
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error(`[house-sub] 读取订阅文件失败: ${err.message}`)
      return { targets: [], banned: [] }
    }
  }

  save (data) {
    const dir = path.dirname(DATA)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = `${DATA}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, DATA)   // 原子替换
  }

  /** 会话标识：group:群号 / private:QQ */
  chatOf (e) {
    return e.isPrivate ? `private:${e.user_id}` : `group:${e.group_id}`
  }

  /** 订阅唯一键：会话 + 订阅人 + 服务器 + 尺寸（同组重复订只算一条） */
  subKey (t) {
    return `${t.type}:${t.id}:${t.uid}:${t.server}:${t.size}`
  }

  /* ───────────────────────── 取数 ───────────────────────── */

  /** 拉某服务器的在售列表；30 秒内复用缓存，force 可跳过 */
  async fetchSales (serverId, force = false) {
    const hit = salesCache.get(serverId)
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows

    const res = await fetch(`${API}?server=${serverId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) throw new Error('返回格式不是数组')

    salesCache.set(serverId, { at: Date.now(), rows: data })
    return data
  }

  /** 过滤出当前在售：尺寸对 + 可购买 + 24 小时内有上报，按价格升序 */
  pickOnSale (rows, size) {
    const now = Math.floor(Date.now() / 1000)
    return rows
      .filter(x => Number(x.Size) === size)
      .filter(x => Number(x.PurchaseType) !== 0)
      .filter(x => now - Number(x.LastSeen) <= STALE_SEC)
      .sort((a, b) => (a.Price || 0) - (b.Price || 0))
  }

  /* ───────────────────────── 文案 ───────────────────────── */

  /**
   * 一个尺寸的正文（也就是 #房屋查询 直接回的那段）
   * withSource=false 用于转发气泡 —— 来源已在第一个气泡里写过，不必重复
   */
  buildMessage ({ serverName, size, list, total, error, withSource = true }) {
    const src = withSource ? `\n\n${SOURCE}` : ''
    const head = `【FF14房屋 · ${serverName} · ${SIZE_NAME[size]}（${SIZE_FULL[size]}）】`
    if (error) return `${head}\n查询失败：${error}\n\n${SOURCE}`
    if (!list.length) {
      return `${head}\n今天没有在售的 ${SIZE_NAME[size]} 房。\n（判据：站点 24 小时内有上报、且当前可购买）${src}`
    }
    const lines = list.slice(0, MAX_ROWS).map(houseLine)
    if (total > MAX_ROWS) lines.push(`…… 另有 ${total - MAX_ROWS} 套未列出`)
    const newest = Math.max(...list.map(x => Number(x.LastSeen) || 0))
    return `${head}\n在售 ${total} 套：\n${lines.join('\n')}\n（最近上报 ${fmtTime(newest)}；数据来自玩家上报，购买请进游戏）${src}`
  }

  /**
   * 一个服务器 = 一个气泡，内容就是 buildMessage 的原格式。
   * 同服被订了多个尺寸，就把多段用空行拼在一起。
   */
  renderServerBubble (subs, rows) {
    const name = subs[0].serverName
    if (!Array.isArray(rows)) {
      const s = subs[0]
      const tail = s ? ` · ${SIZE_NAME[s.size]}（${SIZE_FULL[s.size]}）` : ''
      return `【FF14房屋 · ${name}${tail}】\n查询失败：${(rows && rows.error) || '未知错误'}`
    }
    const sizes = [...new Set(subs.map(s => s.size))].sort((a, b) => a - b)
    return sizes
      .map(size => {
        const onSale = this.pickOnSale(rows, size)
        return this.buildMessage({ serverName: name, size, list: onSale, total: onSale.length, withSource: false })
      })
      .join('\n\n')
  }

  /** 一个会话的完整转发：来源 → 每服一个气泡 */
  buildForwardNodes (subs, rowsByServer) {
    const serverIds = [...new Set(subs.map(t => t.server))]
    const nodes = [`${SOURCE}`]
    for (const server of serverIds) {
      nodes.push(this.renderServerBubble(
        subs.filter(t => t.server === server),
        rowsByServer.get(server)
      ))
    }
    return nodes
  }

  /**
   * 发合并转发；转发发不出去就回退纯文本。
   * @param {object} send  Bot.pickGroup(...) / Bot.pickUser(...) 的返回值
   * @returns {Promise<boolean>} 是否发成功
   */
  async deliver (send, nodes, tag = '') {
    const suffix = tag ? ` ${tag}` : ''
    try {
      const payload = (typeof Bot.makeForwardArray === 'function')
        ? Bot.makeForwardArray(nodes, { nickname: '艾欧泽亚售楼中心', user_id: Bot.uin })
        : null
      if (payload) {
        await send.sendMsg(payload)
        return true
      }
    } catch (err) {
      logger.error(`[house-sub] 转发送${suffix}失败，回退纯文本: ${err.message}`)
    }
    try {
      await send.sendMsg(nodes.join('\n\n'))
      return true
    } catch (err) {
      logger.error(`[house-sub] 纯文本送${suffix}也失败: ${err.message}`)
      return false
    }
  }

  /* ───────────────────────── 命令 ───────────────────────── */

  /** #房屋查询订阅 白银乡 L */
  async subscribe (e) {
    const data = this.load()

    // 被管理员封禁的群不许订阅
    if (!e.isPrivate && data.banned.includes(String(e.group_id))) {
      return e.reply('本群已被禁止使用房屋订阅。')
    }

    const args = String(this.e.msg).replace(/^#房屋查询订阅\s*/, '').trim()
    if (!args || /^列表$/.test(args)) {
      return e.reply('用法：#房屋查询订阅 <服务器> [S|M|L]，例如「#房屋查询订阅 白银乡 L」')
    }

    const parts = args.split(/\s+/)
    let sizeArg = ''
    let nameArg = args
    if (parts.length >= 2 && parseSize(parts[parts.length - 1]) !== null) {
      sizeArg = parts.pop()
      nameArg = parts.join(' ')
    }

    const server = resolveServer(nameArg)
    if (!server) return e.reply(serverHint(nameArg))
    const size = parseSize(sizeArg)
    if (size === null) return e.reply('尺寸只能是 S / M / L（也可写 小 / 中 / 大）')

    const entry = {
      type: e.isPrivate ? 'private' : 'group',
      id: String(e.isPrivate ? e.user_id : e.group_id),
      uid: String(e.user_id),
      server: server.id,
      serverName: server.name,
      size,
      at: Date.now()
    }
    const existed = data.targets.some(t => this.subKey(t) === this.subKey(entry))
    if (!existed) {
      data.targets.push(entry)
      this.save(data)
    }

    // 顺手报一次现状（不 force，30 秒内复用缓存）
    let tail = ''
    try {
      const rows = await this.fetchSales(server.id)
      const onSale = this.pickOnSale(rows, size)
      tail = onSale.length
        ? `\n现在有 ${onSale.length} 套在售，最便宜的是 ${fmtPrice(onSale[0].Price)}（${AREA[onSale[0].Area] ?? '未知区'} ${Number(onSale[0].Slot) + 1}区${onSale[0].ID}号，${PURCHASE[onSale[0].PurchaseType] || '在售'}${onSale[0].RegionType ? '·' + REGION[onSale[0].RegionType] : ''}）`
        : `\n现在没有在售的 ${SIZE_NAME[size]} 房。`
    } catch (err) {
      tail = `\n（顺手查了一次但失败：${err.message}）`
    }

    return e.reply(
      `${existed ? '你已经在订了，不用重复订。' : '已订阅。'}` +
      `${server.name}（${server.area}区）的 ${SIZE_NAME[size]}（${SIZE_FULL[size]}）房，每晚 21:00 合并推送到这里。${tail}\n` +
      '取消发 #房屋查询退订；看本会话订阅发 #房屋查询订阅列表'
    )
  }

  /** #房屋查询退订 [服务器] —— 只退自己的 */
  async unsubscribe (e) {
    const arg = (this.e.msg.match(/^#房屋查询退订\s+(.+)$/) || [])[1]
    const data = this.load()
    const chat = this.chatOf(e)
    const mine = data.targets.filter(t => `${t.type}:${t.id}` === chat && String(t.uid) === String(e.user_id))
    if (!mine.length) return e.reply('你在这里没有订阅。')

    let killed = mine
    let label = '全部'
    if (arg) {
      const server = resolveServer(arg.trim())
      if (!server) return e.reply(serverHint(arg.trim()))
      killed = mine.filter(t => t.server === server.id)
      label = server.name
      if (!killed.length) return e.reply(`你没在这里订过 ${server.name}。`)
    }

    const keys = new Set(killed.map(t => this.subKey(t)))
    data.targets = data.targets.filter(t => !keys.has(this.subKey(t)))
    this.save(data)
    return e.reply(`已退订：${label}（共 ${killed.length} 条）。`)
  }

  /** #房屋查询订阅列表 */
  async listSubs (e) {
    const data = this.load()
    const out = []

    if (data.targets.length) {
      const byChat = new Map()
      for (const t of data.targets) {
        const k = `${t.type}:${t.id}`
        if (!byChat.has(k)) byChat.set(k, [])
        byChat.get(k).push(t)
      }
      const fmt = t => `· ${t.uid} → ${t.serverName} ${SIZE_NAME[t.size]}`
      const blocks = [...byChat].map(([k, list]) => {
        const [type, id] = k.split(':')
        const head = type === 'group' ? `群 ${id}` : `私聊 ${id}`
        return `【${head}】\n${list.map(fmt).join('\n')}`
      })
      out.push(`全部订阅 ${data.targets.length} 条，共 ${byChat.size} 个会话：\n\n${blocks.join('\n\n')}`)
    } else {
      out.push('目前没有任何订阅。')
    }

    if (data.banned.length) {
      out.push(`已禁止订阅的群（${data.banned.length} 个）：\n${data.banned.map(g => `· ${g}`).join('\n')}`)
    }

    return e.reply(out.join('\n\n──────────\n\n'))
  }

  /** #清除订阅群聊 <群号> —— 清掉这个群里所有人的订阅 */
  async clearGroupSubs (e) {
    const m = String(this.e.msg).match(/(\d+)/)
    if (!m) return e.reply('用法：#清除订阅群聊 <群号>')

    const gid = m[1]
    const data = this.load()
    const before = data.targets.length
    data.targets = data.targets.filter(t => !(t.type === 'group' && String(t.id) === gid))
    const removed = before - data.targets.length
    if (!removed) return e.reply(`群 ${gid} 没有任何订阅。`)

    this.save(data)
    logger.mark(`[house-sub] 清除了群 ${gid} 的全部订阅 ${removed} 条`)
    return e.reply(`已清除群 ${gid} 的订阅 ${removed} 条（所有人的）。`)
  }

  /** #清除订阅个人 <QQ号> —— 清掉这个人的私聊订阅 */
  async clearPrivateSubs (e) {
    const m = String(this.e.msg).match(/(\d+)/)
    if (!m) return e.reply('用法：#清除订阅个人 <QQ号>')

    const qq = m[1]
    const data = this.load()
    const before = data.targets.length
    data.targets = data.targets.filter(t => !(t.type === 'private' && String(t.uid) === qq))
    const removed = before - data.targets.length
    if (!removed) return e.reply(`${qq} 没有私聊订阅。`)

    this.save(data)
    logger.mark(`[house-sub] 清除了 ${qq} 的私聊订阅 ${removed} 条`)
    return e.reply(`已清除 ${qq} 的私聊订阅 ${removed} 条。`)
  }

  /** #禁止订阅 <群号> —— 封禁该群，并清掉它已有订阅 */
  async banGroup (e) {
    const m = String(this.e.msg).match(/(\d+)/)
    if (!m) return e.reply('用法：#禁止订阅 <群号>')

    const gid = m[1]
    const data = this.load()
    const added = !data.banned.includes(gid)
    if (added) data.banned.push(gid)

    const before = data.targets.length
    data.targets = data.targets.filter(t => !(t.type === 'group' && String(t.id) === gid))
    const removed = before - data.targets.length
    this.save(data)

    logger.mark(`[house-sub] 封禁群 ${gid}，清除其订阅 ${removed} 条`)
    return e.reply(
      `${added ? '已禁止' : '本来就已经禁止'}群 ${gid} 使用房屋订阅` +
      (removed ? `，并清除了它原有的 ${removed} 条订阅。` : '。') +
      `\n解除发 #允许订阅 ${gid}`
    )
  }

  /** #允许订阅 <群号> —— 解除封禁（不会恢复已清除的订阅） */
  async unbanGroup (e) {
    const m = String(this.e.msg).match(/(\d+)/)
    if (!m) return e.reply('用法：#允许订阅 <群号>')

    const gid = m[1]
    const data = this.load()
    if (!data.banned.includes(gid)) return e.reply(`群 ${gid} 没有被禁止订阅。`)

    data.banned = data.banned.filter(g => g !== gid)
    this.save(data)
    logger.mark(`[house-sub] 解除封禁群 ${gid}`)
    return e.reply(`已解除对群 ${gid} 的封禁，它可以重新订阅了（之前的订阅不会自动恢复）。`)
  }

  /** #房屋查询 白银乡 L —— 立即查一次 */
  async queryNow (e) {
    const args = String(this.e.msg).replace(/^#房屋查询\s*/, '').trim()
    if (!args) return e.reply('用法：#房屋查询 <服务器> [S|M|L]，例如「#房屋查询 白银乡」')

    const parts = args.split(/\s+/)
    let sizeArg = ''
    let nameArg = args
    if (parts.length >= 2 && parseSize(parts[parts.length - 1]) !== null) {
      sizeArg = parts.pop()
      nameArg = parts.join(' ')
    }

    const server = resolveServer(nameArg)
    if (!server) return e.reply(serverHint(nameArg))
    const size = parseSize(sizeArg)
    if (size === null) return e.reply('尺寸只能是 S / M / L')

    const rowsByServer = new Map()
    let rows = null
    let error = ''
    try {
      rows = await this.fetchSales(server.id)
      rowsByServer.set(server.id, rows)
    } catch (err) {
      error = err.message
      rowsByServer.set(server.id, { error })
    }

    // 和每晚推送一样的形态：来源气泡 + 该服务器气泡
    const nodes = this.buildForwardNodes(
      [{ server: server.id, serverName: server.name, size }],
      rowsByServer
    )
    const send = e.isPrivate
      ? Bot.pickUser(String(e.user_id))
      : Bot.pickGroup(Number(e.group_id))

    if (await this.deliver(send, nodes, `query ${server.name}`)) return true

    // 转发与纯文本都发不出去时，再用 e.reply 兜一次
    const onSale = rows ? this.pickOnSale(rows, size) : []
    return e.reply(this.buildMessage({ serverName: server.name, size, list: onSale, total: onSale.length, error }))
  }

  /* ───────────────────────── 定时推送 ───────────────────────── */

  /**
   * 每晚 21:00
   * 1) 按会话分组
   * 2) 逐个服务器取数，**不同服务器之间隔 30 秒**（同一个服只请求一次）
   * 3) 全部取完再统一发送，每条是该会话所有订阅合并后的转发消息
   */
  async pushAll () {
    const data = this.load()
    if (!data.targets.length) return

    const byChat = new Map()
    const banned = new Set(data.banned.map(String))
    for (const t of data.targets) {
      // 双保险：封禁时已经清过订阅，这里再挡一次，防止历史残留继续推
      if (t.type === 'group' && banned.has(String(t.id))) continue
      const k = `${t.type}:${t.id}`
      if (!byChat.has(k)) byChat.set(k, [])
      byChat.get(k).push(t)
    }

    const serverIds = [...new Set(data.targets.map(t => t.server))]
    const rowsByServer = new Map()
    const t0 = Date.now()
    logger.mark(`[house-sub] 开始取数：${serverIds.length} 个服务器，间隔 ${FETCH_GAP_MS / 1000}s`)

    for (let i = 0; i < serverIds.length; i++) {
      if (i > 0) await sleep(FETCH_GAP_MS)
      const id = serverIds[i]
      try {
        rowsByServer.set(id, await this.fetchSales(id, true))
      } catch (err) {
        rowsByServer.set(id, { error: err.message })
        logger.error(`[house-sub] 服务器 ${id} 取数失败: ${err.message}`)
      }
    }
    logger.mark(`[house-sub] 取数完成，用时 ${Math.round((Date.now() - t0) / 1000)}s，开始推送`)

    let sent = 0
    for (const [chatKey, subs] of byChat) {
      const isPrivate = chatKey.startsWith('private:')
      const id = chatKey.slice(chatKey.indexOf(':') + 1)
      const send = isPrivate ? Bot.pickUser(id) : Bot.pickGroup(Number(id))

      const nodes = this.buildForwardNodes(subs, rowsByServer)
      if (await this.deliver(send, nodes, chatKey)) sent++
    }
    logger.mark(`[house-sub] 房屋订阅推送完成：${sent}/${byChat.size} 个会话`)
  }
}
