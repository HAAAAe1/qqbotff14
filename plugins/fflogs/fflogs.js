import plugin from '../../lib/plugins/plugin.js'
import puppeteer from 'puppeteer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * FFLogs 绝本 + 零式查询（数据源：FFLogs v2 GraphQL API）
 *
 * 范围（不按资料片分组，一块列表直接铺开）
 *   绝本：7 个**全部**（巴哈 / 神兵 / 亚历山大 / 龙诗 / 欧米茄 / 光暗未来 / 妖星乱舞），旧版本也要
 *   24 人本：暗黑之云
 *   零式：**只要当前大版本 7.x** 的三期（73 重量级 / 68 中量级 / 62 轻量级，共 13 层）
 *   ★ 0 杀 / 无记录的副本**不过滤**，一律占一行标「未通关」——否则旧版绝本会整行消失
 *
 * 命令
 *   #fflogs <服务器> <角色名>     例：#fflogs 服务器名 角色名
 *
 * ── 认证 ──
 *   OAuth2 client_credentials → https://www.fflogs.com/oauth/token
 *   再用 Bearer 打 https://www.fflogs.com/api/v2/client（公开数据，无需用户授权）
 *   凭据放 plugins/example/fflogs.json：{ clientId, clientSecret }
 *
 * ── 关键实测结论（2026-10-23）──
 *   ✅ 国服服务器 slug 就是**中文名**（"白银乡"），不是拼音；拼音会返回 character: null
 *   ✅ character.zoneRankings(zoneID) 返回类型是 JSON 标量，**不能写子选择集**
 *   ✅ zoneRankings 里同时带 rankPercent / bestAmount / totalKills / fastestKill / allStars
 *   ✅ 全明星积分与排名只有 v2 有，v1 REST 没有这个概念
 *
 *   ❗❗ **同一个绝本在 FFLogs 里有多份 encounter 副本，每个资料片 zone 一份，ID 不同。**
 *       旧版本上传的战斗记录只挂在**旧 zone 的副本**上，查 zone 59 永远看不到。
 *       实测某国服角色：亚历山大 z59 = 0 条，z43 = 28 条 74.22 分；
 *                            究极神兵 z59 = 2 条，z43 = 67 条 95.69 分。
 *       ⇒ 必须查全部 10 个历史 zone，再按绝本归并（kills 求和 / 分数取最高）。
 *       之前只查 59/65/76，才会出现「旧版本绝本显示未通关」。
 *
 *   绝本 encounter 副本对照：
 *       巴哈姆特 1039@19 · 1047@30 · 1060@43 · 1073@59
 *       究极神兵 1042@23 · 1048@30 · 1061@43 · 1074@59
 *       亚历山大 1050@32 · 1062@43 · 1075@59
 *       幻想龙诗 1065@45 · 1076@59
 *       欧米茄　 1068@53 · 1077@59
 *       光暗未来 1079@65 ｜ 妖星乱舞 1085@76
 */

const TOKEN_URL = 'https://www.fflogs.com/oauth/token'
const API_URL = 'https://www.fflogs.com/api/v2/client'
const CONF = path.join(process.cwd(), 'plugins/example/fflogs.json')

/**
 * 绝本清单：**7 个全抓**，而且每个绝本要查**它出现过的所有 zone**
 *
 * ★★ 关键（2026-10-23 实测）：FFLogs 给「同一个绝本」在**每个资料片 zone 里都存了一份
 *    encounter 副本**，encounterID 各不相同。旧版本上传的战斗记录只挂在**旧 zone 的副本**上，
 *    查 zone 59（Ultimates (Legacy)）永远拿不到 —— 这就是「旧版本绝本数据不显示」的根因。
 *    必须把 7 个绝本的所有副本 zone 都查一遍，再按绝本归并。
 *
 * 实测证据（某国服角色）：
 *    亚历山大：z43（1062）28 条 74.22 分 · z59（1075）**0 条** → 只查 59 就显示「未通关」
 *    究极神兵：z43（1061）67 条 95.69 分 · z59（1074）仅 2 条
 *    幻想龙诗：z45（1065）62 条 94.83 分 · z59（1076）43 条 97.17 分
 *    欧米茄　：z53（1068）19 条 61.05 分 · z59（1077）8 条 84.71 分
 *
 * zone 19/23/30/32 是更早的重复副本（实测多为 0），一并查以防遗漏。
 */
