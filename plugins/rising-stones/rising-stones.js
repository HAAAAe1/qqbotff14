import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 石之家(FF14 risingstones)签到
 * 凭据仅存本地 data/rising-stones.json，不进日志、不上云
 * 参考 tataru(AstrBot) 的实现，移植为 TRSS-Yunzai 插件
 * Cookie 自动续期：bot 目录 ff14-signin 项目的 refresh_cookie.py（Playwright 导出，已从桌面迁移防误删）
 *   #石之家      —— 打开登录用的那个浏览器（同一个 profile），窗口交给你自己操作，不自动关闭
 *   #石之家登录  —— 首次/过期时人工登录一次，之后每天自动刷新
 */

const API = 'https://apiff14risingstones.web.sdo.com/api'
const REFERER = 'https://ff14risingstones.web.sdo.com/pc/index.html'
const DATA = path.join(process.cwd(), 'plugins/example/rising-stones.json')

/** Cookie 自动刷新（bot 目录 ff14-signin 项目，原在桌面防误删） */
// ff14-signin 与插件同级（plugins/example/ -> ../../ff14-signin），由模块位置推导
const REFRESH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ff14-signin')
/** Python 解释器（跑 refresh_cookie.py 用）—— 可用环境变量 FF14_SIGNIN_PYTHON 指定绝对路径 */
const REFRESH_PY = process.env.FF14_SIGNIN_PYTHON || 'python'
const PROFILE_DIR = path.join(REFRESH_DIR, 'profile')
const PROFILE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

/** #石之家 手动操作浏览器是否正在运行（同一个 profile 不能开两份） */
let opening = false

/** 签到功能仅限主人本人（2026-10-19 用户要求，不外借） */
/** 签到功能默认只给自己用 —— 填你自己的 QQ；留空则所有人都能用（不建议） */
const OWNER_QQ = process.env.RISING_STONES_OWNER || ''

