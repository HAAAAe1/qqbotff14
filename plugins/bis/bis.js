// BIS 配装链接查询 —— 数据源：本地 xlsx（金山文档导出，作者 喵叔孤风行）
// 原文档：https://www.kdocs.cn/l/ceEcTzlFQBUy
// 列结构：A=副本 B=装等 C=类型 D=GCD E=职业 F=期望 G=提升 H=配装 I=备用链接 J=备注 K=主用链接 L=备用链接
// 命令：#bis 职业 [关键词] 查询；#bis 帮助；#更新bis 重新解析本地 xlsx；#bis检测 立即查文档是否有更新
//
// ── 文档更新检测（每周）──
// 金山文档分享页的 HEAD 响应头带 `x-file-version`（形如 20261021160513-ea8677e50e，
// 前 14 位是 UTC 修改时间戳），无需登录、无需 cookie。用它跟本地记录的版本比，
// 变了就说明作者更新了文档 → 私聊主人「该重新导出 xlsx 了」。
// 启动后 5 分钟首次检测，之后每 7 天一次（与 #市场 的索引自检同频）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.join(__dirname, 'data', 'bis-data.json')
const SRC_FILE = path.join(__dirname, 'data', 'bis-source.xlsx')
const STATE_FILE = path.join(__dirname, 'data', 'bis-state.json')

/** 金山文档分享链接（作者原文档） */
const DOC_URL = 'https://www.kdocs.cn/l/ceEcTzlFQBUy'
/** 检测频率：启动后 5 分钟首次，之后每 7 天 */
const CHECK_FIRST_DELAY_MS = 5 * 60 * 1000
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/** 发现新版本时私聊谁 —— 填你自己的 QQ，留空则只写日志不私聊 */
const MASTER_QQ = process.env.BIS_MASTER_QQ || ''


const JOB_ALIASES = {
  '坦克': ['坦克', 'tank', '防护', '战士', '骑士', '暗黑骑士', '暗骑', 'dk', '绝枪', '绝枪战士'],
  '治疗': ['治疗', 'healer', '白魔', '白魔法师', '学者', '占星', '占星术士', '贤者'],
  '龙骑': ['龙骑', '龙骑士', 'dragoon', 'drg'],
  '镰刀': ['镰刀', '钐镰', '钐镰客', 'reaper', 'rpr'],
  '武僧': ['武僧', 'monk', 'mnk'],
  '武士': ['武士', 'samurai', 'sam'],
  '蝰蛇': ['蝰蛇', '蝰蛇剑士', 'viper', 'vpr'],
  '忍者': ['忍者', 'ninja', 'nin'],
  '机工': ['机工', '机工士', 'machinist', 'mch'],
  '诗人': ['诗人', '吟游诗人', 'bard', 'brd'],
  '舞者': ['舞者', 'dancer', 'dnc'],
  '画家': ['画家', '绘灵法师', 'pictomancer', 'pct'],
  '赤魔': ['赤魔', '赤魔法师', 'red mage', 'rdm'],
  '召唤': ['召唤', '召唤师', 'summoner', 'smn'],
  '黑魔': ['黑魔', '黑魔法师', 'black mage', 'blm']
}

const JOB_SHEETS = Object.keys(JOB_ALIASES)

// 绝本俗称映射：搜索词 → 数据关键词（绝凯夫卡 俗称 绝妖，取自其 BGM 妖星乱舞）
const KW_ALIASES = {
  '绝妖': '绝凯夫卡'
}

const USAGE = `📋 BIS 配装查询（文档作者：喵叔孤风行 · 排版：羽卡）
数据来源：金山文档《FF14 配装汇总》（本地 xlsx 版）
用法：
#bis 战士 —— 默认输出该职业最新 BIS 配装（7.55 第一行）
#bis 黑魔 7.4零式 / #bis 黑魔 伊甸 BIS —— 需要其他配装时，加 版本/副本名+类型 过滤
#bis检测 —— 查源文档有没有更新（每周也会自动查一次，有更新会私聊提醒主人）
#更新bis —— 重新解析 data/bis-source.xlsx（文档更新后重新导出放回该文件）
职业：坦克(战士/骑士/暗骑/绝枪)、治疗(白魔/学者/占星/贤者)、龙骑、镰刀、武僧、武士、蝰蛇、忍者、机工、诗人、舞者、画家、赤魔、召唤、黑魔
如有错漏请参考文档，如未及时更新请提醒我：https://www.kdocs.cn/l/ceEcTzlFQBUy`

const AUTHOR = '文档作者：喵叔孤风行'

/* ─────────────────── 文档更新检测 ─────────────────── */

