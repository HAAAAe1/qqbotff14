/**
 * voice-music.js —— 本地曲库 + 语音消息放歌（发「高潮片段」）
 *
 * 命令
 *   #放首歌               随机抽一首，截高潮 60 秒发语音（连着抽不会马上重复同一首）
 *                         同义触发词：#听首歌 / #放音乐
 *   #放首歌 45            随机抽一首，截 45 秒
 *   #放整首 [歌名]         完整播放：按 60 秒拆成多条语音依次发（不带歌名则随机）
 *                         同义触发词：#听整首 / #放全曲
 *   #音乐 <歌名>            自动定位高潮段落，截 60 秒发语音
 *   #音乐 <歌名> 45         从高潮起点开始截 45 秒
 *   #音乐 <歌名> 60-95      手动指定起止秒数
 *   #音乐列表               列出曲库全部歌曲（分页）
 *   #音乐信息 <歌名>        看时长 / 高潮段 / 是否手工标注
 *   #音乐扫描               重新扫描曲库目录（仅 bot 管理员）
 *   #音乐标注 <歌名> 60-95  记住这首歌的高潮区间，下次直接用（仅 bot 管理员）
 *   #音乐清除标注 <歌名>    删掉标注，回到自动分析（仅 bot 管理员）
 *
 * 曲库目录：默认 D:/QQBot/music，可用环境变量 VOICE_MUSIC_DIR 覆盖
 * 支持格式：mp3 flac wav m4a ogg aac wma opus ape
 *
 * 高潮定位（三层，优先级由高到低）
 *   1. 手工标注（data/voice-hooks.json，按文件 mtime 校验，文件变了自动失效）
 *   2. 自动分析：ffmpeg 解码成 16kHz 单声道 PCM → 每 0.5s 一帧算 RMS 响度 + 差分能量(高频代理)
 *      → 滑动 28s 窗口，取「响度+高频」最高且内部稳定的一段；副歌通常在 22%~88%，区间外轻微降权
 *   3. 没有位置兜底：解码失败直接报错，不瞎切一段糊弄
 *
 * 发送：segment.record(本地文件) → SnowLuma 自己用 ffmpeg 转 NT silk 后发送，无需手动转码
 * 注意：QQ 语音是 8kHz 单声道，音质约等于电话；服务端限制约 60 秒
 *       ⇒ 想完整听一首用 #放整首，按 60 秒拆成几条依次发
 */
import plugin from '../../lib/plugins/plugin.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MUSIC_DIR = process.env.VOICE_MUSIC_DIR || 'D:/QQBot/music'
const DATA_DIR = path.join(__dirname, 'data')
const HOOK_FILE = path.join(DATA_DIR, 'voice-hooks.json')
const TMP_DIR = path.join(DATA_DIR, 'voice-tmp')

const AUDIO_EXT = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.ape']
const DEFAULT_CLIP = 60
const MAX_CLIP = 60

/** 整首播放的触发词 */
const FULL_ALIASES = ['放整首', '听整首', '放全曲']
const FULL_REG_SRC = FULL_ALIASES.join('|')
const FULL_MSG_RE = new RegExp(`^#(?:${FULL_REG_SRC})\\s*(.*)$`)
/** 整首最多拆几段（1 段 = 60 秒），再长就不整首放了，防止刷屏 */
const FULL_MAX_SEG = 12
/** 段间停顿，连发太快容易被协议端/服务端限流 */
const FULL_GAP_MS = 1200

/** 随机播放的触发词，加别名只改这里 */
const RANDOM_ALIASES = ['放首歌', '听首歌', '放音乐']
const RANDOM_REG_SRC = RANDOM_ALIASES.join('|')
/** 匹配「标记 + 可选时长」的整句，用于 random() 里取时间参数 */
const RANDOM_MSG_RE = new RegExp(`^#(?:${RANDOM_REG_SRC})\\s*(.*)$`)

const SAMPLE_RATE = 16000
const FRAME_SEC = 0.5

/** 随机播放队列（洗牌袋）：一轮内不重复，播完重新洗牌；lastPlayed 用来避免跨轮立刻重复 */
let playQueue = []
let lastPlayed = ''

/* ---------------- ffmpeg ---------------- */

