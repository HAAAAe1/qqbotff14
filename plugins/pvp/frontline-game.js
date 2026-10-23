// FF14 纷争前线模拟战 —— QQ群文字小游戏
// 地图简介严格参考灰机 wiki 纷争前线及各地图页面原文（ff14.huijiwiki.com）
// 规则：最多3轮行动 | 挂机2次踢出强制战败 | 第2轮解锁LB | 隐藏胜率阈值触发特殊三选一 | 全程不展示任何数值
// 命令：#前线 / #战场 / #纷争前线 / #模拟战 开局；行动期直接回复数字或中文；「结算」提前结算；「取消」放弃本局

const MAPS = [
  {
    name: '周边遗迹群',
    mode: '阵地战',
    intro: '周边遗迹群（阵地战）是纷争前线的一种，可以通过占领据点或打倒敌方连队的成员来获得“分数”。占领的据点越多，获得的分数就越多。所以胜负关键是维持尽量多的据点。\n最快累积到2400分分数的团队胜出。\n根据获得的分数的数值高低进行排名。'
  },
  {
    name: '尘封秘岩',
    mode: '争夺战',
    intro: '尘封秘岩（日文︰シールロック，英文︰Seal Rock）岛是在威尔布兰德岛近海的梅尔托尔海峡新发现的孤岛，其上沉睡着古代亚拉戈文明的遗迹。实际上，这是古代亚拉戈帝国所建造的人工岛，岛上具有对包括“欧米茄”在内的对蛮神兵器进行研究的设施。\n在亚拉戈文明毁灭后，经过5000年的时间，岛屿的表面累积了厚厚的土层，看上去就像是一座普通的岛屿。\n也许是因为第七灵灾的时候一部分地层脱落，尘封秘岩岛上露出了人工岛的一部分，这部分被称为“亚拉戈石文”。大国防联军决定将其作为掌控的对象，但因为“亚拉戈石文”十分巨大，无法轻易搬运，因此准备通过获取亚拉戈石文上的情报来带回有关古代亚拉戈的信息。'
  },
  {
    name: '荣誉野',
    mode: '碎冰战',
    intro: '荣誉野（碎冰战）是纷争前线的一种，通过打倒敌方玩家或破坏冰封的石文后获得的“情报值”来决定胜负。\n最快累积到1600分情报值的团队优胜。\n根据获得的情报值的数值高低进行排名。'
  },
  {
    name: '昂萨哈凯尔',
    mode: '竞争战',
    intro: '太阳神草原（日文︰アジムステップ，英文︰Azim Steppe）是奥萨德次大陆北部的广阔大草原。据传是敖龙族的发祥地，拥有太阳神阿吉木、月神娜玛的独特信仰体系。暮晖之民们有多达50多个部落分散而居，至今仍遵守着传统相互争夺大草原的支配权。\n这里难以种植农作物，气候也不适宜人类居住，人们崇尚自然，有独立信仰，民风剽悍。可能正是因此，尽管草原上各部多年内斗，却没有遭到加雷马帝国的侵略。\n一些人推测草原的这部分得名于起伏的草地。其他人则宣称刃海（日文︰刃の海，英文︰Sea of Blades）是指部族间为了争夺牧场而进行的无休止的战斗。'
  },
  {
    name: '沃刻其特',
    mode: '演习战',
    intro: '沃刻其特（演习战）是大规模PvP纷争前线的一种对战地图，三大阵营“黑涡团”“双蛇党”和“恒辉队”分庭抗礼，最多支持72名玩家同时对战。\n战场天气会随时间推移发生变化。善用天气变化，获取战略值并夺取胜利。\n需要加入“黑涡团”“恒辉队”和“双蛇党”其中的任意一个大国防联军。\n※参加任务时会被随机到任意一个大国防联军阵营中。'
  }
]

const FACTIONS = ['黑涡团', '双蛇党', '恒辉队']

const ENTRIES = {
  1: { name: '指挥队', bonus: 8, flavor: '你拿起扩音器，准备接管全场指挥。' },
  2: { name: '四小', bonus: 3, flavor: '你拉上三个亲友组成轻锐小队，密谋偷点。' },
  3: { name: '散人', bonus: -5, flavor: '你孤身一人混进散人洪流，生死看淡。' }
}