function loadState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveState (patch) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 2), 'utf8')
  } catch (err) {
    logger.warn(`[bis] 状态文件写入失败：${err.message}`)
  }
}

/** 读金山文档分享页的 x-file-version（HEAD 即可，不需要登录） */
async function fetchDocVersion () {
  const r = await fetch(DOC_URL, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000)
  })
  const v = r.headers.get('x-file-version')
  if (!v) throw new Error(`响应头里没有 x-file-version（HTTP ${r.status}）`)
  return v
}

/** 20261021160513-ea8677e50e → 2026-10-21 16:05:13 */
function fmtDocVersion (v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(v || ''))
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(v || '未知')
}

function fmtTime (ts) {
  if (!ts) return '从未'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 检查文档是否比本地数据新
 * @returns {{ version:string, synced:string|null, stale:boolean, baseline:boolean }}
 */
async function checkDoc () {
  const state = loadState()
  const version = await fetchDocVersion()
  const synced = state.syncedVersion || null
  const baseline = !synced
  const stale = !!synced && synced !== version
  saveState({ docVersion: version, checkedAt: Date.now() })
  return { version, synced, stale, baseline }
}

/** 发现新版本 → 私聊主人（未配置 MASTER_QQ 时只写日志） */
async function notifyMaster (version, synced) {
  const msg =
    '📋 BIS 配装文档更新了\n' +
    `新版本：${fmtDocVersion(version)}\n` +
    `本地数据：${fmtDocVersion(synced)}\n` +
    '要做的事：浏览器打开 https://www.kdocs.cn/l/ceEcTzlFQBUy 导出 Excel，\n' +
    '覆盖 TRSS-Yunzai/plugins/example/data/bis-source.xlsx，然后发 #更新bis'
  if (!MASTER_QQ) {
    logger.warn(`[bis] 文档有新版本 ${version}，但没配 BIS_MASTER_QQ，不推送。\n${msg}`)
    saveState({ notifiedVersion: version, notifiedAt: Date.now() })
    return
  }
  try {
    const friend = globalThis.Bot?.pickFriend?.(MASTER_QQ)
    if (!friend) throw new Error('Bot 未就绪')
    await friend.sendMsg(msg)
    saveState({ notifiedVersion: version, notifiedAt: Date.now() })
    logger.info(`[bis] 文档新版本 ${version}，已私聊提醒 ${MASTER_QQ}`)
  } catch (err) {
    logger.warn(`[bis] 提醒主人失败：${err.message}`)
  }
}

/** 启动后 5 分钟首次检测，之后每 7 天（热重载会替换旧定时器） */
function scheduleDocCheck () {
  const prev = globalThis.__bisDocTimer
  if (prev) {
    clearTimeout(prev.first)
    clearInterval(prev.loop)
  }
  const run = async tag => {
    try {
      const r = await checkDoc()
      if (r.baseline) {
        saveState({ syncedVersion: r.version })
        logger.info(`[bis] ${tag}首次记录文档基线 ${r.version}（${fmtDocVersion(r.version)}）`)
        return
      }
      if (!r.stale) {
        logger.info(`[bis] ${tag}文档无变化（${fmtDocVersion(r.version)}）`)
        return
      }
      const state = loadState()
      if (state.notifiedVersion === r.version) {
        logger.info(`[bis] ${tag}仍是未处理的新版本 ${r.version}，不重复提醒`)
        return
      }
      logger.info(`[bis] ${tag}发现新版本 ${r.version}（本地 ${r.synced}）`)
      await notifyMaster(r.version, r.synced)
    } catch (err) {
      logger.warn(`[bis] ${tag}检测失败：${err.message}`)
    }
  }
  const first = setTimeout(() => run('启动检测：'), CHECK_FIRST_DELAY_MS)
  const loop = setInterval(() => run('每周检测：'), CHECK_INTERVAL_MS)
  first.unref?.()
  loop.unref?.()
  globalThis.__bisDocTimer = { first, loop }
}

scheduleDocCheck()


function loadData () {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    return null
  }
}

function findSheet (kw) {
  const q = kw.trim().toLowerCase().replace(/[的配装装备bis]+$/g, '')
  for (const [sheet, aliases] of Object.entries(JOB_ALIASES)) {
    if (aliases.some(a => a.toLowerCase() === q)) return sheet
    if (q === sheet.toLowerCase()) return sheet
  }
  for (const [sheet, aliases] of Object.entries(JOB_ALIASES)) {
    if (aliases.some(a => q.includes(a.toLowerCase()) || a.toLowerCase().includes(q))) return sheet
  }
  return null
}