let ffmpegPath = null
const FF_CANDIDATES = [
  process.env.FFMPEG_PATH,
  'ffmpeg',
  'D:/ffmpeg/ffmpeg-9.0-essentials_build/bin/ffmpeg.exe',
  'C:/ffmpeg/bin/ffmpeg.exe'
].filter(Boolean)

async function ensureFfmpeg () {
  if (ffmpegPath) return ffmpegPath
  for (const cand of FF_CANDIDATES) {
    try {
      await exec(cand, ['-version'], { timeout: 8000 })
      ffmpegPath = cand
      return cand
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 ffmpeg，请设置环境变量 FFMPEG_PATH')
}

/** ffprobe 是独立程序，不能拿 ffmpeg 冒充（参数不认，会静默返回空） */
let ffprobePath = null
async function ensureFfprobe () {
  if (ffprobePath) return ffprobePath
  const cands = [
    process.env.FFPROBE_PATH,
    'ffprobe',
    ffmpegPath && ffmpegPath.replace(/ffmpeg(\.exe)?$/i, m => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')),
    'D:/ffmpeg/ffmpeg-9.0-essentials_build/bin/ffprobe.exe',
    'C:/ffmpeg/bin/ffprobe.exe'
  ].filter(Boolean)
  for (const cand of cands) {
    try {
      await exec(cand, ['-version'], { timeout: 8000 })
      ffprobePath = cand
      return cand
    } catch { /* 试下一个 */ }
  }
  return null
}

/* ---------------- 曲库索引 ---------------- */

function walk (dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.')) continue
      walk(full, out, depth + 1)
    } else if (AUDIO_EXT.includes(path.extname(ent.name).toLowerCase())) {
      if (ent.name.startsWith('tmp-')) continue
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      out.push({
        name: path.basename(ent.name, path.extname(ent.name)),
        file: full.replace(/\\/g, '/'),
        ext: path.extname(ent.name).toLowerCase(),
        size: st.size,
        mtime: st.mtimeMs
      })
    }
  }
  return out
}

/**
 * 每次实时扫目录（readdir + stat，几十首歌只要几毫秒）
 * 不做跨命令缓存：否则刚丢进来的歌会因为「空曲库缓存」而认不出来
 */
function scanLibrary () {
  return walk(MUSIC_DIR).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/* ---------------- 歌名匹配 ---------------- */

const PUNCT = /[\s,，。、;；:：!！?？~～·\-—_()（）[\]【】"'“”‘’/\\]/g
const norm = s => String(s || '').toLowerCase().replace(PUNCT, '')

function bigrams (s) {
  const o = new Set()
  for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2))
  return o
}

function scoreTrack (track, q) {
  const name = norm(track.name)
  const raw = norm(q)
  if (!raw) return 0
  let score = 0
  if (name === raw) score += 1000
  else if (name.includes(raw)) score += 600 + Math.round(200 * (raw.length / name.length))
  else if (raw.includes(name)) score += 420

  const chars = [...new Set(raw)]
  if (chars.length) {
    const text = name
    const hit = chars.filter(c => text.includes(c)).length
    score += 160 * (hit / chars.length) ** 2
  }
  const bg = bigrams(raw)
  if (bg.size) {
    let h = 0
    for (const b of bg) if (name.includes(b)) h++
    score += 300 * (h / bg.size)
  }
  return score
}

function search (tracks, q) {
  const scored = tracks
    .map(t => ({ t, s: scoreTrack(t, q) }))
    .filter(x => x.s >= 120)
    .sort((a, b) => b.s - a.s || a.t.name.length - b.t.name.length)
  return scored
}

/**
 * 洗牌袋随机：一轮内每首都会轮到一次，播完重洗
 * 新的一轮第一首不会和上一轮最后一首重复；曲库删掉的歌会自动从队列清掉
 */
function nextRandom (tracks) {
  if (!tracks.length) return null
  const alive = new Set(tracks.map(t => t.file))
  playQueue = playQueue.filter(f => alive.has(f))
  if (!playQueue.length) {
    playQueue = tracks.map(t => t.file)
    for (let i = playQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = playQueue[i]
      playQueue[i] = playQueue[j]
      playQueue[j] = tmp
    }
    if (playQueue.length > 1 && playQueue[0] === lastPlayed) playQueue.push(playQueue.shift())
  }
  const file = playQueue.shift()
  lastPlayed = file
  return tracks.find(t => t.file === file) || null
}

/* ---------------- 时长 / 高潮分析 ---------------- */

async function probeDuration (file) {
  const probe = await ensureFfprobe()
  if (probe) {
    try {
      const { stdout } = await exec(probe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', file
      ], { timeout: 20000 })
      const d = parseFloat(String(stdout).trim())
      if (Number.isFinite(d) && d > 0) return d
    } catch { /* 落到下面用 ffmpeg 兜底 */ }
  }
  // 没有 ffprobe 时用 ffmpeg 解码一遍读时长（慢一点，但能用）
  try {
    const ff = await ensureFfmpeg()
    const { stderr } = await exec(ff, ['-i', file, '-f', 'null', '-'], { timeout: 90000 })
    const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  } catch (err) {
    const m = String(err.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return 0
}

async function decodePcm (file) {
  const ff = await ensureFfmpeg()
  const { stdout } = await exec(ff, [
    '-v', 'error', '-i', file,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-'
  ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 90000 })
  return stdout
}

function frameMetrics (pcm) {
  const per = Math.floor(SAMPLE_RATE * FRAME_SEC)
  const n = Math.floor(pcm.length / 2 / per)
  const rdb = new Float64Array(n)
  const hdb = new Float64Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    let dsum = 0
    let prev = 0
    const base = f * per
    for (let i = 0; i < per; i++) {
      const s = pcm.readInt16LE((base + i) * 2) / 32768
      sum += s * s
      const d = s - prev
      dsum += d * d
      prev = s
    }
    rdb[f] = 20 * Math.log10(Math.max(Math.sqrt(sum / per), 1e-6))
    hdb[f] = 20 * Math.log10(Math.max(Math.sqrt(dsum / per), 1e-6))
  }
  return { n, rdb, hdb }
}

function normalize (arr) {
  let lo = Infinity
  let hi = -Infinity
  for (const v of arr) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || hi - lo < 1e-6) return arr.map(() => 0)
  return Array.from(arr, v => (v - lo) / (hi - lo))
}