const ULT_LIST = [
  { name: '巴哈姆特绝境战', ids: [{ id: 1039, zone: 19 }, { id: 1047, zone: 30 }, { id: 1060, zone: 43 }, { id: 1073, zone: 59 }] },
  { name: '究极神兵绝境战', ids: [{ id: 1042, zone: 23 }, { id: 1048, zone: 30 }, { id: 1061, zone: 43 }, { id: 1074, zone: 59 }] },
  { name: '亚历山大绝境战', ids: [{ id: 1050, zone: 32 }, { id: 1062, zone: 43 }, { id: 1075, zone: 59 }] },
  { name: '幻想龙诗绝境战', ids: [{ id: 1065, zone: 45 }, { id: 1076, zone: 59 }] },
  { name: '欧米茄绝境验证战', ids: [{ id: 1068, zone: 53 }, { id: 1077, zone: 59 }] },
  { name: '光暗未来绝境战', ids: [{ id: 1079, zone: 65 }] },
  { name: '妖星乱舞绝境战', ids: [{ id: 1085, zone: 76 }] }
]
/** 24 人本（混沌）：暗黑之云 */
const CHAOS_LIST = [{ id: 2061, zone: 66 }]
/**
 * 零式：**只要当前大版本 7.x** 的三期（新→旧）
 *   73 重量级（5 层）· 68 中量级（4 层）· 62 轻量级（4 层）
 * 不做分期标题、不做资料片分组，13 层平铺
 */
const SAVAGE_LIST = [
  { id: 101, zone: 73 }, { id: 102, zone: 73 }, { id: 103, zone: 73 },
  { id: 104, zone: 73 }, { id: 105, zone: 73 },
  { id: 97, zone: 68 }, { id: 98, zone: 68 }, { id: 99, zone: 68 }, { id: 100, zone: 68 },
  { id: 93, zone: 62 }, { id: 94, zone: 62 }, { id: 95, zone: 62 }, { id: 96, zone: 62 }
]
/** 需要拉取的 zone 去重集合：绝本 10 个历史 zone + 混沌 1 + 零式 3 */
const ZONES = [...new Set([
  ...ULT_LIST.flatMap(u => u.ids.map(x => x.zone)),
  ...CHAOS_LIST.map(x => x.zone),
  ...SAVAGE_LIST.map(x => x.zone)
])]

/** encounterID → 中文名（取自 cn.fflogs.com 的 /v1/zones，2026-10-23 快照） */
const CN_NAME = {
  18: '压迫者', 19: '戈耳狄俄斯之袖', 20: '有生命活水', 21: '操纵者',
  26: '奇才 拉特芬克斯', 27: '弥达斯之袖', 28: '万事通 奎克辛克斯', 29: '残暴正义号',
  34: '废品翻新装置', 35: '佣兵雷姆普里克斯', 36: '巡航驱逐者', 37: '至尊亚历山大',
  42: '老者', 43: '灾变者', 44: '哈利卡纳苏斯', 45: '艾克斯迪司', 46: '新生艾克斯迪司',
  51: '魔列车', 52: '恶魔查达奴克', 53: '守护者', 54: '凯夫卡', 55: '神圣凯夫卡',
  60: '卡奥斯', 61: '尘世幻龙', 62: '欧米茄', 63: '双生欧米茄', 64: '至尊欧米茄',
  65: '至尊伊甸', 66: '虚空行者', 67: '利维亚桑', 68: '泰坦', 69: '拉姆',
  70: '伊弗利特与迦楼罗', 71: '暗黑心象', 72: '希瓦',
  73: '暗黑之云', 74: '影之王', 75: '绝命战士', 76: '伊甸之约', 77: '暗之巫女',
  78: '埃里克特翁尼亚斯', 79: '鱼尾海马怪', 80: '菲尼克司', 81: '赫斯珀洛斯', 82: '赫斯珀洛斯 II',
  83: '原型宝石兽', 84: '赫革摩涅', 85: '阿格狄斯提斯', 86: '赫淮斯托斯', 87: '赫淮斯托斯 II',
  88: '科库托斯', 89: '万魔殿', 90: '特弥斯', 91: '雅典娜', 92: '帕拉斯雅典娜',
  93: '黑猫', 94: '蜂蜂小甜心', 95: '野蛮爆弹狂人', 96: '狡雷',
  97: '热舞绿光', 98: '狂热糖潮', 99: '野蛮恨心', 100: '剑嚎',
  101: '致命美人', 102: '极限兄弟', 103: '霸王', 104: '林德布鲁姆', 105: '林德布鲁姆 II',
  2057: '普利修', 2058: '法夫尼尔', 2059: '方舟天使', 2060: '暗之王', 2061: '暗黑之云',
  5001: '浮士德', 5006: '蜂蜂浮士德', 5008: '浮士德 Z',
  1073: '巴哈姆特绝境战', 1074: '究极神兵绝境战', 1075: '亚历山大绝境战',
  1076: '幻想龙诗绝境战', 1077: '欧米茄绝境验证战', 1079: '光暗未来绝境战', 1085: '妖星乱舞绝境战'
}

