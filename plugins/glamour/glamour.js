import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 石之家「幻化」随机展示
 *
 *   #随机幻化            随机一条（1 次接口，~0.5s）
 *   #随机幻化 拉拉肥      按种族随机（服务端不支持筛选，只能反复刷，最多 8 次 ~4.5s）
 *
 * 数据源：石之家 PC 端 SPA 逆出来的接口
 *   https://apiff14risingstones.web.sdo.com/api/home/glamour/randomGlamours
 *   https://apiff14risingstones.web.sdo.com/api/home/glamour/glamourDetail?id=<id>
 *
 * ⚠️ 必须带登录 Cookie，否则一律 {"code":10403,"msg":"请先登录"}
 *    Cookie 复用 rising-stones.js 已绑定的那份（plugins/example/rising-stones.json），
 *    那边每天 09:00 自动续期，这里只读不写。
 *
 * ⚠️ randomGlamours **不接受任何筛选参数**（raceIds / race_ids / raceId / race / genderIds 实测全被忽略），
 *    所以按种族挑只能客户端过滤。实测各见条目里拉拉肥占比 4%~12%，8 次调用（32 条）命中率约 85~98%。
 *
 * ⚠️ 字段坑：
 *    - images 可能为空串（实测 5 条里 1 条），要回退 main_image
 *    - dye_ids 长度常常大于 dyes 实际数组（如 dye_ids=[13114,-1] 只给 1 个染料对象），
 *      不能直接按长度 zip，要按下标配对、缺的留空
 *    - 列表接口的 race_ids 是数字数组 [3]，详情接口是对象数组 [{id:3,name:'拉拉菲尔族'}]，统一取 id
 *    - 空槽 equipment_id = -1，name 为 null，要跳过
 */

const API = 'https://apiff14risingstones.web.sdo.com/api/home/'
/** 账号文件按插件自身位置找（与本插件同目录），不依赖 cwd 和安装目录 */
const ACCOUNTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rising-stones.json')
const REFERER = 'https://ff14risingstones.web.sdo.com/'
const SITE = 'https://ff14risingstones.web.sdo.com/pc/index.html#/glamour/detail/'

const TIMEOUT_MS = 15000
const MAX_TRIES = 8          // 带种族时最多刷几次 randomGlamours
const MAX_IMAGES = 2         // 每条最多发几张图
const CD_COLD_MS = 10000     // #随机幻化 冷却
const CD_RACE_MS = 30000     // #随机幻化 <种族> 冷却

const RACE_NAME = {
  1: '人族', 2: '精灵族', 3: '拉拉菲尔族', 4: '猫魅族',
  5: '鲁加族', 6: '敖龙族', 7: '硌狮族', 8: '维埃拉族'
}

/** 中文别名 → race_id。用户输入会先去掉「族」再查一次，所以「拉拉肥」和「拉拉菲尔族」都能认 */
/**
 * 种族俗称表。匹配前会去掉空格，并再试一次去掉末尾的「族」。
 * 「娘 / 男」这类词只映射到种族，不筛性别（接口不支持性别筛选，本地也没做）。
 */
const RACE_ALIAS = {
  // 1 人族
  人: 1, 人类: 1, 人族: 1, 人男: 1, 人女: 1,
  中原: 1, 中原人: 1, 高地: 1, 高地人: 1, 高男: 1, 高女: 1,
  // 2 精灵族
  精: 2, 精灵: 2, 精灵族: 2, 精男: 2, 精女: 2,
  长耳: 2, 长耳朵: 2, 长耳族: 2,
  // 3 拉拉菲尔族
  拉拉: 3, 拉拉肥: 3, 拉拉菲: 3, 拉拉菲尔: 3, 拉拉菲尔族: 3, 肥: 3,
  土豆: 3, 小土豆: 3, 矮子: 3, 小矮子: 3,
  // 4 猫魅族
  猫: 4, 猫魅: 4, 猫魅族: 4, 猫娘: 4, 猫男: 4, 猫猫: 4, 猫咪: 4, 喵: 4,
  // 5 鲁加族
  鲁加: 5, 鲁加族: 5, 大鲁加: 5, 大块头: 5, 巨人: 5, 壮汉: 5,
  // 6 敖龙族
  龙: 6, 龙族: 6, 敖龙: 6, 敖龙族: 6, 龙娘: 6, 龙男: 6, 龙龙: 6,
  // 7 硌狮族
  狮: 7, 狮子: 7, 硌狮: 7, 硌狮族: 7, 大猫: 7, 大猫猫: 7, 狮男: 7, 狮娘: 7,
  // 8 维埃拉族
  兔: 8, 兔子: 8, 兔兔: 8, 兔娘: 8, 兔男: 8, 维埃拉: 8, 维埃拉族: 8, 兔女郎: 8
}

