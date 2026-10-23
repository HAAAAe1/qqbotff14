import puppeteer from 'puppeteer'
import { spawn } from 'child_process'
import { existsSync } from 'fs'

let browserPromise = null

// Edge 可执行路径
const EDGE_PATH = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find(p => existsSync(p)) || 'msedge'

/** 启动浏览器（自己 spawn，stdio 显式 ignore stdin，防阻塞控制台） */
async function launchBrowser() {
  const debugPort = 9222 + Math.floor(Math.random() * 100)
  const proc = spawn(EDGE_PATH, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    `--remote-debugging-port=${debugPort}`
  ], {
    // 关键：stdin 设为 ignore，不继承控制台输入
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })
  // 等 Edge 启动并监听调试端口
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Edge start timeout')), 10000)
    const check = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
        if (r.ok) { clearTimeout(timeout); resolve() }
        else setTimeout(check, 200)
      } catch { setTimeout(check, 200) }
    }
    check()
  })
  // 连接 Puppeteer 到已运行的 Edge
  const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
  const info = await r.json()
  const browser = await puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl })
  // 保存 proc 引用以便关闭时 kill
  browser._edgeProc = proc
  browser._edgeDebugPort = debugPort
  return browser
}

async function getBrowser () {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null)
    if (b && !b.connected) {
      logger.warn('[ff14wiki] 浏览器连接已断开，重新启动')
      try { await b.close().catch(() => {}) } catch {}
      browserPromise = null
    }
  }
  if (!browserPromise) {
    browserPromise = launchBrowser().catch(e => {
      browserPromise = null
      throw e
    })
  }
  return browserPromise
}

/** 用浏览器请求灰机 wiki API（直连被 Cloudflare 拦截，浏览器可过 challenge） */
async function wikiApiGet (params) {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    await page.goto('https://ff14.huijiwiki.com/api.php?' + params, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise(r => setTimeout(r, 3000))
    const body = await page.evaluate(() => document.body.innerText)
    try { return JSON.parse(body) } catch { return null }
  } catch {
    return null
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    if (browser._edgeProc) browser._edgeProc.kill()
  }
}

/** 灰机 wiki API 全文搜索（Bing 搜不到时的 fallback；srwhat=text 能匹配正文，俗称也能搜到） */
async function wikiApiSearch (kw, limit = 10) {
  const j = await wikiApiGet('action=query&list=search&srsearch=' + encodeURIComponent(kw) + '&format=json&srlimit=' + limit + '&srwhat=text')
  const hits = j?.query?.search || []
  return hits.map(h => ({ title: h.title, href: 'https://ff14.huijiwiki.com/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')) }))
}

/** 物品命名空间搜索：默认 search 不覆盖 ns220（物品），用 srnamespace=220 精确搜索 */
/** ⚠️ 注意：srwhat=text + srnamespace=220 组合在灰机 wiki 返回 0 条（bug），物品搜索不能用 text */
async function wikiItemSearch (kw, limit = 10) {
  const j = await wikiApiGet('action=query&list=search&srsearch=' + encodeURIComponent(kw) + '&format=json&srlimit=' + limit + '&srnamespace=220')
  const hits = j?.query?.search || []
  return hits.map(h => ({ title: h.title, href: 'https://ff14.huijiwiki.com/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')) }))
}

/** DuckDuckGo HTML 搜索，返回灰机 wiki 结果列表（走代理避免验证） */
async function ddgSearch (kw, waitMs = 3000) {
  // 单独起一个走代理的浏览器实例搜 DDG
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=zh-CN',
      '--proxy-server=http://127.0.0.1:7890'
    ]
  })
  const page = await browser.newPage()
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent('site:ff14.huijiwiki.com ' + kw)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise(r => setTimeout(r, waitMs))
    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.result a.result__a')).map(a => ({
        title: (a.innerText || '').trim(),
        href: a.href || ''
      })).filter(r => r.title)
    })
    return results
  } finally {
    await page.close()
    await browser.close().catch(() => {})
  }
}