/** 缓存 / 限流 */
const TOKEN_SKEW_MS = 60 * 1000
const CHAR_TTL_MS = 30 * 60 * 1000
const DATA_TTL_MS = 10 * 60 * 1000
const USER_CD_MS = 20 * 1000
const CONCURRENCY = 6
const TIMEOUT_MS = 15000

let tokenCache = { value: null, exp: 0 }
const charCache = new Map()   // `${server}|${name}` → { at, id, name, server }
const dataCache = new Map()   // characterId → { at, rows }
const userCd = new Map()      // userId → ts

/** 按 FFLogs 档位给 emoji（纯文本上不了色，用色块近似） */
function tierEmoji (p) {
  if (p == null) return '⬜'
  if (p >= 95) return '🟠'
  if (p >= 75) return '🟣'
  if (p >= 50) return '🔵'
  if (p >= 25) return '🟢'
  return '⚫'
}

function fmtNum (v, digit = 1) {
  if (v == null) return '-'
  return Number(v).toFixed(digit)
}

function fmtDuration (ms) {
  if (!ms || ms <= 0) return '-'
  // FFLogs 页面本身是向下取整（1125652ms 显示 18分45秒，不是 46）
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}分${String(s).padStart(2, '0')}秒`
}

function loadConf () {
  if (!fs.existsSync(CONF)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(CONF, 'utf8'))
    if (!raw.clientId || !raw.clientSecret) return null
    return raw
  } catch (err) {
    logger.error(`[fflogs] 配置文件解析失败：${err.message}`)
    return null
  }
}

async function getToken (force = false) {
  if (!force && tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value
  const conf = loadConf()
  if (!conf) throw new Error('NO_CONF')
  const basic = Buffer.from(`${conf.clientId}:${conf.clientSecret}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`TOKEN_${res.status}: ${text.slice(0, 160)}`)
  const data = JSON.parse(text)
  tokenCache = {
    value: data.access_token,
    exp: Date.now() + (data.expires_in * 1000) - TOKEN_SKEW_MS
  }
  return tokenCache.value
}

async function gql (query, retried = false) {
  const token = await getToken()
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (res.status === 401 && !retried) {
    await getToken(true)
    return gql(query, true)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`API_${res.status}: ${text.slice(0, 160)}`)
  const json = JSON.parse(text)
  if (json.errors?.length) throw new Error(`GQL: ${json.errors[0].message}`)
  return json.data
}

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