const SLOT_NAME = {
  MAIN_HAND: '主手',
  OFF_HAND: '副手',
  HEAD: '头部',
  BODY: '上衣',
  GLOVES: '手部',
  WAIST: '腰部',
  LEGS: '腿部',
  FEET: '足部',
  EARS: '耳饰',
  NECK: '项链',
  WRISTS: '腕饰',
  FINGER_LEFT: '指环',
  FINGER_RIGHT: '指环',
  SOUL_CRYSTAL: '水晶'
}

/** 用户冷却：QQ 号 → 上次使用时间 */
const cooldown = new Map()

export default class Glamour extends plugin {
  constructor () {
    super({
      name: '石之家幻化',
      dsc: '随机看石之家的幻化配装，出图 + 全套装备与染色',
      event: 'message',
      // 必须早于 earth-k-plugin 的「土块AI画图(tsc)」：它 priority 是 5（源码 0x5），
      // 且带一条 `^#(.*)化$` 的宽正则，会把「#随机幻化」当成画图命令吞掉
      // （2026-10-28 实测：回「你还没有填写密钥哦」，设成 100 依然被抢）。
      // 本条规则只认 `^#随机幻化`，提前跑不会影响别人。
      priority: 1,
      rule: [
        { reg: '^#随机幻化\\s*(.*)$', fnc: 'random' }
      ]
    })
  }

  /* ───────────────────────── 账号 / 接口 ───────────────────────── */

  /** 读已绑定账号，返回 {cookie, ua} 或 null */
  account () {
    let all
    try {
      all = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'))
    } catch {
      return null
    }
    for (const acc of Object.values(all || {})) {
      if (acc && typeof acc.cookie === 'string' && acc.cookie.trim()) {
        return { cookie: acc.cookie.trim(), ua: acc.ua || '' }
      }
    }
    return null
  }