/** 必应搜索（fetch 方式，不触发验证码） */
async function bingFetchSearch (kw) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent('site:ff14.huijiwiki.com ' + kw) + '&setlang=zh-CN'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: ctrl.signal
    })
    const t = await r.text()
    const results = []
    const re = /<h2[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = re.exec(t)) && results.length < 5) {
      const title = m[2].replace(/<[^>]+>/g, '').trim()
      if (title && m[1].includes('huijiwiki')) results.push({ title, href: m[1] })
    }
    if (!results.length) {
      const re2 = /<li class="b_algo"[\s\S]*?<h2>[\s\S]*?<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      while ((m = re2.exec(t)) && results.length < 5) {
        const title = m[2].replace(/<[^>]+>/g, '').trim()
        if (title) results.push({ title, href: m[1] })
      }
    }
    return results
  } finally {
    clearTimeout(timer)
  }
}

/** 必应搜索（Puppeteer 方式，可能触发验证码） */
async function bingSearch (kw, waitMs = 3500) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent('site:ff14.huijiwiki.com ' + kw) + '&setlang=zh-CN'
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise(r => setTimeout(r, waitMs))
    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('li.b_algo h2 a, li.b_algo a[href]')).map(a => ({
        title: (a.innerText || '').trim(),
        href: a.href || ''
      })).filter(r => r.href.includes('ff14.huijiwiki.com') && r.title)
    })
    return results
  } finally {
    await page.close()
  }
}

/**
 * 抓取页面核心内容
 * 策略：正文开头 → 「开放条件」节结束（副本页）；无开放条件则取首段+关键词上下文（词条页）
 */
async function fetchPageContent (url, kw, waitMs = 2000) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, waitMs))
      let data = null
      try {
        data = await page.evaluate((kw) => {
          const root = document.querySelector('#mw-content-text')
          if (!root) return null
          const clone = root.cloneNode(true)
          clone.querySelectorAll('.hatnote, .dablink, blockquote, .ambox, .mbox, .editsection, .mw-editsection, .noprint, .toc, #toc, .navbox').forEach(n => n.remove())
          const clean = (s) => String(s || '')
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .replace(/\u3000/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
          const body = clean(clone.innerText)
          const heads = Array.from(clone.querySelectorAll('h2, h3')).map(h => clean(h.innerText)).filter(Boolean)
          // 空页面（词条不存在/被吃掉）→ 立即返回空标记
          if (body.includes('词条') && body.includes('不存在') || body.includes('这个页面被吃掉')) {
            return { empty: true }
          }
          // 副本页：截取开头到「开放条件」节结束
          const ocIdx = body.indexOf('开放条件')
          if (ocIdx >= 0) {
            let nextHeadIdx = -1
            for (const h of heads) {
              if (h.includes('开放条件')) continue
              const hi = body.indexOf(h, ocIdx + 4)
              if (hi > 0) { nextHeadIdx = hi; break }
            }
            const end = nextHeadIdx > 0 ? nextHeadIdx : Math.min(body.length, ocIdx + 400)
            let content = body.slice(0, end)
            const biIdx = content.indexOf('基本信息')
            if (biIdx > 0 && biIdx < 100) content = content.slice(biIdx)
            content = content.replace(/(?=(?:添加版本|任务地点|任务时限|队伍构成|副本ID|数据文件|战利品|神典石|初次完成|等级要求|允许中途参战|允许解除限制|允许使用不死鸟之尾|其他站点链接|开放条件|任务开始NPC|前置任务|限制))/g, '\n')
            return { content: content.replace(/\n{2,}/g, '\n').slice(0, 1400), type: 'dungeon' }
          }
          // 词条页：首段 + 关键词上下文
          const firstP = clean(clone.querySelector('p')?.innerText || '').slice(0, 400)
          let kwCtx = ''
          if (kw && !firstP.includes(kw)) {
            let pos = -1
            let from = 0
            while (true) {
              const idx = body.indexOf(kw, from)
              if (idx < 0) break
              if (!body.slice(Math.max(0, idx - 60), idx + kw.length + 60).includes('消歧义')) { pos = idx; break }
              from = idx + kw.length
            }
            if (pos >= 0) kwCtx = body.slice(Math.max(0, pos - 80), Math.min(body.length, pos + kw.length + 300)).replace(/\n{2,}/g, '\n').slice(0, 700)
          }
          return { content: [firstP, kwCtx].filter(Boolean).join('\n').slice(0, 1400), type: 'page' }
        }, kw)
      } catch (evalErr) { continue }
      if (data) {
        if (data.empty) return null
        return data
      }
    }
    return null
  } finally {
    await page.close()
  }
}