/** 返回 { start, end, auto } */
async function analyzeHook (file, totalSec, clipSec = 28) {
  const pcm = await decodePcm(file)
  const { n, rdb, hdb } = frameMetrics(pcm)
  if (!n) throw new Error('音频无法解码')

  const nr = normalize(rdb)
  const nh = normalize(hdb)
  const score = nr.map((v, i) => 0.72 * v + 0.28 * nh[i])

  const win = Math.max(4, Math.round(clipSec / FRAME_SEC))
  let best = { start: 0, s: -Infinity }
  const dur = totalSec || n * FRAME_SEC
  for (let i = 0; i + win <= n; i++) {
    let sum = 0
    let sum2 = 0
    for (let k = i; k < i + win; k++) {
      sum += score[k]
      sum2 += score[k] * score[k]
    }
    const mean = sum / win
    const variance = sum2 / win - mean * mean
    const t = (i * FRAME_SEC) / dur
    const prior = t < 0.22 || t > 0.88 ? 0.94 : 1
    const s = (mean - 0.35 * Math.sqrt(Math.max(variance, 0))) * prior
    if (s > best.s) best = { start: i * FRAME_SEC, s }
  }
  return { start: best.start, end: Math.min(best.start + clipSec, dur || Infinity), auto: true }
}

/* ---------------- 标注存储 ---------------- */

function readHooks () {
  try {
    return JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeHooks (obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(HOOK_FILE, JSON.stringify(obj, null, 2), 'utf8')
}

function hookKey (track) {
  return track.file
}

function cachedHook (track) {
  const rec = readHooks()[hookKey(track)]
  if (!rec) return null
  if (Math.abs(Number(rec.mtime) - track.mtime) > 1000) return null // 文件换过了，作废
  return rec
}

function saveHook (track, start, end, manual) {
  const all = readHooks()
  all[hookKey(track)] = { start, end, manual, mtime: track.mtime, at: Date.now() }
  writeHooks(all)
}

/* ---------------- 截取 ---------------- */

async function cutClip (file, start, dur, out) {
  const ff = await ensureFfmpeg()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await exec(ff, [
    '-y', '-v', 'error',
    '-ss', String(Math.max(0, start)),
    '-t', String(dur),
    '-i', file,
    '-vn', '-ac', '1', '-ar', '24000', '-b:a', '64k',
    out
  ], { timeout: 60000 })
  if (!fs.existsSync(out) || fs.statSync(out).size < 512) throw new Error('截取失败，片段为空')
  return out
}

function cleanTmp (maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f)
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p)
      } catch { /* 单个删不掉就算了 */ }
    }
  } catch { /* 目录不存在 */ }
}