/** 解析本地 xlsx → 全职业数据 { 表名: [{label,url,note,ilvl,kw}] } */
function parseXlsx (file = SRC_FILE) {
  const wb = XLSX.readFile(file)
  const data = {}
  for (const name of JOB_SHEETS) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    const items = []
    let curVer = '' // 当前分区版本（由「以下为X配装」标题行驱动）
    let curTag = '' // 当前分区附加关键词（如「7.55BIS+绝凯夫卡肝武」→ 绝凯夫卡/肝武）
    for (const r of rows) {
      const get = ci => (r[ci] != null ? String(r[ci]).trim() : '')
      const A = get(0), B = get(1), C = get(2), D = get(3), E = get(4), J = get(9), K = get(10), L = get(11)
      // 分区标题行：「以下为7.4零式配装」/「以下为7.55BIS+绝凯夫卡肝武配装」/「7.0零式AR1~AR4」→ 更新版本+关键词标签
      let sec = A.match(/以下为(.+?)配装/)
      if (sec) {
        const vm = sec[1].match(/[76]\.\d{1,2}/)
        curVer = vm ? (sec[1].includes('零式') ? vm[0] + '零式' : vm[0]) : ''
        curTag = [...new Set(sec[1].match(/绝凯夫卡|肝武|绝武|义军武器|零式|伊甸|灭级|至天|绝本/g) || [])].join(' ')
      } else {
        const m2 = A.match(/^([76]\.\d{1,2})\s*零式/)
        if (m2) { curVer = m2[1] + '零式'; curTag = '' }
      }
      let url = K.startsWith('http') ? K : (L.startsWith('http') ? L : '')
      if (!url) continue
      // GCD：D 列可能是纯 2.42 或「1068/2.42」组合 → 只取 GCD 部分
      let gcd = D
      if (!/^\d\.\d{1,2}$/.test(gcd)) {
        const m = gcd.match(/(\d\.\d{1,2})/)
        gcd = m ? m[1] : ''
      }
      // 装等：B 列可能带注释如「635(适用于零式异闻下水道)」→ 取纯数字
      const ilvlRaw = B.match(/^\d{3}/)
      const ilvl = ilvlRaw ? +ilvlRaw[0] : 0
      const b = ilvlRaw ? ilvlRaw[0] : B
      const label = [b, C, gcd, E].filter(Boolean).join(' ') || '(未命名)'
      const note = J.replace(/\s*\n+\s*/g, ' ').slice(0, 80)
      // 版本标签：分区版本优先；历史区行 C 列直接写版本号（7.2/6.55）也认
      let ver = curVer
      if (/^[76]\.\d{1,2}$/.test(C)) ver = C
      // 副本关键词：A 列（副本）+ 标题 + 备注（用于 副本名+类型 过滤）
      const kw = [...new Set((A + ' ' + label + ' ' + J + ' ' + curTag).match(/绝凯夫卡|绝伊甸|绝巴哈|绝龙诗|暗黑之云|阿罗阿罗岛|阿罗岛|至天之座|至天|灭级|灭云|灭|量级|之座|伊甸|绝欧|龙诗|绝亚|神兵|巴哈|肝武|绝武|义军武器|绝本|零式/g) || [])].join(' ')
      items.push({ label, url, note, ilvl, kw, ver })
    }
    data[name] = items
  }
  return data
}

