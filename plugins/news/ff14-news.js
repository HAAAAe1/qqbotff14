import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * FF14 国服公告推送（数据源：盛趣官方资讯接口 cqnews.web.sdo.com）
 *
 * 命令
 *   #开启ff14新闻推送     订阅当前会话（群/私聊各自独立）
 *   #关闭ff14新闻推送     退订当前会话
 *   #查看ff14最近新闻     立刻看最近 5 条（不订阅也能用）
 *
 * 推送：每两小时的第 10 分钟拉一次，有新增就合并转发到所有订阅会话。
 * 查看：同样走合并转发，第 1 个节点写来源，之后每条公告一个节点。
 *   转发失败一律回退纯文本，不会因为转发不支持就发不出去。
 *
 * ── 接口说明（从官网 SPA 的 webpack chunk 里逆出来的） ──
 *   GET https://cqnews.web.sdo.com/api/news/newsList
 *       ?gameCode=ff&CategoryCode=8324,8325&pageIndex=0&pageSize=50
 *     Id           整数主键，去重就靠它
 *     CategoryCode 分类（见下面 CATEGORIES）
 *     Title        标题
 *     PublishDate  '2026/10/23 14:16:06' 已经是北京时间，字符串排序 == 时间排序
 *     OutLink      非空=外链活动页，空=站内详情页
 *     HomeImagePath 配图
 *     Summary      注意：等于 '333' 的是官网自己隐藏的占位条目，要跳过
 *
 *   GET https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=<Id>
 *     多一个 Content 字段（HTML 正文）。推送不抓它，只给标题+链接。
 *
 * ⚠️ 接口不需要 cookie / Referer / UA，裸请求就能通。
 * ⚠️ 返回顺序**不按时间**（有 SortIndex 人工置顶），所以一律自己按 PublishDate 重排。
 * ⚠️ 判断「有没有新」只能用 Id 差集，不能取第一条比对。
 */

const API_LIST = 'https://cqnews.web.sdo.com/api/news/newsList'
/** 按插件文件自身位置找数据目录，跟着插件走，不依赖 cwd 和安装目录 */
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/ff14-news.json')

/**
 * 订阅的分类（2026-10-28 按用户要求扩到 5310）。
 *   8324 公告·暂停/问题说明（91 条）
 *   8325 公告·开启/恢复（12 条）
 *   5310 最新情报·版本更新/季节活动/联动/商城周边（613 条）
 * 5311 运营活动、5312 违规处罚/客服 仍然没要。
 *
 * 实测混合请求的返回不是按时间排的（按分类分组），pageSize=50 时
 * 5310 占约 30 个名额、公告占约 20 个，最新公告不会被挤出窗口。
 */
const CATEGORIES = '8324,8325,5310'

const SITE = 'https://ff.web.sdo.com/web8/index.html#/newstab/newscont/'
const SOURCE = '数据来源：盛趣游戏《最终幻想14》国服官方网站'

const TIMEOUT_MS = 20000
const CACHE_TTL_MS = 60000      // 接口结果内存缓存 60 秒
const MAX_SEEN = 400            // 去重表最多记多少条，超出按时间裁掉旧的
const PUSH_LIMIT = 8            // 一次最多推几条，多出来的只提示
const VIEW_COUNT = 5            // #查看 显示几条
const VIEW_COOLDOWN_MS = 30000  // #查看 的冷却

/** 接口结果缓存（模块级，进程内） */
let cache = { at: 0, list: null }
/** #查看 的冷却记录：会话键 → 上次时间 */
const viewCooldown = new Map()

export default class Ff14News extends plugin {
  constructor () {
    super({
      name: 'FF14国服公告推送',
      dsc: '订阅盛趣官方公告，有新公告自动推送到群/私聊',
      event: 'message',
      priority: 3000,
      rule: [
        { reg: '^#开启[fF][fF]14新闻推送$', fnc: 'enable' },
        { reg: '^#关闭[fF][fF]14新闻推送$', fnc: 'disable' },
        { reg: '^#查看[fF][fF]14最近新闻$', fnc: 'viewNews' }
      ]
    })
    this.task = [{
      name: 'FF14国服公告推送',
      cron: '10 */2 * * *',
      fnc: () => this.pushAll()
    }]
  }

  /* ───────────────────────── 存储 ───────────────────────── */

