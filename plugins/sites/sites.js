// sites.js —— FF14 网站导航模糊检索
// 数据源：https://gamecircum.com/games/ff14/（GameCircum 最终幻想14导航站，14 类 / 184 个站点）
//
// 命令
//   #查网站 物价          按需求模糊搜索，返回最相关的几个站点（名称/简介/链接/分类）
//   #查网站               列出全部 14 个分类及各分类站点数
//   #查网站 幻化相关      输入分类名时，直接列出该分类全部站点
//   #更新网站             重新抓取导航站并重建本地索引（仅 bot 管理员）
//
// 数据落盘：data/ff14-sites.json，超过 7 天首次查询时后台静默刷新（不阻塞本次回复）
// 匹配方式：名称精确 / 名称包含 / 描述包含 / 分类包含 / 字覆盖度 / 二元组重合 / 同义词扩展
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.join(__dirname, 'data', 'ff14-sites.json')
const SOURCE = 'https://gamecircum.com/games/ff14/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DATA_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 数据 7 天视为过期
const USER_CD_MS = 5 * 1000                    // 每人 5 秒冷却
const MAX_RESULTS = 6
const MIN_SCORE = 55

/**
 * 同义词 / 口语 → 站点关键词
 * 命中左边任一词，就去站点文本里找右边任一词，找到加分
 */
const SYNONYMS = [
  [['物价', '价格', '多少钱', '贵不贵', '查价'], ['物价', 'universalis', '罗薇娜', '价格']],
  [['配装', 'bis', '毕业装', '禁断', '石头'], ['配装', 'etro', 'gearing', 'teamcraft', 'bis']],
  [['攻略', '打法', '怎么打', '机制', '教学'], ['攻略', '萌神神', 'xivstrat', '素素', '指南']],
  [['豆芽', '小豆芽', '新手', '新人', '萌新'], ['萌新', '新手', '新大陆见闻录', '最终幻想14官方职业指南']],
  [['豆芽', '小豆芽'], ['新大陆见闻录', '萌新实用手册']],   // 豆芽首选 ff14.org，压在并列里排第一
  [['时钟', '几点', '刷新时间', '计时'], ['时钟', 'caiji', '计时', '时刻']],
  [['采集', '挖矿', '园艺'], ['采集', 'caiji', '采集时钟']],
  [['钓鱼', '鱼王', '鱼皇'], ['钓鱼', '鱼糕', 'fish', '鱼王']],
  [['海钓', '航线'], ['海钓', '航线', 'ocean']],
  [['生产', '制作', '配方', '搓东西'], ['配方', '生产', 'hqhelper', 'bestcraft', 'teamcraft']],
  [['狩猎', '狩猎车', 's怪', 'a怪'], ['狩猎', 'hunt']],
  [['房子', '房价', '买房', '房产', '房区'], ['售楼', '房区', 'paissa']],
  [['装修', '家具'], ['装修', 'housing', 'makeplace', '家具']],
  [['幻化', '外观', '衣服', '穿搭'], ['幻化', '收藏家', 'glamour', 'mirapri', 'attire', 'collection']],
  [['mod', '模组', '补丁'], ['mod', 'archive', 'nexus', 'dresser']],
  [['伤害', '输出', 'logs', 'fflogs', '战斗记录', '行车记录仪'], ['act', 'fflogs', 'xivanalysis', 'rdps', '战斗']],
  [['招募', '组队', '找队'], ['招募', 'xivpf', 'pf']],
  [['天气', '天气预报'], ['天气', 'weather']],
  [['地图', '藏宝图', '风脉'], ['地图', 'map', 'where', '藏宝图']],
  [['潜水艇', '潜艇', '部队'], ['潜水艇', 'submarine']],
  [['无人岛', '开拓'], ['无人岛', 'island']],
  [['卡牌', '幻卡', '九宫'], ['幻卡', 'triad', 'card']],
  [['演奏', '弹琴', '诗人'], ['演奏', '弹琴', 'bard']],
  [['汉化', '翻译'], ['汉化', 'chn', '翻译']],
  [['启动器'], ['launcher']],
  [['画质', '滤镜', '补丁'], ['gshade', 'shade', '画质', 'aurora']],
  [['名字', '起名', 'id'], ['名字', 'name']],
  [['pvp', '战场', '水晶冲突', '闸'], ['pvp', '战场', '水晶冲突', '牢房']],
  [['优雷卡', 'ulk', 'bzy'], ['优雷卡', 'eureka']],
  [['青魔'], ['青魔', 'blue']],
  [['成就'], ['成就', 'achievement']],
  [['任务', '任务进度'], ['任务', 'quest']],
  [['理符'], ['理符', 'leve']],
  [['收集', '图鉴', '勾勾本'], ['collect', '图鉴', '收集']],
  [['模拟', '模拟器'], ['模拟', 'sim']],
  [['赚钱', '收益', '计算'], ['收益', '计算', '交易']],
  [['充值', '时长', '点卡'], ['充值', '礼物站', '时长']],
  [['周边', '商城'], ['周边', '商城']],
  [['微博'], ['微博', 'weibo']],
  [['视频', 'up主', 'b站', 'bilibili'], ['bilibili', '视频', 'youtube', 'up']],
  [['资讯', '新闻', '情报'], ['资讯', '速报', 'news']],
  [['官网', '官方'], ['官网', '官方']],
  [['社区', '论坛', '贴吧'], ['社区', '论坛', '贴吧', 'nga']]
]