const ACTIONS = {
  1: { name: '逛街', emoji: '🚶' },
  2: { name: '打团', emoji: '⚔️' },
  3: { name: '摸点', emoji: '📍' },
  4: { name: '挂机', emoji: '😴' },
  5: { name: '游击偷袭', emoji: '🗡️' },
  6: { name: '回防守点', emoji: '🛡️' },
  7: { name: '夹击第三方', emoji: '🔀' }
}

const ACTION_MENU = ['1️⃣ 逛街', '2️⃣ 打团', '3️⃣ 摸点', '4️⃣ 挂机', '5️⃣ 游击偷袭', '6️⃣ 回防守点', '7️⃣ 夹击第三方']

const WIN_LINES = [
  '这波稳了！你队碾压全场拿下第一，指挥在麦里喊「集火集火」喊到破音，值了。',
  '恭喜拿下！对面老三队被打得抱头鼠窜，你站在高台俯视众生，深藏功与名。',
  '胜利！奶妈终于不用奶你这条咸鱼了，这波你是全场最靓的仔。',
  '赢了！敌方指挥还在打字「你们先上我殿后」，然后他真的殿后了——殿到复活点。',
  'MVP就是你！这把打完，连对面老三都私聊你：哥，带带？'
]

const LOSE_LINES = [
  '惜败。你队喜提老三宝座，指挥沉默三秒，缓缓打出「下把必赢」——然后光速下线。',
  '输了，问题不大。前线传统艺能：怪奶妈，奶妈怪散人，散人怪网络，网络怪se。',
  '你队老三。老三就老三吧，至少比上把强——上把你们连老三都没得当。',
  '败北。全场最佳操作：你在出生点跳了20分钟舞。输出全靠队友，嘲讽全靠你。',
  '输了。指挥说「这把稳了」的时候我就知道事情不简单。前线铁律：稳了=完了。'
]

// 胜率特别高却输了：全看脸
const FACE_LINES = [
  '胜率明明拉满，结果还是输了……前线这游戏，全看脸。',
  '稳得离谱的一局，愣是被翻盘了。指挥把键盘拍在桌上：「这游戏全看脸！」',
  '你说这胜率，它科学吗？不科学。前线铁律：再高的胜率也顶不住脸黑。',
  '优势那么大都能输，只能感慨一句：全看脸。',
  '指挥复盘了三遍：「每一步都对啊？」——对，但没用。全看脸。'
]

const AFK_LINES = [
  '挂机两次被清出战场！队友把你出生点跳舞的录像发群里了，配文：这就是我们的散人。战败，老三预定。',
  '你挂机挂得太敬业，系统都看不下去了，直接清退。这把没了，下把记得动一动。'
]

const GATE_LINES = [
  '堵门一时爽，全家火葬场。对面一波反推把你队堵在自家门口轮流打靶，分数直接归零。老三，稳。',
  '你去堵门，门没堵住，自己被堵了。对面甚至懒得打你，绕着你走。战败。'
]

const BOOM_LINES = [
  '「跟他们爆了！」——爆是爆了，爆的是自己家水晶。全队团灭，数值归零，老三收场。',
  '爆了，但没完全爆。对面掉了两个人，你队掉了二十个。这笔账你自己算。'
]

const games = new Map()
const key = e => `${e.group_id || 'p'}:${e.user_id}`
const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const pick = a => a[Math.floor(Math.random() * a.length)]
const clamp = v => Math.max(0, Math.min(100, v))

/** 中文输入 → 数字（仅入场/行动阶段生效，特殊选择阶段只认①②③和数字） */
const TEXT_TO_NUM = {
  '指挥队': '1', '四小': '2', '散人': '3',
  '逛街': '1', '打团': '2', '摸点': '3', '挂机': '4',
  '游击偷袭': '5', '回防守点': '6', '夹击第三方': '7'
}