  load () {
    try {
      const obj = JSON.parse(fs.readFileSync(DATA, 'utf8'))
      if (!Array.isArray(obj.subs)) obj.subs = []
      if (!obj.seen || typeof obj.seen !== 'object') obj.seen = {}
      if (typeof obj.seenInited !== 'boolean') obj.seenInited = false
      return obj
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error(`[ff14-news] 读取订阅文件失败: ${err.message}`)
      return { subs: [], seen: {}, seenInited: false }
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
  chatKey (e) {
    return e.isPrivate ? `private:${e.user_id}` : `group:${e.group_id}`
  }

  /** 去重表超过上限就按时间裁掉最旧的 */
  trimSeen (data) {
    const keys = Object.keys(data.seen)
    if (keys.length <= MAX_SEEN) return
    const sorted = keys.sort((a, b) => String(data.seen[b]).localeCompare(String(data.seen[a])))
    for (const k of sorted.slice(MAX_SEEN)) delete data.seen[k]
  }

  /* ───────────────────────── 取数 ───────────────────────── */

  /**
   * 拉公告列表，按 PublishDate 倒序。
   * @param {number} size 要几条
   * @param {boolean} force 跳过 60 秒内存缓存
   */
  async fetchList (size = 40, force = false) {
    if (!force && cache.list && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.list.slice(0, size)
    }
    const url = `${API_LIST}?gameCode=ff&CategoryCode=${CATEGORIES}&pageIndex=0&pageSize=${Math.max(size, 20)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (String(json.Code) !== '0') throw new Error(json.Message || `Code ${json.Code}`)

    const list = (json.Data || [])
      .filter(x => x && x.Id && x.Title)
      .filter(x => String(x.Summary || '') !== '333')      // 官网隐藏的占位条目
      .sort((a, b) => String(b.PublishDate).localeCompare(String(a.PublishDate)))

    cache = { at: Date.now(), list }
    return list.slice(0, size)
  }

  /** OutLink 有值走外链，否则拼站内详情页 */
  linkOf (item) {
    if (item.OutLink) return item.OutLink
    return `${SITE}${item.Id}`
  }

  /** '2026/10/23 14:16:06' → '10-23 14:16' */
  shortTime (s) {
    const m = String(s || '').match(/^\d{4}\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2})/)
    return m ? `${m[1]}-${m[2]} ${m[3]}` : String(s || '')
  }

  /** 转发节点里的一条公告 */
  bubbleOf (item, idx = 0, total = 0) {
    const tag = idx ? `【FF14 公告 · ${idx}/${total}】` : '【FF14 公告】'
    return `${tag}\n${item.Title}\n${this.shortTime(item.PublishDate)}\n${this.linkOf(item)}`
  }

  /** 字符串数组 → 合并转发节点（OneBotv11 适配器认的就是这个格式） */
  toNodes (messages) {
    return messages.map(message => ({
      message,
      nickname: 'FF14国服公告',
      user_id: Number(Bot.uin) || 10000
    }))
  }

  /**
   * 发合并转发。成功 true，失败 false（调用方自己决定怎么回退）。
   * @param {object} target e.group / e.friend / Bot.pickGroup(...) / Bot.pickUser(...)
   * @param {string[]} messages 每个元素一个节点
   */
  async sendForward (target, messages) {
    const send = target?.sendForwardMsg
    if (typeof send !== 'function') return false
    try {
      await send.call(target, this.toNodes(messages))
      return true
    } catch (err) {
      logger.warn(`[ff14-news] 合并转发失败: ${err.message}`)
      return false
    }
  }

  /** 转发发不出去就把所有节点拼成一条纯文本，保证内容不丢 */
  async fallbackText (target, messages) {
    try {
      await target.sendMsg(messages.join('\n\n'))
      return true
    } catch (err) {
      logger.error(`[ff14-news] 纯文本兜底也失败: ${err.message}`)
      return false
    }
  }

  /* ───────────────────────── 命令 ───────────────────────── */

  /** #开启ff14新闻推送 */
  async enable (e) {
    const data = this.load()
    const key = this.chatKey(e)
    if (data.subs.some(s => `${s.type}:${s.id}` === key)) {
      await e.reply('这个会话已经开着 ff14 新闻推送了。')
      return true
    }

    // 顺便拉一次，验证接口通不通，并完成首次静默入库
    let note = ''
    try {
      const list = await this.fetchList(40, true)
      if (!data.seenInited) {
        list.forEach(x => { data.seen[x.Id] = x.PublishDate })
        data.seenInited = true
        this.trimSeen(data)
        note = `\n已把现有 ${list.length} 条公告记为基线，从现在起只推新增的。`
      }
    } catch (err) {
      logger.error(`[ff14-news] 开启时探测接口失败: ${err.message}`)
      note = '\n⚠️ 刚才探测官方接口失败，推送可能不会生效，稍后会自动重试。'
    }

    data.subs.push({
      type: e.isPrivate ? 'private' : 'group',
      id: e.isPrivate ? Number(e.user_id) : Number(e.group_id),
      by: Number(e.user_id),
      at: Date.now()
    })
    this.save(data)
    logger.mark(`[ff14-news] ${key} 开启订阅`)

    await e.reply(`已开启 ff14 公告推送。\n有新公告会在每两小时的第 10 分钟推到这里。${note}\n随时可用「#关闭ff14新闻推送」关掉。`)
    return true
  }

  /** #关闭ff14新闻推送 */
  async disable (e) {
    const data = this.load()
    const key = this.chatKey(e)
    const before = data.subs.length
    data.subs = data.subs.filter(s => `${s.type}:${s.id}` !== key)
    if (data.subs.length === before) {
      await e.reply('这个会话本来就没订阅。')
      return true
    }
    this.save(data)
    logger.mark(`[ff14-news] ${key} 关闭订阅`)
    await e.reply('已关闭 ff14 公告推送。用「#查看ff14最近新闻」还能随时手动看。')
    return true
  }

  /** #查看ff14最近新闻 */
  async viewNews (e) {
    const key = this.chatKey(e)
    const last = viewCooldown.get(key) || 0
    if (Date.now() - last < VIEW_COOLDOWN_MS) {
      await e.reply(`刚查过，${Math.ceil((VIEW_COOLDOWN_MS - (Date.now() - last)) / 1000)} 秒后再试。`)
      return true
    }
    viewCooldown.set(key, Date.now())

    let list
    try {
      list = await this.fetchList(VIEW_COUNT)
    } catch (err) {
      logger.error(`[ff14-news] 查看失败: ${err.message}`)
      await e.reply(`查不到官方公告，接口可能临时不可用（${err.message}）。`)
      return true
    }
    if (!list.length) {
      await e.reply('官方那边暂时没有公告。')
      return true
    }

    const messages = [
      `【FF14 国服公告 · 最近 ${list.length} 条】\n${SOURCE}`,
      ...list.map((x, i) => this.bubbleOf(x, i + 1, list.length))
    ]
    const target = e.group || e.friend || e
    if (!(await this.sendForward(target, messages))) {
      await this.fallbackText(target, messages)
    }
    return true
  }

  /* ───────────────────────── 定时推送 ───────────────────────── */

  async pushAll () {
    const data = this.load()
    if (!data.subs.length) return   // 没人订阅就一次请求都不发

    let list
    try {
      list = await this.fetchList(40, true)
    } catch (err) {
      // 抓不到就原样退出，绝不能动 seen，否则恢复后会整批重推
      logger.error(`[ff14-news] 拉取公告失败，本轮跳过: ${err.message}`)
      return
    }

    // 首次（开启了订阅但基线还没建）只入库不推
    if (!data.seenInited) {
      list.forEach(x => { data.seen[x.Id] = x.PublishDate })
      data.seenInited = true
      this.trimSeen(data)
      this.save(data)
      logger.mark(`[ff14-news] 首次运行，静默入库 ${list.length} 条`)
      return
    }

    const fresh = list.filter(x => !data.seen[x.Id])
    if (!fresh.length) return

    // 先写回 seen 再推送：万一推送失败，也不会下一轮重复刷屏
    fresh.forEach(x => { data.seen[x.Id] = x.PublishDate })
    this.trimSeen(data)
    this.save(data)

    const pushList = fresh.slice(0, PUSH_LIMIT)
    const rest = fresh.length - pushList.length
    const nodes = [
      `【FF14 国服公告】新增 ${fresh.length} 条\n${SOURCE}`
    ]
    for (const item of pushList) nodes.push(this.bubbleOf(item))
    if (rest > 0) nodes.push(`另有 ${rest} 条没列出，用「#查看ff14最近新闻」看最新的。`)

    let ok = 0
    for (const s of data.subs) {
      const target = s.type === 'private'
        ? Bot.pickUser(String(s.id))
        : Bot.pickGroup(Number(s.id))
      let sent = await this.sendForward(target, nodes)
      if (!sent) sent = await this.fallbackText(target, nodes)
      if (sent) ok++
    }
    logger.mark(`[ff14-news] 推送 ${fresh.length} 条新公告到 ${ok}/${data.subs.length} 个会话`)
  }
}