let cache = null            // { at, list, fetchedAt }
let refreshing = false
const userCd = new Map()

/* ---------------- 抓取与解析 ---------------- */

const decodeEntities = s => String(s)
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&#8217;/g, '’')
  .replace(/&#038;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

async function fetchHtml () {
  const res = await fetch(SOURCE, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** 解析导航站 → [{ cat, name, desc, url }]，按 URL 去重、合并分类 */
function parseSites (html) {
  const chunks = html.split('<div class="module-url-list"').slice(1)
  const byUrl = new Map()

  for (const chunk of chunks) {
    const cat = decodeEntities((chunk.match(/<div class="title">([\s\S]*?)<\/div>/) || [])[1] || '')
    const re = /<a class="url-visit" href="([^"]+)"[^>]*>[\s\S]*?<span class="url-title">([\s\S]*?)<\/span>[\s\S]*?<div class="info">([\s\S]*?)<\/div>/g
    let m
    while ((m = re.exec(chunk))) {
      const url = m[1].trim()
      const name = decodeEntities(m[2])
      const desc = decodeEntities(m[3])
      if (!url || !name) continue
      // 归一化去重：末尾斜杠、大小写不同的同一个地址只留一条
      const key = url.replace(/\/+$/, '').toLowerCase()
      const hit = byUrl.get(key)
      if (hit) {
        if (cat && !hit.cats.includes(cat)) hit.cats.push(cat)
        continue
      }
      byUrl.set(key, { cat, cats: cat ? [cat] : [], name, desc, url })
    }
  }

  const list = [...byUrl.values()].map(s => ({
    cat: s.cats[0] || '未分类',
    cats: s.cats,
    name: s.name,
    desc: s.desc,
    url: s.url
  }))
  return list
}

/* ---------------- 本地数据 ---------------- */

function readFileData () {
  try {
    if (!fs.existsSync(DATA_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    if (!Array.isArray(raw?.sites) || !raw.sites.length) return null
    return raw
  } catch (err) {
    logger.warn(`[sites] 读取本地数据失败：${err.message}`)
    return null
  }
}

function writeFileData (sites) {
  const payload = { source: SOURCE, fetchedAt: Date.now(), count: sites.length, sites }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  const tmp = `${DATA_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
  fs.renameSync(tmp, DATA_FILE)   // 原子替换，写坏也不用旧数据顶着
  return payload
}

/** 给每条记录补齐小写检索文本，避免每次搜索重复拼接 */
function decorate (sites) {
  return sites.map(s => {
    const cats = s.cats?.length ? s.cats : [s.cat]
    return {
      ...s,
      cats,
      lname: s.name.toLowerCase(),
      ldesc: (s.desc || '').toLowerCase(),
      lcat: cats.join(' ').toLowerCase(),
      text: `${s.name} ${s.desc || ''} ${cats.join(' ')}`.toLowerCase()
    }
  })
}

async function rebuild () {
  const html = await fetchHtml()
  const sites = parseSites(html)
  if (!sites.length) throw new Error('解析结果为 0 条，页面结构可能变了')
  const payload = writeFileData(sites)
  cache = { at: Date.now(), fetchedAt: payload.fetchedAt, list: decorate(sites) }
  const cats = new Set(sites.map(s => s.cat)).size
  logger.info(`[sites] 索引已更新：${sites.length} 个站点 / ${cats} 个分类`)
  return cache
}

/** 首次（无本地）必须等待；有本地但过期则返回旧数据并后台刷新 */
async function ensureSites () {
  if (cache && Date.now() - cache.at < DATA_TTL_MS) return cache

  const file = readFileData()
  if (file) {
    cache = { at: 0, fetchedAt: file.fetchedAt, list: decorate(file.sites) }
    if (Date.now() - (file.fetchedAt || 0) > DATA_TTL_MS && !refreshing) {
      refreshing = true
      rebuild().catch(err => logger.warn(`[sites] 后台刷新失败：${err.message}`))
        .finally(() => { refreshing = false })
    }
    cache.at = Date.now()
    return cache
  }

  return rebuild()
}

/* ---------------- 检索 ---------------- */

const PUNCT = /[\s,，。、;；:：!！?？~～·\-—_()（）[\]【】"'“”‘’/\\]/g
const ASCII_ONLY = /^[a-z0-9]+$/
const norm = s => String(s || '').toLowerCase().replace(PUNCT, '')

function bigrams (s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function scoreSite (site, q, qBigrams) {
  let score = 0
  const name = site.lname.replace(PUNCT, '')
  // 纯英文/数字查询（act / fflogs / etro）不能靠"字覆盖度"打分——
  // 26 个字母互相撞得太容易（universalis 会和 xivlauncher 撞一堆），只认子串与整词
  const ascii = ASCII_ONLY.test(q)

  if (name === q) score += 1000
  else if (name.includes(q)) score += 380 + Math.max(0, 120 * (q.length / Math.max(name.length, 1)) - 40)
  if (site.ldesc.includes(q)) score += 175
  if (site.lcat.includes(q)) score += 85

  // 字覆盖度：查询里每个字在站点文本中出现比例（平方，避免长文本占便宜）
  const chars = [...new Set(q)]
  if (!ascii && chars.length) {
    const hit = chars.filter(c => site.text.includes(c)).length
    score += 95 * (hit / chars.length) ** 2
  }

  // 二元组重合：处理「查物价的网站」这类长句
  if (qBigrams.size) {
    let hit = 0
    for (const bg of qBigrams) if (site.text.includes(bg)) hit++
    score += (ascii ? 40 : 85) * (hit / qBigrams.size)
  }

  // 同义词扩展（命中名称再加一档，避免只在简介里带一句的抢到前面）
  for (const [keys, words] of SYNONYMS) {
    if (!keys.some(k => q.includes(k))) continue
    if (words.some(w => site.text.includes(w))) score += 150
    if (words.some(w => name.includes(w))) score += 90
  }

  return score
}

function searchSites (list, rawQuery) {
  const q = norm(rawQuery)
  if (!q) return []
  const qBigrams = bigrams(q)
  return list
    .map(s => ({ site: s, score: scoreSite(s, q, qBigrams) }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
}

/* ---------------- 渲染 ---------------- */

const FORWARD_NICK = 'FF14 网站导航'

function categoriesNodes (list, fetchedAt) {
  const map = new Map()
  for (const s of list) map.set(s.cat, (map.get(s.cat) || 0) + 1)
  const lines = [
    `🗂 FF14 常用网站导航（${list.length} 个站点 / ${map.size} 个分类）`,
    ''
  ]
  for (const [cat, n] of map) lines.push(`· ${cat}（${n}）`)
  lines.push('', `数据源：gamecircum.com · ${fmtDate(fetchedAt)}`)
  return [
    lines.join('\n'),
    [
      '📖 用法',
      '#查网站 <需求>',
      '例：#查网站 物价 / #查网站 配装 / #查网站 房子 / #查网站 战斗记录',
      '输入分类名可列出该分类全部站点，如 #查网站 幻化相关'
    ].join('\n')
  ]
}

function fmtDate (ts) {
  if (!ts) return '未知'
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 每个站点一条节点，头尾各一条；用合并转发避免刷屏 */
function resultNodes (query, hits, list, extra = '') {
  const nodes = [[
    `🔎 「${query}」· ${hits.length} 个相关站点`,
    `数据源：gamecircum.com · 共 ${list.length} 个站点`
  ].join('\n')]
  hits.forEach(({ site }, i) => {
    const lines = [`${i + 1}. ${site.name}`]
    if (site.desc) lines.push(site.desc)
    lines.push(site.url)
    lines.push(`分类：${site.cats.join(' / ')}`)
    nodes.push(lines.join('\n'))
  })
  if (extra) nodes.push(extra)
  return nodes
}

/* ---------------- 插件 ---------------- */

export class ff14Sites extends plugin {
  constructor () {
    super({
      name: 'FF14网站导航',
      dsc: '按需求模糊搜索 FF14 常用网站（数据源 gamecircum.com）',
      event: 'message',
      // ff14wiki 是 1、土块是 5；这里取 2，避免被宽正则抢先
      priority: 2,
      rule: [
        { reg: '^#查网站\\s*(.*)$', fnc: 'search', permission: 'all' },
        { reg: '^#更新网站$', fnc: 'refresh', permission: 'master' }
      ]
    })
  }

  /** 合并转发发送（与 GroupSummary 同一套写法），不支持转发时退回普通文本 */
  async replyForward (messages) {
    const nickname = this.e.bot?.nickname || FORWARD_NICK
    const user_id = this.e.bot?.uin || this.e.self_id
    const msgList = messages.map(message => ({ message, nickname, user_id }))
    const sendForward = this.e.group?.sendForwardMsg || this.e.friend?.sendForwardMsg
    if (sendForward) return sendForward(msgList)
    return this.reply(messages.join('\n\n'))
  }

  async search () {
    const query = String(this.e.msg).replace(/^#查网站\s*/, '').trim()

    const key = `Yz:sites:cd:${this.e.user_id}`
    if (await redis.get(key)) return this.reply('查得太快了，5 秒后再试')
    await redis.setEx(key, Math.ceil(USER_CD_MS / 1000), '1')

    let data
    try {
      data = await ensureSites()
    } catch (err) {
      logger.error(`[sites] 数据不可用：${err.message}`)
      return this.reply(`网站数据还没拿到：${String(err.message).slice(0, 100)}\n稍后再试，或让 bot 管理员发 #更新网站`)
    }

    const list = data.list
    if (!query) return this.replyForward(categoriesNodes(list, data.fetchedAt))

    // 输入的是分类名 → 直接铺该分类
    const catHit = list.filter(s => s.cats.some(c => c === query || c.includes(query) || query.includes(c)))
    if (catHit.length >= 3) {
      const shown = catHit.slice(0, 12)
      const nodes = [[
        `📁 「${query}」· ${catHit.length} 个站点${catHit.length > shown.length ? `（显示前 ${shown.length} 个）` : ''}`,
        `数据源：gamecircum.com · 共 ${list.length} 个站点`
      ].join('\n')]
      shown.forEach((s, i) => {
        const lines = [`${i + 1}. ${s.name}`]
        if (s.desc) lines.push(s.desc)
        lines.push(s.url)
        nodes.push(lines.join('\n'))
      })
      return this.replyForward(nodes)
    }

    const hits = searchSites(list, query).slice(0, MAX_RESULTS)
    if (!hits.length) {
      return this.reply(
        `没找到和「${query}」相关的站点。\n` +
        '换更短的关键词试试，比如：#查网站 物价 / #查网站 幻化 / #查网站 攻略\n' +
        '发 #查网站 可以看全部分类'
      )
    }

    // 命中太少时，把首个结果所属分类的其他站点名字带出来，方便继续翻
    // 名字精确命中（比如 #查网站 etro）就不啰嗦了
    let extra = ''
    const exact = hits.length === 1 && hits[0].site.lname.replace(PUNCT, '') === norm(query)
    if (hits.length < 3 && !exact) {
      const cat = hits[0].site.cats[0]
      const used = new Set(hits.map(h => h.site.url))
      const others = list.filter(s => s.cats.includes(cat) && !used.has(s.url)).slice(0, 6)
      if (others.length) extra = `同分类「${cat}」还有：${others.map(s => s.name).join('、')}`
    }

    return this.replyForward(resultNodes(query, hits, list, extra))
  }

  async refresh () {
    try {
      const data = await rebuild()
      const cats = new Set(data.list.map(s => s.cat)).size
      return this.reply(`✅ 已更新：${data.list.length} 个站点 / ${cats} 个分类（数据源 gamecircum.com）`)
    } catch (err) {
      logger.error(`[sites] 手动更新失败：${err.message}`)
      return this.reply(`更新失败：${String(err.message).slice(0, 120)}`)
    }
  }
}