/** 中文服务器名 + 角色名 → characterId */
async function resolveCharacter (server, name) {
  const key = `${server}|${name}`.toLowerCase()
  const hit = charCache.get(key)
  if (hit && Date.now() - hit.at < CHAR_TTL_MS) return hit

  const q = `query { characterData { character(name: ${JSON.stringify(name)}, serverSlug: ${JSON.stringify(server)}, serverRegion: "CN") { id name server { name } } } }`
  const data = await gql(q)
  const ch = data?.characterData?.character
  if (!ch) return null
  const rec = { at: Date.now(), id: ch.id, name: ch.name, server: ch.server?.name || server }
  charCache.set(key, rec)
  return rec
}

/**
 * 拉所有 zone 的 rankings，按固定清单逐条输出
 * 关键：0 杀 / 无记录的副本**也要占一行**（标「未通关」），
 * 否则老版本绝本会被整行吞掉，看起来像「没抓历史数据」。
 */
async function fetchRows (characterId) {
  const cached = dataCache.get(characterId)
  if (cached && Date.now() - cached.at < DATA_TTL_MS) return cached.rows

  const results = await mapLimit(ZONES, CONCURRENCY, async zone => {
    try {
      const data = await gql(`query { characterData { character(id: ${characterId}) { zoneRankings(zoneID: ${zone}) } } }`)
      return { zone, zr: data?.characterData?.character?.zoneRankings }
    } catch (err) {
      logger.warn(`[fflogs] zone ${zone} 拉取失败：${err.message}`)
      return { zone, zr: null }
    }
  })

  const byEnc = new Map()
  for (const { zone, zr } of results) {
    if (!zr || !Array.isArray(zr.rankings)) continue
    for (const r of zr.rankings) {
      if (r?.encounter?.id == null) continue
      byEnc.set(r.encounter.id, { zone, raw: r })
    }
  }

  /** 单条 encounter（混沌 / 零式）：直接取 zone 返回值 */
  const buildOne = ({ id, zone }, group) => {
    const r = byEnc.get(id)?.raw
    const kills = r?.totalKills || 0
    const star = r?.allStars || {}
    return {
      group,
      zone,
      id,
      name: CN_NAME[id] || r?.encounter?.name || `#${id}`,
      cleared: kills > 0 && r?.rankPercent != null,
      percent: r?.rankPercent == null ? null : Number(r.rankPercent),
      rdps: kills > 0 && r?.bestAmount ? Number(r.bestAmount) : null,
      kills,
      starPoints: kills > 0 && star.points ? Number(star.points) : null,
      starRank: kills > 0 && star.rank != null ? Number(star.rank) : null,
      fastest: r?.fastestKill || 0,
      lockedIn: r?.lockedIn !== false
    }
  }

  /**
   * 绝本：把同一绝本在**所有历史 zone 副本**里的记录合并成一行
   *   kills    = 各副本求和（同一次击杀只挂在其中一个副本上，不会重复）
   *   percent / rdps = 取最高分那一条（FFLogs 网页显示的也是最好成绩）
   *   全明星   = 取最高积分
   *   fastest  = 取最快的非 0 值
   */
  const buildUlt = ({ name, ids }) => {
    const parts = ids.map(x => byEnc.get(x.id)).filter(p => p?.raw)
    const live = parts.filter(p => (p.raw.totalKills || 0) > 0 && p.raw.rankPercent != null)
    if (!live.length) {
      return {
        group: 'ult',
        zone: ids[0].zone,
        id: ids[0].id,
        name,
        cleared: false,
        percent: null,
        rdps: null,
        kills: 0,
        starPoints: null,
        starRank: null,
        fastest: 0,
        lockedIn: true
      }
    }
    const best = live.reduce((a, b) => (Number(b.raw.rankPercent) > Number(a.raw.rankPercent) ? b : a))
    const star = live
      .map(p => p.raw.allStars || {})
      .filter(s => s.points != null)
      .sort((a, b) => Number(b.points) - Number(a.points))[0]
    const fastest = live
      .map(p => p.raw.fastestKill || 0)
      .filter(x => x > 0)
      .sort((a, b) => a - b)[0] || 0
    return {
      group: 'ult',
      zone: best.zone,
      id: best.raw.encounter.id,
      name,
      cleared: true,
      percent: Number(best.raw.rankPercent),
      rdps: best.raw.bestAmount ? Number(best.raw.bestAmount) : null,
      kills: live.reduce((s, p) => s + (p.raw.totalKills || 0), 0),
      starPoints: star?.points == null ? null : Number(star.points),
      starRank: star?.rank == null ? null : Number(star.rank),
      fastest,
      lockedIn: live.every(p => p.raw.lockedIn !== false)
    }
  }

  const rows = [
    ...ULT_LIST.map(buildUlt),
    ...CHAOS_LIST.map(x => buildOne(x, 'chaos')),
    ...SAVAGE_LIST.map(x => buildOne(x, 'savage'))
  ]
  dataCache.set(characterId, { at: Date.now(), rows })
  return rows
}