export class bis extends plugin {
  constructor () {
    super({
      name: 'BIS配装查询',
      dsc: '查询各职业 BIS 配装链接：#bis 职业 [#更新bis 刷新]',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#bis$', fnc: 'usage', permission: 'all' },
        { reg: '^#bis\\s*检测$', fnc: 'check', permission: 'all' },
        { reg: '^#bis\\s+(.+)$', fnc: 'query', permission: 'all' },
        { reg: '^#更新bis$', fnc: 'refresh', permission: 'all' }
      ]
    })
  }

  async usage () {
    return this.reply(USAGE)
  }

  /** #bis检测 —— 立即查源文档是否有新版本 */
  async check () {
    let r
    try {
      r = await checkDoc()
    } catch (err) {
      return this.reply(`❌ 检测失败：${err.message}\n（文档链接可能改过，或网络不通）`)
    }
    const state = loadState()
    const head = `📋 BIS 源文档版本：${fmtDocVersion(r.version)}`
    const tail = `上次检测：${fmtTime(state.checkedAt)}\n自动检测：启动后 5 分钟一次，之后每 7 天一次`

    if (r.baseline) {
      saveState({ syncedVersion: r.version })
      return this.reply(`${head}\n\n✅ 已记录为本地数据的基线版本，之后作者改动会提醒你。\n${tail}`)
    }
    if (!r.stale) {
      return this.reply(`${head}\n\n✅ 和本地数据一致，无需更新。\n${tail}`)
    }
    saveState({ docVersion: r.version })
    return this.reply(
      `${head}\n\n⚠️ 比本地数据新（本地：${fmtDocVersion(r.synced)}）\n` +
      '请浏览器打开文档导出 Excel，覆盖 data/bis-source.xlsx 后发 #更新bis\n' +
      `https://www.kdocs.cn/l/ceEcTzlFQBUy\n${tail}`
    )
  }

  async query () {
    const args = this.e.msg.replace(/^#bis\s*/, '').trim()
    const parts = args.split(/\s+/)
    const sheet = findSheet(parts[0])
    if (!sheet) {
      return this.reply(`没找到职业「${parts[0]}」，试试：\n${USAGE}`)
    }
    const data = loadData()
    if (!data || !data[sheet]) {
      return this.reply(`配装数据缺失，请先发 #更新bis 解析本地 xlsx。\n（${AUTHOR}）`)
    }
    const items = data[sheet]
    const filter = parts.slice(1).join(' ')
    if (!filter) {
      // 默认输出最新 = 每个职业表第一个数据行（7.55 区，黑魔正是第 5 行）
      const best = items[0]
      if (!best) return this.reply(`「${sheet}」暂无配装数据。（${AUTHOR}）`)
      const noteLine = best.note ? `📝（${best.note}）\n` : ''
      return this.reply(
        `🎯 ${sheet} 最新 BIS 配装（${AUTHOR}）\n` +
        `${best.label || ''}\n${best.url}\n` +
        `${noteLine}如有错漏请参考文档，如未及时更新请提醒我：https://www.kdocs.cn/l/ceEcTzlFQBUy` +
        `\n💡 共有 ${items.length} 套配装，想要其他配装请加 版本/副本名+类型 关键词（如 7.4零式 / 伊甸 BIS / 神兵）：\n#bis ${parts[0]} 7.4零式　#bis ${parts[0]} 伊甸 BIS`
      )
    }
    let filtered = items.filter(i => {
      const tokens = filter.split(/[\s，,、]+/).filter(Boolean)
      const text = i.label + ' ' + (i.kw || '') + ' ' + (i.ver || '')
      // 俗称展开：绝妖 → [绝妖, 绝凯夫卡]，任一命中即可
      const expand = t => KW_ALIASES[t] ? [t, KW_ALIASES[t]] : [t]
      return tokens.every(t => expand(t).some(c => text.includes(c) || (c.startsWith('绝') && text.includes(c.slice(1)))))
    })
    if (!filtered.length) {
      return this.reply(`「${sheet}」没有匹配「${filter}」的配装。试试 版本/副本名+类型，如：7.4零式 / 伊甸 BIS / 神兵\n如有错漏请参考文档，如未及时更新请提醒我：https://www.kdocs.cn/l/ceEcTzlFQBUy\n（${AUTHOR}）`)
    }
    const head = `🎯 ${sheet} BIS 配装（筛选「${filter}」${filtered.length} 条 · ${AUTHOR}）`
    const body = filtered.slice(0, 15).map((i, n) => `${n + 1}. ${i.label || '(未命名)'}\n${i.url}${i.note ? '\n📝（' + i.note + '）' : ''}`).join('\n')
    const tail = filtered.length > 15 ? `\n…还有 ${filtered.length - 15} 条，可用更精确的关键词过滤` : ''
    return this.reply(head + '\n' + body + tail + '\n如有错漏请参考文档，如未及时更新请提醒我：https://www.kdocs.cn/l/ceEcTzlFQBUy')
  }

  /** 重新解析本地 xlsx（文档更新后，把新导出的 xlsx 覆盖 data/bis-source.xlsx 再执行） */
  async refresh () {
    if (!fs.existsSync(SRC_FILE)) {
      return this.reply(`❌ 未找到 ${SRC_FILE}\n请先在浏览器导出金山文档为 Excel，覆盖保存到该路径后重试。（${AUTHOR}）`)
    }
    try {
      const data = parseXlsx()
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
      fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8')
      // 把当前文档版本记为「已同步」，避免每周检测重复提醒
      try {
        const v = await fetchDocVersion()
        saveState({ syncedVersion: v, docVersion: v, syncedAt: Date.now() })
      } catch (err) {
        logger.warn(`[bis] 解析成功但没取到文档版本：${err.message}`)
      }
      const total = Object.values(data).reduce((s, v) => s + v.length, 0)
      return this.reply(`✅ 已更新！${Object.keys(data).length} 个职业共 ${total} 条配装链接（${AUTHOR}，数据版本以 xlsx 为准）`)
    } catch (e) {
      return this.reply(`❌ 解析失败：${e.message || e}`)
    }
  }
}