/** 跑 refresh_cookie.py，返回 {code, out}：0 成功 / 2 登录态过期 / 1 其它错误 */
function runRefresh (args = [], timeout = 180000) {
  return new Promise(resolve => {
    execFile(REFRESH_PY, ['refresh_cookie.py', '--profile', PROFILE_DIR, ...args],
      { cwd: REFRESH_DIR, timeout, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}`.trim() })
      })
  })
}

/** 读 refresh_cookie.py 导出的单行 Cookie；无/仍是模板则 null */
function readExportedCookie () {
  try {
    const c = fs.readFileSync(path.join(REFRESH_DIR, 'cookie.txt'), 'utf8').trim()
    return c && !c.startsWith('#') ? c : null
  } catch {
    return null
  }
}

function load () {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')) } catch { return {} }
}

function save (data) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true })
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2))
}

function today () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function grab (t, re) {
  const m = t.match(re)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : ''
}

/** Chrome 复制的 cURL(bash/cmd) 或 两行(cookie\nUA) -> {cookie, ua} */
function parseBinding (raw) {
  let t = raw.trim()
    .replace(/\^\r?\n/g, ' ')   // cmd 换行续行
    .replace(/\\\r?\n/g, ' ')   // bash 换行续行
  // cmd 格式：^x 全是转义(^" 引号、^& ^% ^( 等)，整体还原；bash 格式无此问题
  if (t.includes('^"')) t = t.replace(/\^([\s\S])/g, '$1')
  if (/^curl(\.exe)?\b/i.test(t)) {
    const cookie = grab(t, /(?:^|\s)(?:-b|--cookie)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
      || grab(t, /-H\s+(?:"Cookie:\s*([^"]+)"|'Cookie:\s*([^']+)'|Cookie:\s*(\S+))/i)
    const ua = grab(t, /(?:^|\s)(?:-A|--user-agent)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
      || grab(t, /-H\s+(?:"User-Agent:\s*([^"]+)"|'User-Agent:\s*([^']+)'|User-Agent:\s*(.+))/i)
    return cookie && ua ? { cookie, ua } : null
  }
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return lines.length >= 2 ? { cookie: lines[0], ua: lines[1] } : null
}

async function doCheckin (acc) {
  const tempsuid = crypto.randomUUID()
  const res = await fetch(
    `${API}/home/sign/signIn?tempsuid=${tempsuid}`,
    {
      method: 'POST',
      headers: {
        Cookie: acc.cookie,
        'User-Agent': acc.ua,
        Referer: REFERER,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*'
      },
      body: `tempsuid=${tempsuid}`,
      signal: AbortSignal.timeout(20000)
    }
  )
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回异常 HTTP ${res.status}`)
  }
}

/**
 * 拼「签到成功」通知文案（用户 2026-10-13 定稿：只发这三行，不要连续/累计/经验）
 * Cookie 未自动续期时第三行不显示。
 */
function successText (day, renewed) {
  const lines = ['✅ 石之家自动签到成功', `📅 ${day}`]
  if (renewed) lines.push('🍪 Cookie 已自动续期')
  return lines.join('\n')
}

export class RisingStones extends plugin {
  constructor () {
    super({
      name: '石之家签到',
      dsc: '石之家(FF14)每日签到与自动签到',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#石之家$', fnc: 'openSite' },
        { reg: '^#石之家绑定\\s*([\\s\\S]+)$', fnc: 'bind' },
        { reg: '^#石之家登录$', fnc: 'login' },
        { reg: '^#石之家解绑$', fnc: 'unbind' },
        { reg: '^#石之家自动签到(\\s*(开启|关闭|开|关))?$', fnc: 'setAuto' },
        { reg: '^#石之家签到$', fnc: 'checkin' },
        { reg: '^#石之家状态$', fnc: 'status' }
      ]
    })
    this.task = [{ name: '石之家自动签到', cron: '0 9 * * *', fnc: () => this.autoCheckin() }]
  }

  /** 绑定/解绑涉及他人凭据，仅限私聊 */
  requirePrivate () {
    if (!this.e.isPrivate) {
      this.e.reply('该命令涉及账号凭据，请私聊使用')
      return true
    }
    return false
  }

  /** 仅本人可用（未配置 OWNER_QQ 时不限制）；返回 true 表示已拦截，调用方直接 return */
  onlyOwner (e) {
    if (!OWNER_QQ) return false
    if (String(e.user_id) === OWNER_QQ) return false
    e.reply('石之家签到暂只对主人开放，暂不支持他人使用')
    return true
  }

  async bind (e) {
    if (this.requirePrivate()) return
    if (this.onlyOwner(e)) return
    const cred = parseBinding(e.msg.replace(/^#石之家绑定\s*/, ''))
    if (!cred) {
      return e.reply(
        '绑定信息格式不对。请在石之家网页登录后，F12 → Network → 任一请求 → 右键 Copy as cURL (bash)，完整粘贴；或发两行文本：第一行 Cookie，第二行 User-Agent'
      )
    }
    const data = load()
    data[String(e.user_id)] = { ...cred, auto: false, last: '', updated: Date.now() }
    save(data)
    return e.reply('石之家账号已绑定（凭据仅存本机）。发 #石之家签到 测试，再发 #石之家自动签到 开启')
  }

  /**
   * #石之家 —— 打开「登录用的那个浏览器」（refresh_cookie.py --open，同一个 Playwright profile），
   * 由你自己在窗口里操作；窗口不会自动关闭，关掉窗口即结束。
   * 刻意不走系统默认浏览器：登录态只存在这个 profile 里，别的浏览器登录 bot 读不到、也没法续期。
   */
  async openSite (e) {
    if (this.onlyOwner(e)) return
    if (opening) {
      return e.reply('石之家浏览器已经开着了，直接在那个窗口里操作就行。\n用完关掉窗口，bot 才能继续自动刷新 Cookie。')
    }
    await e.reply('正在打开石之家浏览器（与 #石之家登录 用的是同一个，登录态在这里才有效）…\n窗口不会自动关，你自己操作，用完关掉窗口即可。')
    opening = true
    let r
    try {
      r = await runRefresh(['--open'], 0) // 0 = 不设超时：窗口开着就一直等
    } finally {
      opening = false
    }
    if (r.code === 0) {
      return e.reply('✅ 已检测到石之家登录态，Cookie 已导出（窗口关闭后生效）。\n要每天自动签到 → 私聊发 #石之家自动签到 开启；查状态发 #石之家状态')
    }
    if (r.code === 2) return e.reply('浏览器已关闭，但没检测到登录态。想再开一次就再发 #石之家')
    return e.reply(`石之家浏览器异常退出（code=${r.code}）：${r.out.slice(-300)}`)
  }

  /** 首次/过期：开浏览器人工登录，成功后绑定为自动续期模式 */
  async login (e) {
    if (this.requirePrivate()) return
    if (this.onlyOwner(e)) return
    await e.reply('正在打开浏览器，请在 5 分钟内完成石之家登录（若已登录会自动继续）…')
    const r = await runRefresh(['--login'], 360000)
    if (r.code !== 0) {
      return e.reply(`登录未完成（code=${r.code}）：${r.out.slice(-300)}`)
    }
    const fresh = readExportedCookie()
    if (!fresh) return e.reply('登录成功但没读到 cookie.txt，请联系主人检查')
    const data = load()
    const acc = data[String(e.user_id)] || { auto: false, last: '' }
    acc.cookie = fresh
    acc.ua = PROFILE_UA
    acc.refresh = true
    acc.updated = Date.now()
    data[String(e.user_id)] = acc
    save(data)
    return e.reply('石之家登录成功，已绑定为自动续期模式（每天签到前自动刷新 Cookie）。发 #石之家自动签到 开启')
  }

  async unbind (e) {
    if (this.requirePrivate()) return
    if (this.onlyOwner(e)) return
    const data = load()
    if (!data[String(e.user_id)]) return e.reply('尚未绑定')
    delete data[String(e.user_id)]
    save(data)
    return e.reply('已解绑，凭据已删除')
  }

  async setAuto (e) {
    if (this.requirePrivate()) return
    if (this.onlyOwner(e)) return
    const data = load()
    const acc = data[String(e.user_id)]
    if (!acc) return e.reply('尚未绑定，先私聊发送 #石之家绑定')
    const arg = e.msg.replace(/^#石之家自动签到/, '').trim()
    if (!arg) return e.reply(`自动签到当前：${acc.auto ? '开启' : '关闭'}\n发送 #石之家自动签到 开启 或 关闭 修改`)
    const on = /开启|开/.test(arg)
    acc.auto = on
    save(data)
    return e.reply(on ? '自动签到已开启，每天 09:00 自动执行' : '自动签到已关闭')
  }

  async checkin (e) {
    if (this.onlyOwner(e)) return
    const acc = load()[String(e.user_id)]
    if (!acc) return e.reply('尚未绑定，私聊发送 #石之家绑定 <cURL>')
    try {
      const r = await doCheckin(acc)
      if (r.code === 10000 || /成功|已签/.test(r.msg || '')) {
        const data = load()
        if (data[String(e.user_id)]) {
          data[String(e.user_id)].last = today()
          save(data)
        }
      }
      return e.reply(`石之家签到：${r.msg || JSON.stringify(r)}（code ${r.code}）`)
    } catch (err) {
      return e.reply(`签到失败：${err.message}。若是鉴权失败，Cookie 可能过期，请重新绑定`)
    }
  }

  async status (e) {
    if (this.onlyOwner(e)) return
    const acc = load()[String(e.user_id)]
    if (!acc) return e.reply('尚未绑定')
    let renew = ''
    if (acc.refresh) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(REFRESH_DIR, 'cookie_meta.json'), 'utf8'))
        const watch = ['ff14risingstones', 'CAS_LOGIN_STATE', 'SECURE_CAS_LOGIN_STATE']
        const hours = (meta.cookies || [])
          .filter(c => watch.includes(c.name) && c.remaining_hours != null)
          .map(c => `${c.name} 剩 ${c.remaining_hours} 小时`)
        renew = `自动续期：开启（每天 09:00 自动刷新）\n上次刷新：${meta.refreshed_at || '无'}\n${hours.join('\n') || '无关键 Cookie 记录'}`
      } catch {
        renew = '自动续期：开启（尚无刷新记录，下次签到时首次刷新）'
      }
    } else {
      renew = '自动续期：关闭（cURL 绑定，Cookie 过期需重新绑定）'
    }
    return e.reply(
      `已绑定，Cookie：${acc.cookie.slice(0, 12)}…（已脱敏）\n` +
      `自动签到：${acc.auto ? '开启（每天 09:00）' : '关闭'}\n` +
      `${renew}\n` +
      `上次签到：${acc.last || '无'}`
    )
  }

  /** 定时任务：每天 09:00，给所有开了自动签到的账号各签一次 */
  async autoCheckin () {
    const data = load()
    const day = today()
    const problems = []
    let renewed = false

    /** 有待签的自动续期账号 → 先刷 Cookie（headless，约几秒） */
    const pending = Object.values(data).filter(a => a.auto && a.refresh && a.last !== day)
    if (pending.length) {
      const r = await runRefresh()
      if (r.code === 0) {
        const fresh = readExportedCookie()
        if (fresh) {
          for (const a of Object.values(data)) {
            if (a.refresh) { a.cookie = fresh; a.ua = PROFILE_UA; a.updated = Date.now() }
          }
          renewed = true
        } else {
          problems.push('刷新成功但没读到 cookie.txt（导出文件缺失）')
        }
      } else {
        logger.warn(`[石之家签到] Cookie刷新失败 code=${r.code}: ${r.out.slice(-300)}`)
        problems.push(r.code === 2
          ? 'Cookie 登录态过期，需重新登录'
          : `Cookie 刷新脚本异常 code=${r.code}`)
        // 刷失败不阻断：用旧 Cookie 继续签，签到失败会一并上报
      }
    }

    let ok = 0
    let fail = 0
    /** 签成功待通知的账号（2026-10-13 新增：成功原来只写日志，用户收不到任何提示） */
    const notices = []
    for (const [qq, acc] of Object.entries(data)) {
      if (!acc.auto || acc.last === day) continue
      try {
        const r = await doCheckin(acc)
        acc.last = day // 无论首签/重复签，今日已尝试完成，避免反复请求
        if (r.code !== 10000 && !/成功|已签/.test(r.msg || '')) {
          fail++
          logger.warn(`[石之家签到] ${qq} code=${r.code} msg=${r.msg}`)
          problems.push(`${qq} 签到失败：code=${r.code} ${r.msg || ''}`)
        } else {
          ok++
          notices.push({ qq, renewed })
        }
      } catch (err) {
        fail++
        logger.warn(`[石之家签到] ${qq} 失败: ${err.message}`)
        problems.push(`${qq} 签到异常：${err.message}`)
      }
    }
    save(data)
    logger.mark(`[石之家自动签到] 完成 成功${ok} 失败${fail}`)

    /** 逐个私聊通知签到成功的人；发不出去就转报主人，避免"签了但谁也不知道" */
    for (const { qq, renewed: didRenew } of notices) {
      try {
        await Bot.pickUser(qq).sendMsg(successText(day, didRenew))
        logger.mark(`[石之家签到] 已通知 ${qq} 签到成功`)
      } catch (err) {
        logger.warn(`[石之家签到] 通知 ${qq} 失败: ${err.message}`)
        problems.push(`${qq} 签到成功但通知失败：${err.message}`)
      }
    }

    /** 任何异常都要让主人知道，不再静默 */
    if (problems.length) {
      try {
        await Bot.sendMasterMsg(`【石之家自动签到】${day} 异常：\n${problems.join('\n')}\n若是登录问题，私聊发 #石之家登录`)
      } catch (err) {
        logger.warn(`[石之家签到] 通知主人失败: ${err.message}`)
      }
    }
  }
}