/** 行动结算：只改隐藏数值并返回剧情文本，绝不展示数字 */
function resolveAction (g, act) {
  const r = Math.random()
  let story = ''
  switch (act) {
    case 1: { // 逛街
      g.v += ri(-4, 6)
      story = pick([
        '你在战场边缘悠闲逛街，顺手捡了几个散落的水晶碎片。路过一队残血散人，你假装没看见——深藏功与名。',
        '逛街逛到敌方出生点附近，被巡逻队追了三条街，狼狈逃回。下次不浪了。',
        '你逛街时偶遇对面落单的奶妈，双方对视三秒，默契地各走各路。这就是前线礼仪。'
      ])
      break
    }
    case 2: { // 打团
      if (g.lb && !g.lbUsed) {
        g.lbUsed = true
        if (r < 0.75) {
          g.v += ri(30, 45)
          story = '🔥 LB 极限技全力爆发！你队一波推进，对面指挥还没反应过来就被集火蒸发，直接打崩一路，全场欢呼！'
        } else {
          g.v -= ri(10, 18)
          story = '🔥 LB 放早了！极限技砸在对面减伤上，毛伤害没有，反被一波反打。指挥沉默了三秒：「我的。」'
        }
      } else if (r < 0.6) {
        g.v += ri(12, 22)
        story = pick([
          '打团打赢了！集火指挥、转火奶妈，一套流程行云流水，对面复活点读秒，你们顺势收割一波。',
          '这波团战大获全胜！你队踩着对面尸体推进，士气高涨，连散人都开始听指挥了。'
        ])
      } else {
        g.v -= ri(12, 22)
        story = pick([
          '打团打输了！你们冲进人群瞬间蒸发，奶妈在麦里喊破音：「奶不起来啊！！」',
          '团战惨败。对面老三队居然支棱起来了，你们被反推一路，指挥开始怀疑人生。'
        ])
      }
      break
    }
    case 3: { // 摸点
      g.v += ri(8, 16)
      story = pick([
        '你队成功摸下一个据点！翻点节奏完美，对面赶来时只看到你们远去的背影。',
        '摸点成功！但守点的时候被对面偷袭了一波，点保住了，人没了几个。'
      ])
      break
    }
    case 4: { // 挂机
      g.afk++
      g.v -= 2
      story = `😴 你在出生点挂机！系统红字警告：持续无操作将被清退！（挂机 ${g.afk}/2 次）`
      break
    }
    case 5: { // 游击偷袭
      if (r < 0.55) {
        g.v += ri(15, 25)
        story = pick([
          '游击偷袭成功！你们绕后偷掉对面一整个小队，对面指挥打字：「有人偷家！！」',
          '偷袭得手！趁对面和第三方打得火热，你们在背后狠狠捅了一刀，深藏功与名。'
        ])
      } else {
        g.v -= ri(8, 14)
        story = pick([
          '偷袭被反抓！你们刚摸到对面背后就被视野怪发现，反被包了饺子，狼狈逃窜。',
          '游击失败。对面像开了全图挂一样等着你们，一波反打，偷鸡不成蚀把米。'
        ])
      }
      break
    }
    case 6: { // 回防守点
      g.v += ri(4, 10)
      story = pick([
        '你队及时回防，保住了关键据点！对面功亏一篑，气得直跺脚。',
        '回防成功，但过程险象环生——再晚三秒，点就没了。指挥直呼好险。'
      ])
      break
    }
    case 7: { // 夹击第三方
      if (r < 0.5) {
        g.v += ri(14, 24)
        story = '夹击成功！你和另一队心有灵犀，同时扑向第三方，对方被打得抱头鼠窜，分数大涨！'
      } else {
        g.v -= ri(12, 18)
        story = '夹击失败！第三方反手联合另一队把你队夹了，教科书级的反向包抄。指挥：「谁出的主意？」'
      }
      break
    }
  }
  g.v = clamp(g.v)
  return story
}

function roundMenu (g) {
  const lines = [`——第 ${g.round} 轮行动——`]
  if (g.lb && !g.lbUsed) lines.unshift('🔥 LB 极限技就绪！本轮选 2️⃣打团 可释放高额增益；不打团则保留。')
  lines.push(...ACTION_MENU)
  lines.push('（回复「结算」提前结束，回复「取消」放弃本局）')
  return lines.join('\n')
}