  /**
   * GET 接口，返回 data 部分。
   * @throws Error 带 code 字段，10403 是登录态失效
   */
  async api (name, params = {}, acc) {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    ).toString()
    const res = await fetch(`${API}${name}${qs ? `?${qs}` : ''}`, {
      headers: {
        Cookie: acc.cookie,
        'User-Agent': acc.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        Referer: REFERER,
        Accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (Number(json.code) !== 10000) {
      const err = new Error(json.msg || `code ${json.code}`)
      err.code = Number(json.code)
      throw err
    }
    return json.data
  }

  /* ───────────────────────── 数据整理 ───────────────────────── */

  /** race_ids 两种形态统一成数字数组 */
  raceIds (item) {
    const arr = item?.race_ids
    if (!Array.isArray(arr)) return []
    return arr.map(r => (typeof r === 'object' && r !== null ? Number(r.id) : Number(r))).filter(Boolean)
  }

  /**
   * 图片：主图 + 图集，去重后最多 MAX_IMAGES 张。
   * 实测主图与图集第一张 URL 不同（同一套幻化的不同镜头），所以两者都收。
   * 注意：大部分投稿只传了一张图，凑不满 2 张是正常现象，不做硬凑。
   */
  imagesOf (d) {
    const gallery = String(d.images || '').split(',').map(s => s.trim()).filter(Boolean)
    const list = [...new Set([String(d.main_image || '').trim(), ...gallery].filter(Boolean))]
    return list.slice(0, MAX_IMAGES)
  }

  /** 染色：按下标配对，dyes 里没有对象就退化成 id */
  dyeText (eq) {
    const ids = Array.isArray(eq.dye_ids) ? eq.dye_ids : []
    const dyes = Array.isArray(eq.dyes) ? eq.dyes : []
    const names = []
    for (let i = 0; i < Math.max(ids.length, dyes.length); i++) {
      const name = dyes[i]?.name
      if (name) names.push(name)
      else if (ids[i] > 0) names.push(`染剂${ids[i]}`)
    }
    return names.length ? ` ▸ ${names.join(' / ')}` : ''
  }

  /** 装备清单（跳过空槽，同一槽位去重） */
  equipLines (d) {
    const lines = []
    const seen = new Map()
    for (const eq of Array.isArray(d.equipments) ? d.equipments : []) {
      if (!eq || !(eq.equipment_id > 0) || !eq.name) continue
      const key = `${eq.slot}|${eq.equipment_id}|${(eq.dye_ids || []).join(',')}`
      if (seen.has(key)) continue
      seen.set(key, true)
      const slot = SLOT_NAME[eq.slot] || eq.slot
      const fashion = eq.is_fashion ? '（投影）' : ''
      lines.push(`${slot}　${eq.name}${fashion}${this.dyeText(eq)}`)
    }
    return lines
  }

  /* ───────────────────────── 发送 ───────────────────────── */

  async sendForward (messages) {
    const send = this.e.group?.sendForwardMsg || this.e.friend?.sendForwardMsg
    if (typeof send !== 'function') return false
    const nodes = messages.map(message => ({
      message,
      nickname: '石之家幻化',
      user_id: Number(Bot.uin) || 10000
    }))
    try {
      await send.call(this.e.group || this.e.friend, nodes)
      return true
    } catch (err) {
      logger.warn(`[glamour] 合并转发失败: ${err.message}`)
      return false
    }
  }

  /* ───────────────────────── 命令 ───────────────────────── */

  async random () {
    const e = this.e
    const arg = String(e.msg || '').replace(/^#随机幻化/, '').trim()

    // 解析种族
    let raceId = 0
    if (arg) {
      const key = arg.replace(/\s+/g, '')
      raceId = RACE_ALIAS[key] || RACE_ALIAS[key.replace(/族$/, '')] || 0
      if (!raceId && /^\d$/.test(key)) raceId = Number(key)
      if (!RaceOk(raceId)) {
        await e.reply('认不出这个种族。可用：拉拉肥 / 猫娘 / 龙娘 / 兔娘 / 大猫 / 人 / 精灵 / 鲁加（也可以直接发数字 1~8）')
        return true
      }
    }

    // 冷却
    const cd = raceId ? CD_RACE_MS : CD_COLD_MS
    const last = cooldown.get(e.user_id) || 0
    if (Date.now() - last < cd) {
      await e.reply(`刚看过，${Math.ceil((cd - (Date.now() - last)) / 1000)} 秒后再试。`)
      return true
    }

    const acc = this.account()
    if (!acc) {
      await e.reply('还没绑定石之家账号，先发「#石之家登录」登录一次。')
      return true
    }

    cooldown.set(e.user_id, Date.now())

    let picked = null
    try {
      picked = await this.pick(acc, raceId)
    } catch (err) {
      cooldown.delete(e.user_id)   // 接口出错不罚站，让用户能立刻重试
      if (err.code === 10403) {
        await e.reply('石之家登录态失效了，发「#石之家登录」重新登录一次。')
        return true
      }
      logger.error(`[glamour] 取随机幻化失败: ${err.message}`)
      await e.reply(`石之家那边没响应（${err.message}），稍后再试。`)
      return true
    }

    if (!picked) {
      await e.reply(`刷了 ${MAX_TRIES} 次都没碰到${RACE_NAME[raceId]}的幻化，再发一次试试。`)
      return true
    }

    let detail
    try {
      detail = await this.api('glamour/glamourDetail', { id: picked.id }, acc)
    } catch (err) {
      cooldown.delete(e.user_id)
      logger.error(`[glamour] 详情失败 id=${picked.id}: ${err.message}`)
      await e.reply(`拿到了一条幻化但详情打不开（${err.message}），再发一次试试。`)
      return true
    }

    await this.show(detail)
    return true
  }

  /** 循环 randomGlamours 直到命中目标种族；raceId=0 时一次就够 */
  async pick (acc, raceId) {
    const tries = raceId ? MAX_TRIES : 1
    for (let i = 0; i < tries; i++) {
      const data = await this.api('glamour/randomGlamours', {}, acc)
      const rows = Array.isArray(data?.rows) ? data.rows : []
      const pool = raceId ? rows.filter(r => this.raceIds(r).includes(raceId)) : rows
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)]
    }
    return null
  }

  /** 组装并发出：图 1 个节点 + 文字 1 个节点 + 链接 1 个节点 */
  async show (d) {
    const e = this.e
    const imgs = this.imagesOf(d)
    const races = this.raceIds(d).map(id => RACE_NAME[id] || id).join('/') || '未知种族'
    const gender = (d.gender_ids || []).map(g => (Number(g) === 1 ? '男' : Number(g) === 2 ? '女' : '')).filter(Boolean).join('/')
    const tags = (d.tags || []).map(t => t.tag_name).filter(Boolean)

    const head = []
    const title = String(d.title || '').trim()
    if (title && !/^[.。·\s]*$/.test(title)) head.push(`「${title}」`)
    head.push(`${d.character_name || '匿名'} · ${d.area_name || ''} ${d.group_name || ''}`.trim())
    head.push(`${races}${gender ? ` · ${gender}` : ''}`)
    if (tags.length) head.push(`🏷 ${tags.join(' / ')}`)
    head.push(`💗 ${d.likes ?? 0} 赞 · ${d.favorites ?? 0} 藏`)

    const equips = this.equipLines(d)
    const body = [
      ...head,
      '',
      ...(equips.length ? equips : ['（这条没填装备）'])
    ].join('\n')

    const nodes = []
    if (imgs.length) nodes.push(imgs.map(url => segment.image(url)))
    nodes.push(body)
    nodes.push(`${SITE}${d.id}\n来源：石之家`)

    if (await this.sendForward(nodes)) return
    // 转发不可用时退化成「图 + 文」两条普通消息
    for (const url of imgs) {
      try { await e.reply(segment.image(url)) } catch (err) { logger.warn(`[glamour] 图片发送失败: ${err.message}`) }
    }
    await e.reply(body)
  }
}

function RaceOk (id) {
  return Number.isInteger(id) && id >= 1 && id <= 8
}