function buildText (ch, rows) {
  const lines = [`FFLogs · ${ch.name} @ ${ch.server}`]

  const one = r => r.cleared
    ? `${tierEmoji(r.percent)} ${r.name}${r.lockedIn ? '' : ' 🔒'}  Best ${Math.floor(r.percent)} · RDPS ${fmtNum(r.rdps)} · ${r.kills}杀 · 全明星 ${fmtNum(r.starPoints, 2)}${r.starRank == null ? '' : `(#${r.starRank})`} · 最快 ${fmtDuration(r.fastest)}`
    : `⚫ ${r.name} · 未通关`

  for (const [g, title] of [['ult', '绝本'], ['chaos', '24人本 · 高难度'], ['savage', '零式（当前大版本）']]) {
    const seg = rows.filter(r => r.group === g)
    if (!seg.length) continue
    lines.push(`—— ${title}（${seg.filter(r => r.cleared).length}/${seg.length}）——`)
    for (const r of seg) lines.push(' ' + one(r))
  }

  lines.push('数据来源：FFLogs（cn.fflogs.com）')
  if (rows.some(r => !r.lockedIn)) lines.push('🔒 = 该记录未锁定')
  return lines.join('\n')
}

/* ───────────────────────── 图片渲染 ───────────────────────── */

const BROWSER_PATH = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find(p => fs.existsSync(p)) || 'msedge'

/** FFLogs 档位配色：100 粉 / 95+ 橙 / 75+ 紫 / 50+ 蓝 / 25+ 绿 / 其余灰 */
function tierColor (p) {
  if (p == null) return '#9d9d9d'
  if (p >= 100) return '#e268a8'
  if (p >= 95) return '#ff8000'
  if (p >= 75) return '#a335ee'
  if (p >= 50) return '#0070dd'
  if (p >= 25) return '#1eff00'
  return '#9d9d9d'
}

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

const PAGE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0e0e12;padding:16px;font-family:'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif;-webkit-font-smoothing:antialiased}
  .card{width:860px;background:#1a1a21;border:1px solid #2c2c38;border-radius:14px;overflow:hidden}
  .head{display:flex;justify-content:space-between;align-items:flex-end;padding:20px 22px 16px;border-bottom:1px solid #2c2c38;background:linear-gradient(180deg,#20202a,#1a1a21)}
  .cname{font-size:24px;font-weight:600;color:#fff;letter-spacing:.4px;line-height:1.15}
  .csub{font-size:12.5px;color:#8a8a9c;margin-top:5px}
  .brand{font-size:11px;color:#6a6a7c;letter-spacing:2px;font-weight:600}
  .brand b{color:#9a9ab0}
  .sec{padding:4px 0 2px}
  .sec-title{display:flex;align-items:center;gap:8px;padding:14px 22px 8px;font-size:13px;font-weight:600;color:#c9c9d8;letter-spacing:.6px}
  .sec-title::before{content:'';width:3px;height:13px;border-radius:2px;background:#5b6ee1}
  .sec-title .cnt{font-size:11px;color:#6a6a7c;font-weight:400;background:#26262f;padding:1px 7px;border-radius:9px}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th{font-size:11.5px;font-weight:500;color:#72728a;padding:7px 8px;text-align:center;border-bottom:1px solid #282833;white-space:nowrap}
  td{padding:6px 8px;font-size:13px;text-align:center;color:#d6d6e2;border-bottom:1px solid #1f1f27;font-variant-numeric:tabular-nums}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:nth-child(even){background:#1d1d25}
  .left{text-align:left;padding-left:22px}
  th.left{padding-left:22px}
  .bname{font-size:13.5px;color:#eaeaf2}
  .lock{font-size:10px;margin-left:4px;opacity:.5}
  .badge{display:inline-block;min-width:42px;padding:2px 6px;border-radius:5px;border:1px solid transparent;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
  .num{color:#c2c2d2}
  .dim{color:#7d7d92}
  .nt{font-size:10px;color:#6a6a7c;margin-left:6px;border:1px solid #34343f;padding:0 4px;border-radius:4px;font-weight:400;vertical-align:1px}
  .badge-off{color:#5f5f70;background:#5f5f7014;border-color:#5f5f7033}
  tr.nc{opacity:.45}
  .foot{display:flex;justify-content:space-between;padding:12px 22px;border-top:1px solid #2c2c38;background:#16161c;font-size:11px;color:#5f5f70}
`

function buildHtml (ch, rows) {
  const tr = r => r.cleared ? `
          <tr${r.lockedIn ? '' : ' style="opacity:.82"'}>
            <td class="left bname">${esc(r.name)}${r.lockedIn ? '' : '<span class="lock">🔒</span>'}</td>
            <td><span class="badge" style="color:${tierColor(r.percent)};background:${tierColor(r.percent)}1f;border-color:${tierColor(r.percent)}4d">${Math.floor(r.percent)}</span></td>
            <td class="num">${fmtNum(r.rdps)}</td>
            <td class="num">${r.kills}</td>
            <td class="num">${fmtNum(r.starPoints, 2)}</td>
            <td class="num dim">${r.starRank == null ? '-' : '#' + r.starRank}</td>
            <td class="num">${fmtDuration(r.fastest)}</td>
          </tr>` : `
          <tr class="nc">
            <td class="left bname">${esc(r.name)}<span class="nt">未通关</span></td>
            <td><span class="badge badge-off">-</span></td>
            <td class="num">-</td><td class="num">0</td><td class="num">-</td><td class="num dim">-</td><td class="num">-</td>
          </tr>`

  const table = list => `
      <table>
        <colgroup>
          <col><col style="width:66px"><col style="width:98px"><col style="width:58px">
          <col style="width:78px"><col style="width:74px"><col style="width:100px">
        </colgroup>
        <thead><tr>
          <th class="left">副本</th><th>Best</th><th>最高 RDPS</th><th>Kills</th>
          <th>全明星</th><th>排名</th><th>最快击杀</th>
        </tr></thead>
        <tbody>${list.map(tr).join('')}
        </tbody>
      </table>`

  const section = (title, list) => list.length ? `
    <div class="sec">
      <div class="sec-title">${esc(title)}<span class="cnt">${list.filter(r => r.cleared).length}/${list.length}</span></div>
      ${table(list)}
    </div>` : ''

  const hasLock = rows.some(r => !r.lockedIn)
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head>
<body><div class="card">
  <div class="head">
    <div>
      <div class="cname">${esc(ch.name)}</div>
      <div class="csub">${esc(ch.server)} · 国服</div>
    </div>
    <div class="brand"><b>FFLOGS</b> REPORT</div>
  </div>
  ${section('绝本', rows.filter(r => r.group === 'ult'))}
  ${section('24人本 · 高难度', rows.filter(r => r.group === 'chaos'))}
  ${section('零式 · 当前大版本 7.x', rows.filter(r => r.group === 'savage'))}
  <div class="foot">
    <span>数据来源：FFLogs · cn.fflogs.com</span>
    <span>${hasLock ? '🔒 未锁定 · ' : ''}${new Date().toLocaleString('zh-CN', { hour12: false })}</span>
  </div>
</div></body></html>`
}

/** 起一个无头浏览器把 HTML 截成 PNG（自己 spawn，忽略 stdin 防阻塞控制台） */
async function renderImage (html) {
  const port = 9400 + Math.floor(Math.random() * 200)
  const proc = spawn(BROWSER_PATH, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--lang=zh-CN',
    `--remote-debugging-port=${port}`
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: false })

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('浏览器启动超时')), 15000)
      const probe = async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/version`)
          if (r.ok) { clearTimeout(timer); resolve() } else setTimeout(probe, 200)
        } catch { setTimeout(probe, 200) }
      }
      probe()
    })
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const browser = await puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl })
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 892, height: 900, deviceScaleFactor: 2 })
      await page.setContent(html, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready).catch(() => {})
      return await page.screenshot({ type: 'png', fullPage: true })
    } finally {
      // browser.close() 在 connect 模式下可能一直等目标进程退出，最多等 3 秒就强杀
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 3000))
      ])
    }
  } finally {
    try { proc.kill() } catch {}
  }
}

export class fflogs extends plugin {
  constructor () {
    super({
      name: 'FFLogs查询',
      dsc: '查角色的绝本与零式 FFLogs 数据',
      event: 'message',
      // 0：必须排在 ff14wiki(priority 1) 之前，否则 #fflogs 会被它的 #f 短命令抢先吃掉
      priority: 0,
      rule: [
        { reg: '^#fflogs\\s+(.+)$', fnc: 'query' },
        { reg: '^#fflogs$', fnc: 'usage' }
      ]
    })
  }

  async usage () {
    await this.e.reply(
      '用法：#fflogs <服务器> <角色名>\n' +
      '例：#fflogs 服务器名 角色名\n' +
      '查 7 个绝本（含旧版本）+ 暗黑之云 + 当前大版本零式\n' +
      '服务器用中文名（白银乡 / 红玉海 / 神意之地…）'
    )
    return true
  }

  async query () {
    const raw = this.e.msg.replace(/^#fflogs\s+/, '').trim()
    const parts = raw.split(/\s+/)
    if (parts.length < 2) return this.usage()

    // 服务器名可能不含空格，角色名允许带空格
    const server = parts[0]
    const name = parts.slice(1).join(' ')
    if (!name) return this.usage()

    const cdKey = `${this.e.user_id}`
    const last = userCd.get(cdKey) || 0
    if (Date.now() - last < USER_CD_MS) {
      await this.e.reply(`查太勤了，${Math.ceil((USER_CD_MS - (Date.now() - last)) / 1000)} 秒后再试`)
      return true
    }
    userCd.set(cdKey, Date.now())

    if (!loadConf()) {
      await this.e.reply('[fflogs] 缺少 plugins/example/fflogs.json（clientId / clientSecret），先配好再用')
      return true
    }

    try {
      const ch = await resolveCharacter(server, name)
      if (!ch) {
        await this.e.reply(`查不到「${name} @ ${server}」。\n国服服务器要用中文名（白银乡 / 红玉海 / 神意之地…），角色名大小写不限`)
        return true
      }
      const rows = await fetchRows(ch.id)
      if (!rows.some(r => r.cleared)) {
        await this.e.reply(`${ch.name} @ ${ch.server} 在 FFLogs 上没有任何绝本 / 零式通关记录`)
        return true
      }
      let img = null
      try {
        img = await renderImage(buildHtml(ch, rows))
      } catch (err) {
        logger.warn(`[fflogs] 图片渲染失败，回退纯文本：${err.message}`)
      }
      if (img) await this.e.reply(segment.image('base64://' + img.toString('base64')))
      else await this.e.reply(buildText(ch, rows))
      return true
    } catch (err) {
      logger.error(`[fflogs] 查询失败：${err.stack || err.message}`)
      if (String(err.message).startsWith('NO_CONF')) {
        await this.e.reply('[fflogs] 缺少 plugins/example/fflogs.json')
      } else if (String(err.message).startsWith('TOKEN_401')) {
        await this.e.reply('[fflogs] 凭据被拒绝，检查 clientId / clientSecret 是否有效')
      } else {
        await this.e.reply(`[fflogs] 查询失败：${String(err.message).slice(0, 120)}`)
      }
      return true
    }
  }
}