/** 灰机 wiki Special:Search 页面搜索（比 API 搜索更全面） */
async function wikiSearch(kw, limit = 5) {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const url = 'https://ff14.huijiwiki.com/index.php?title=Special:Search&profile=default&search=' + encodeURIComponent(kw) + '&sort=just_match'
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise(r => setTimeout(r, 4000))
    const results = await page.evaluate((limit) => {
      const items = document.querySelectorAll('.mw-search-result-heading a')
      return Array.from(items).slice(0, limit).map(a => ({
        title: a.textContent.trim(),
        href: a.href
      }))
    }, limit)
    return results
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    if (browser._edgeProc) browser._edgeProc.kill()
  }
}

export class ff14wiki extends plugin {
  constructor () {
    super({
      name: 'FF14Wiki',
      dsc: '必应搜索FF14灰机wiki（#查询/#ff14/#wiki/#f 关键词）',
      event: 'message',
      // 1：必须排在土块AI画图(priority 5)之前，否则 #f/#wiki 会被它的宽规则截胡、永不到这里
      priority: 1,
      rule: [
        // 负向前瞻：让 #查询剩余次数（土块画图配额查询）仍归土块，不被这里抢走
        { reg: '^#(?:查询(?!剩余次数)|[fF]{2}14|[wW]iki|[fF])\\s*(.+)$', fnc: 'search', permission: 'all' }
      ]
    })
  }

  /** 直连试探：灰机 wiki 搜索索引搜不到「物品」等命名空间，直接猜 URL 抓取验证 */
  async tryDirect (kw) {
    const candidates = [
      kw,
      `物品:${kw}`,
      `道具:${kw}`,
      `坐骑:${kw}`,
      `NPC:${kw}`,
      `任务:${kw}`,
      `副本:${kw}`
    ]
    for (const title of candidates) {
      const href = 'https://ff14.huijiwiki.com/wiki/' + encodeURIComponent(title)
      try {
        const info = await fetchPageContent(href, kw, 3000)
        if (info?.content && !info.content.includes('词条') && !info.content.includes('不存在')) {
          return { title, href, content: info.content }
        }
      } catch {
        // 继续尝试下一个候选
      }
    }
    return null
  }

  /** 搜索 wiki 条目并输出结果 */
  async search () {
    const alias = { '绝妖': '绝凯夫卡' }
    let kw = this.e.msg.replace(/^#(?:查询|[fF]{2}14|[wW]iki|[fF])\s*/i, '').trim()
    kw = kw.replace(/^极/, '殛')
    kw = alias[kw] || kw
    if (!kw) return this.reply('用法：#查询 关键词（如 #查询 尼德霍格），也支持 #ff14 / #wiki / #f')
    try {
      // 第一步：灰机 wiki Special:Search 页面搜索（最全面）
      let results = []
      try { results = await wikiSearch(kw, 5) } catch {}
      // 第二步：没搜到 → 直连试探常见命名空间
      if (!results.length) {
        const direct = await this.tryDirect(kw)
        if (direct) {
          const lines = [`【${direct.title}】`, direct.content, `来源：${direct.href}`]
          return this.reply(lines.join('\n').slice(0, 1500))
        }
        return this.reply(`没找到「${kw}」相关的FF14 wiki条目`)
      }
      // 有结果 → 输出第一条
      const top = results[0]
      const lines = [`【${top.title}】`, `来源：${top.href}`]
      if (results.length > 1) lines.push(`其他结果：${results.slice(1, 3).map(r => r.title).join('、')}`)
      return this.reply(lines.join('\n').slice(0, 1500))
    } catch (e) {
      if (/browser|Browser|connection|Connection|Target|Protocol|Session/i.test(String(e?.message || ''))) {
        logger.error('[ff14wiki] 浏览器异常，重置连接:', e.message)
        try {
          const b = await browserPromise?.catch(() => null)
          if (b) await b.close().catch(() => {})
        } catch {}
        browserPromise = null
      }
      return this.reply('查询失败：' + (e?.message || e))
    }
  }
}