function statusText (g) {
  if (g.status === 'entry') return '等待选择入场方式：1 指挥队 / 2 四小 / 3 散人'
  if (g.status === 'special') return '等待选择特殊选项：① ② ③'
  return `第 ${g.round} 轮行动中｜阵营：${g.faction}｜地图：${g.map.name}（${g.map.mode}）｜入场：${g.entry}`
}

export class frontlineGame extends plugin {
  constructor () {
    super({
      name: '纷争前线模拟战',
      dsc: 'FF14纷争前线文字模拟战：#前线 开局，回复数字行动，结算/取消',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#(?:前线|战场|纷争前线|模拟战|前线模拟战|战场模拟)$', fnc: 'start', permission: 'all' },
        { reg: '^(?:[1-8]|①|②|③|结算|取消|指挥队|四小|散人|逛街|打团|摸点|挂机|游击偷袭|回防守点|夹击第三方)$', fnc: 'gameInput', permission: 'all' }
      ]
    })
  }

  /** 开局 */
  async start () {
    const k = key(this.e)
    const old = games.get(k)
    if (old && Date.now() - old.t < 30 * 60 * 1000) {
      return this.reply(`你已经在战场上了！\n${statusText(old)}`)
    }
    games.set(k, { status: 'entry', round: 0, afk: 0, v: ri(35, 65), lb: false, lbUsed: false, specialShown: false, entry: null, faction: null, map: null, t: Date.now() })
    return this.reply('⚔️ FF14 纷争前线模拟战 开战！\n选择你的入场方式：\n1 指挥队\n2 四小\n3 散人\n（回复「取消」可结束本局）')
  }

  /** 游戏内输入统一入口 */
  async gameInput () {
    const k = key(this.e)
    const g = games.get(k)
    if (!g) return false
    const raw = this.e.msg.trim()
    // 特殊选择阶段只认 ①②③ / 数字；入场与行动阶段支持中文别名
    const msg = g.status === 'special' ? raw : (TEXT_TO_NUM[raw] || raw)

    if (msg === '结算') return this.doSettle(g, k)
    if (msg === '取消') {
      games.delete(k)
      return this.reply('本局已取消，战场解散。下次记得别浪。')
    }

    if (g.status === 'entry') {
      if (!['1', '2', '3'].includes(msg)) return this.reply('请输入 1 指挥队 / 2 四小 / 3 散人，或回复「取消」。')
      return this.doEntry(g, k, msg)
    }

    if (g.status === 'special') {
      const choice = { '1': 1, '2': 2, '3': 3, '①': 1, '②': 2, '③': 3 }[msg]
      if (!choice) return this.reply('请输入 ① ② ③ 选择，或回复「取消」。')
      return this.doSpecial(g, k, choice)
    }

    // status === 'round'
    if (!['1', '2', '3', '4', '5', '6', '7'].includes(msg)) return this.reply('无效行动。可用行动：1 逛街 / 2 打团 / 3 摸点 / 4 挂机 / 5 游击偷袭 / 6 回防守点 / 7 夹击第三方')
    return this.doAction(g, k, msg)
  }

  /** 选择入场方式，随机阵营与地图 */
  async doEntry (g, k, choice) {
    const ent = ENTRIES[choice]
    g.entry = ent.name
    g.v = clamp(g.v + ent.bonus)
    g.faction = pick(FACTIONS)
    g.map = pick(MAPS)
    g.status = 'round'
    g.round = 1
    g.t = Date.now()
    return this.reply(`${ent.flavor}\n🎖️ 入场方式：${ent.name}\n🎌 随机阵营：${g.faction}\n🗺️ 地图：${g.map.name}（${g.map.mode}）\n——地图简介（摘自灰机wiki）——\n${g.map.intro}\n\n${roundMenu(g)}`)
  }

  /** 执行一轮行动 */
  async doAction (g, k, choice) {
    const actNum = Number(choice)
    const act = ACTIONS[actNum]
    const story = resolveAction(g, actNum)
    // 每回合随机波动 -20 ~ +20（战场局势瞬息万变）
    const drift = ri(-20, 20)
    g.v = clamp(g.v + drift)
    g.round++
    g.t = Date.now()
    if (g.round === 2) g.lb = true // 第2轮解锁 LB

    const lines = [`⚔️ 第 ${g.round - 1} 轮：${act.emoji} ${act.name}`, story]

    // 挂机累计2次：踢出战场，强制战败
    if (actNum === 4 && g.afk >= 2) {
      games.delete(k)
      return this.reply(lines.join('\n') + '\n🚫 挂机累计 2 次，被系统强制清出战场！\n\n' + this.settleText(g, 'afk'))
    }

    // 满3轮强制结算
    if (g.round > 3) {
      games.delete(k)
      return this.reply(lines.join('\n') + '\n\n' + this.settleText(g, 'normal'))
    }

    // 隐藏胜率阈值触发特殊三选一（每局最多一次）
    if (!g.specialShown) {
      if (g.v >= 75) {
        g.specialShown = true
        g.status = 'special'
        g.specialType = 'high'
        return this.reply(lines.join('\n') + '\n\n🤫 你感觉这局稳得离谱，指挥在你耳边低语：\n① 正常玩\n② 堵门\n③ 打老三')
      }
      if (g.v <= 25) {
        g.specialShown = true
        g.status = 'special'
        g.specialType = 'low'
        return this.reply(lines.join('\n') + '\n\n😰 你队已经被打到怀疑人生，指挥破罐子破摔：\n① 正常玩\n② 跟他们爆了\n③ 打打兄弟战场吧')
      }
    }

    return this.reply(lines.join('\n') + '\n\n' + roundMenu(g))
  }

  /** 特殊三选一 */
  async doSpecial (g, k, choice) {
    let line
    if (g.specialType === 'high') {
      if (choice === 1) {
        line = '你选择正常玩。指挥点头：「稳了，别浪。」'
      } else if (choice === 2) {
        g.v = 0
        games.delete(k)
        return this.reply('你选择堵门！全队堵在对面门口，结果对面一波反推直接打崩！\n\n' + this.settleText(g, 'gate'))
      } else {
        g.v = clamp(g.v - 30)
        line = '你选择去打老三！老三队虽然好欺负，但打他们浪费时间，自家分数反被拉开。'
      }
    } else {
      if (choice === 1) {
        line = '你选择正常玩。指挥深吸一口气：「稳住，还有机会。」'
      } else if (choice === 2) {
        g.v = 0
        games.delete(k)
        return this.reply('你选择跟他们爆了！全队冲进人群自爆，对面掉了俩，你们掉了二十个！\n\n' + this.settleText(g, 'boom'))
      } else {
        g.v = clamp(g.v + 30)
        line = '你选择去打打兄弟战场！在老三队身上找回自信，顺便刷了一波分。'
      }
    }
    g.status = 'round'
    g.t = Date.now()
    if (g.round > 3) {
      games.delete(k)
      return this.reply(line + '\n\n' + this.settleText(g, 'normal'))
    }
    return this.reply(line + '\n\n' + roundMenu(g))
  }

  /** 手动结算 */
  async doSettle (g, k) {
    games.delete(k)
    return this.reply(this.settleText(g, 'normal'))
  }

  /** 结算文案：判定胜负 + 圈内梗评语，全程无数字 */
  settleText (g, reason) {
    let verdict, line
    // 胜率特别高（触发过「稳得离谱」）却输了：感慨全看脸
    const highLost = g.specialType === 'high' && (reason === 'afk' || reason === 'gate' || reason === 'boom' || g.v < 50)
    if (reason === 'afk') {
      verdict = '战败 💀'
      line = highLost ? pick(FACE_LINES) : pick(AFK_LINES)
    } else if (reason === 'gate') {
      verdict = '战败 💀'
      line = highLost ? pick(FACE_LINES) : pick(GATE_LINES)
    } else if (reason === 'boom') {
      verdict = '战败 💀'
      line = highLost ? pick(FACE_LINES) : pick(BOOM_LINES)
    } else {
      const win = g.v >= 50
      verdict = win ? '胜利 🏆' : '战败 💀'
      line = highLost ? pick(FACE_LINES) : pick(win ? WIN_LINES : LOSE_LINES)
    }
    return `🏁 对局结算\n结果：${verdict}\n${line}`
  }
}