/* ---------------- 工具 ---------------- */

function fmtDuration (sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '-'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 解析 "60-95" / "45" / "60→95" */
function parseRange (arg, totalSec, hookStart) {
  if (!arg) return null
  const m = String(arg).match(/^(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)$/)
  if (m) {
    const start = parseFloat(m[1])
    const end = parseFloat(m[2])
    if (!(end > start)) return { error: '结束时间要大于开始时间' }
    return { start, duration: Math.min(end - start, MAX_CLIP) }
  }
  const d = String(arg).match(/^(\d+(?:\.\d+)?)$/)
  if (d) {
    const dur = Math.min(Math.max(parseFloat(d[1]), 1), MAX_CLIP)
    return { start: hookStart || 0, duration: dur, fromHook: true, onlyDuration: true }
  }
  return { error: `看不懂「${arg}」，用法：60-95（起止秒数）或 45（时长秒数）` }
}

/* ---------------- 插件 ---------------- */

export class voiceMusic extends plugin {
  constructor () {
    super({
      name: '音乐放歌',
      dsc: '本地曲库发语音消息，自动截高潮片段',
      event: 'message',
      priority: 200,
      rule: [
        { reg: '^#音乐扫描$', fnc: 'rescan', permission: 'master' },
        { reg: '^#音乐列表\\s*(\\d*)$', fnc: 'list' },
        { reg: '^#音乐标注\\s+(.+)$', fnc: 'mark' },
        { reg: '^#音乐清除标注\\s+(.+)$', fnc: 'unmark' },
        { reg: '^#音乐信息\\s+(.+)$', fnc: 'info' },
        { reg: `^#(?:${FULL_REG_SRC})(?:\\s+(.+))?$`, fnc: 'full' },
        { reg: `^#(?:${RANDOM_REG_SRC})\\s*(\\d+(?:\\s*[-~到至]\\s*\\d+)?)?$`, fnc: 'random' },
        { reg: '^#音乐(?:\\s+(.+))?$', fnc: 'play' }
      ]
    })
  }

  async rescan () {
    const tracks = scanLibrary()
    await this.e.reply(`已重新扫描曲库：${MUSIC_DIR}\n共 ${tracks.length} 首`)
    return true
  }

  async list () {
    const tracks = scanLibrary()
    if (!tracks.length) {
      await this.e.reply(`曲库是空的。\n把 mp3 / flac 等音频放进：${MUSIC_DIR}\n放好后发 #音乐扫描（仅bot管理员）`)
      return true
    }
    const lines = [`🎵 曲库共 ${tracks.length} 首`, '']
    tracks.forEach((t, i) => lines.push(`${i + 1}. ${t.name}`))
    lines.push('', `曲库目录：${MUSIC_DIR}`)
    if (tracks.length > 200) lines.push('曲库比较大，找歌直接发 #音乐 歌名 更快')

    // 不分页，全部塞进一个转发气泡
    const text = lines.join('\n')
    const ok = await this.sendForward([text])
    if (!ok) await this.e.reply(text)
    return true
  }

  /** 合并转发聊天记录；成功 true，失败 false（调用方回退纯文本） */
  async sendForward (messages) {
    const send = this.e.group?.sendForwardMsg || this.e.friend?.sendForwardMsg
    if (!send) return false
    const nodes = messages.map(message => ({
      message,
      nickname: this.e.bot?.nickname || '机器人',
      user_id: this.e.bot?.uin || this.e.self_id
    }))
    try {
      await send(nodes)
      return true
    } catch (err) {
      logger?.warn?.(`[voice-music] 转发发送失败：${err.message}`)
      return false
    }
  }

  async mark () {
    const raw = this.e.msg.replace(/^#音乐标注\s+/, '').trim()
    const m = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)$/)
    if (!m) {
      await this.e.reply('用法：#音乐标注 <歌名> <起>-<止>\n例：#音乐标注 晴天 62-95')
      return true
    }
    const tracks = scanLibrary()
    const hits = search(tracks, m[1])
    if (!hits.length) {
      await this.e.reply(`曲库里找不到「${m[1]}」`)
      return true
    }
    const start = parseFloat(m[2])
    const end = parseFloat(m[3])
    if (!(end > start)) {
      await this.e.reply('结束时间要大于开始时间')
      return true
    }
    const t = hits[0].t
    saveHook(t, start, end, true)
    const dur = await probeDuration(t.file)
    if (dur && end > dur + 1) {
      await this.e.reply(`⚠️ 已保存，但这首歌只有 ${fmtDuration(dur)}，标注的 ${fmtDuration(end)} 超出了`)
      return true
    }
    await this.e.reply(`✅ 已标注：${t.name}\n高潮段 ${fmtDuration(start)} - ${fmtDuration(end)}（${(end - start).toFixed(0)} 秒）`)
    return true
  }

  async unmark () {
    const q = this.e.msg.replace(/^#音乐清除标注\s+/, '').trim()
    const tracks = scanLibrary()
    const hits = search(tracks, q)
    if (!hits.length) {
      await this.e.reply(`曲库里找不到「${q}」`)
      return true
    }
    const t = hits[0].t
    const all = readHooks()
    if (!all[hookKey(t)]) {
      await this.e.reply(`${t.name} 本来就没有标注`)
      return true
    }
    delete all[hookKey(t)]
    writeHooks(all)
    await this.e.reply(`已清除 ${t.name} 的标注，下次会重新自动分析`)
    return true
  }

  async info () {
    const q = this.e.msg.replace(/^#音乐信息\s+/, '').trim()
    const tracks = scanLibrary()
    const hits = search(tracks, q)
    if (!hits.length) {
      await this.e.reply(`曲库里找不到「${q}」`)
      return true
    }
    const t = hits[0].t
    await this.e.reply(`识别中…`).catch(() => {})
    try {
      const dur = await probeDuration(t.file)
      const cached = cachedHook(t)
      const hook = cached || await analyzeHook(t.file, dur)
      const lines = [
        `🎵 ${t.name}`,
        `时长 ${fmtDuration(dur)} · 大小 ${(t.size / 1024 / 1024).toFixed(1)}MB · ${t.ext.replace('.', '')}`,
        `高潮段 ${fmtDuration(hook.start)} - ${fmtDuration(hook.end)}${hook.manual || !hook.auto ? '（手工标注）' : '（自动分析）'}`,
        `路径 ${t.file}`
      ]
      if (hits.length > 1) {
        lines.push('', '其他可能的匹配：')
        hits.slice(1, 4).forEach(h => lines.push(`· ${h.t.name}`))
      }
      await this.e.reply(lines.join('\n'))
    } catch (err) {
      await this.e.reply(`分析失败：${err.message}`)
    }
    return true
  }

  async play () {
    const tracks = scanLibrary()
    if (!tracks.length) {
      await this.e.reply(`曲库是空的。\n把 mp3 / flac 等音频放进：${MUSIC_DIR}\n放好后发 #音乐扫描（仅bot管理员）`)
      return true
    }

    const raw = (this.e.msg.match(/^#音乐(?:\s+(.+))?$/)?.[1] || '').trim()
    if (!raw) {
      await this.e.reply(
        '🎵 音乐放歌\n' +
        '· #放首歌 —— 随机放一首，自动截高潮 60 秒\n' +
        '· 同义触发词：#听首歌 / #放音乐\n' +
        '· #放整首 / #放整首 晴天 —— 完整播放，按 60 秒拆成几条语音\n' +
        '· #音乐 晴天 —— 指定歌曲，自动截高潮 60 秒\n' +
        '· #音乐 晴天 45 —— 从高潮起截 45 秒（最长 60）\n' +
        '· #音乐 晴天 62-95 —— 手动指定起止\n' +
        '· #音乐列表 —— 看曲库\n' +
        '· #音乐信息 晴天 —— 看时长和高潮段\n' +
        `曲库目录：${MUSIC_DIR}`
      )
      return true
    }

    // 拆出可选的「时间参数」：末尾 token 形如 45 / 60-95
    let query = raw
    let timeArg = ''
    const tail = raw.match(/^(.*?)\s+(\d+(?:\.\d+)?(?:\s*[-~到至]\s*\d+(?:\.\d+)?)?)$/)
    if (tail) {
      query = tail[1].trim()
      timeArg = tail[2]
    }

    const hits = search(tracks, query)
    if (!hits.length) {
      await this.e.reply(`曲库里找不到「${query}」\n发 #音乐列表 看有哪些歌`)
      return true
    }

    // 多个分数接近 → 让用户选，不瞎猜
    if (hits.length > 1 && hits[1].s > hits[0].s * 0.92 && hits[1].s >= 400) {
      const lines = [`「${query}」匹配到多首，说清楚一点：`, '']
      hits.slice(0, 6).forEach((h, i) => lines.push(`${i + 1}. ${h.t.name}`))
      await this.e.reply(lines.join('\n'))
      return true
    }

    return this.sendTrack(hits[0].t, timeArg)
  }

  /** 随机放一首：最近 5 首不会重复 */
  async random () {
    const tracks = scanLibrary()
    if (!tracks.length) {
      await this.e.reply(`曲库是空的。\n把 mp3 / flac 等音频放进：${MUSIC_DIR}\n放好后发 #音乐扫描（仅bot管理员）`)
      return true
    }
    const timeArg = (this.e.msg.match(RANDOM_MSG_RE)?.[1] || '').trim()

    const tried = []
    for (let i = 0; i < Math.min(3, tracks.length); i++) {
      const track = nextRandom(tracks)
      if (!track) break
      tried.push(track.name)
      // 中间失败不刷屏，让队列继续往后走
      const ok = await this.sendTrack(track, timeArg, '🎲 随机', i < 2)
      if (ok) return true
    }
    await this.e.reply(`随机放了 ${tried.length} 首都没成功（${tried.join('、')}），发 #音乐列表 看看曲库`)
    return true
  }

  /** 整首播放：不带歌名随机，带歌名指定；按 60 秒拆成多条语音依次发 */
  async full () {
    const tracks = scanLibrary()
    if (!tracks.length) {
      await this.e.reply(`曲库是空的。\n把 mp3 / flac 等音频放进：${MUSIC_DIR}\n放好后发 #音乐扫描（仅bot管理员）`)
      return true
    }

    const query = (this.e.msg.match(FULL_MSG_RE)?.[1] || '').trim()
    if (!query) {
      const track = nextRandom(tracks)
      if (track) await this.sendFull(track)
      return true
    }

    const hits = search(tracks, query)
    if (!hits.length) {
      await this.e.reply(`曲库里找不到「${query}」\n发 #音乐列表 看有哪些歌`)
      return true
    }
    // 多个分数接近 → 让用户选，不瞎猜
    if (hits.length > 1 && hits[1].s > hits[0].s * 0.92 && hits[1].s >= 400) {
      const lines = [`「${query}」匹配到多首，说清楚一点：`, '']
      hits.slice(0, 6).forEach((h, i) => lines.push(`${i + 1}. ${h.t.name}`))
      await this.e.reply(lines.join('\n'))
      return true
    }

    await this.sendFull(hits[0].t)
    return true
  }

  /**
   * 整首拆段发送：QQ 语音单条上限约 60 秒，所以「完整播放」只能切成几条
   * 第一段发之前先报总段数，段与段之间留 FULL_GAP_MS 间隔
   */
  async sendFull (track, tag = '📻 整首') {
    cleanTmp()

    let dur = 0
    try {
      dur = await probeDuration(track.file)
      if (!dur) throw new Error('读不到时长')
    } catch (err) {
      await this.e.reply(`分析 ${track.name} 失败：${err.message}`)
      return false
    }

    const seg = MAX_CLIP
    let total = Math.ceil(dur / seg)
    // 尾巴不足 5 秒就少发一段，避免出现只有一两秒的残段
    if (total > 1 && dur - (total - 1) * seg < 5) total -= 1
    if (total > FULL_MAX_SEG) {
      await this.e.reply(
        `《${track.name}》全长 ${fmtDuration(dur)}，要拆 ${total} 段，整首一次最多 ${FULL_MAX_SEG} 段（${fmtDuration(FULL_MAX_SEG * seg)}）。\n` +
        '想听其中一段可以发：#音乐 歌名 起始-结束'
      )
      return false
    }

    await this.e.reply(`${tag} 🎵 ${track.name} · 全长 ${fmtDuration(dur)}，分 ${total} 段发送`)

    for (let i = 0; i < total; i++) {
      const start = i * seg
      const len = Math.min(seg, dur - start)
      if (len < 1) break

      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const out = path.join(TMP_DIR, `clip-${stamp}.mp3`)
      try {
        await cutClip(track.file, start, len, out)
      } catch (err) {
        await this.e.reply(`第 ${i + 1}/${total} 段截取失败：${err.message}`)
        return false
      }

      try {
        await this.e.reply(segment.record(out.replace(/\\/g, '/')))
      } catch (err) {
        logger?.warn?.(`[voice-music] 第 ${i + 1}/${total} 段发送失败：${err.message}`)
        await this.e.reply(`第 ${i + 1}/${total} 段发送失败：${err.message}`)
        return false
      }

      setTimeout(() => {
        try { fs.unlinkSync(out) } catch { /* 已删 */ }
      }, 120000)

      if (i < total - 1) await new Promise(resolve => setTimeout(resolve, FULL_GAP_MS))
    }
    return true
  }

  /**
   * 截取一段并发送语音
   * @param {object} track   曲库条目
   * @param {string} timeArg '45' 或 '60-95'，可为空
   * @param {string} tag     额外标记（如「🎲 随机」）
   * @param {boolean} quiet  失败时不回复（随机播放中间失败时用）
   * @returns {Promise<boolean>} 成功与否
   */
  async sendTrack (track, timeArg = '', tag = '', quiet = false) {
    const say = async msg => { if (!quiet) await this.e.reply(msg) }
    cleanTmp()

    let dur = 0
    let hook = null
    try {
      dur = await probeDuration(track.file)
      if (!dur) throw new Error('读不到时长')
      hook = cachedHook(track)
      if (!hook) {
        hook = await analyzeHook(track.file, dur)
        saveHook(track, hook.start, hook.end, false)
      }
    } catch (err) {
      await say(`分析 ${track.name} 失败：${err.message}`)
      return false
    }

    const range = parseRange(timeArg, dur, hook.start)
    if (range?.error) {
      await say(range.error)
      return false
    }

    let start
    let duration
    if (range) {
      start = range.start
      duration = range.duration
      if (duration > MAX_CLIP && !timeArg.includes('-')) duration = MAX_CLIP
    } else {
      start = hook.start
      duration = Math.min(DEFAULT_CLIP, Math.max(5, dur - start))
    }
    if (start >= dur) {
      await say(`起点 ${fmtDuration(start)} 超出了歌曲时长 ${fmtDuration(dur)}`)
      return false
    }
    duration = Math.min(duration, Math.max(1, dur - start), MAX_CLIP)

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const out = path.join(TMP_DIR, `clip-${stamp}.mp3`)

    try {
      await cutClip(track.file, start, duration, out)
    } catch (err) {
      await say(`截取失败：${err.message}`)
      return false
    }

    const rangeTag = range
      ? (range.onlyDuration ? '（指定时长）' : '（指定区间）')
      : hook.manual ? '（标注片段）' : ''
    const prefix = tag ? `${tag} ` : ''
    const tip = `${prefix}🎵 ${track.name} · ${fmtDuration(start)} - ${fmtDuration(start + duration)}${rangeTag}`
    try {
      await this.e.reply(tip)
      await this.e.reply(segment.record(out.replace(/\\/g, '/')))
    } catch (err) {
      logger?.warn?.(`[voice-music] 语音发送失败：${err.message}`)
      await say(`语音发送失败：${err.message}`)
      return false
    }

    // 延迟清理，给协议端留出转码时间
    setTimeout(() => {
      try { fs.unlinkSync(out) } catch { /* 已删 */ }
    }, 120000)
    return true
  }
}
