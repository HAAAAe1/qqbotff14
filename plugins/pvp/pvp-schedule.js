// FF14 7.5 每日PVP轮换日历
// 命令: #pvp
// 参考: https://duduvok.github.io/ff14-calendar/
//
// 版本更新时需校准 CYCLE_OFFSET（当前7.5版本 = 6）
// 校准方法：找到一个已知日期对应的PVP日，计算 (monthDays + day + OFFSET) % 8 的值

export class PVPSchedule extends plugin {
  constructor() {
    super({
      name: 'PVP日历',
      dsc: 'FF14 每日PVP轮换查询',
      event: 'message',
      priority: 500,
      rule: [{
        reg: /^#pvp$/i,
        fnc: 'showSchedule'
      }]
    })
  }

  // 7.5 每日轮换（8天周期）
  static CYCLE = [
    '尘封秘岩（争夺战）',
    '荣誉野（碎冰战）',
    '昂萨哈凯尔（竞争战）',
    '沃刻其特（演习战）',
    '尘封秘岩（争夺战）',
    '周边遗迹群（阵地战）',
    '昂萨哈凯尔（竞争战）',
    '沃刻其特（演习战）'
  ]

  // 偏移量，7.5版本 = 6（已校准：2026-09-22 = 沃刻其特）
  static CYCLE_OFFSET = 6

  static MONTH_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]

  getTodayIndex() {
    const now = new Date()
    const m = now.getMonth()
    const d = now.getDate()
    return (PVPSchedule.MONTH_DAYS[m] + d + PVPSchedule.CYCLE_OFFSET) % 8
  }

  formatDate(date) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }

  getWeekday(date) {
    return ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  }

  async showSchedule(e) {
    const idx = this.getTodayIndex()
    const today = PVPSchedule.CYCLE[idx]
    const now = new Date()

    // 明天
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowIdx = (idx + 1) % 8
    const tomorrowContent = PVPSchedule.CYCLE[tomorrowIdx]

    // 未来7天
    let weekly = ''
    for (let i = 0; i < 7; i++) {
      const d = new Date(now)
      d.setDate(d.getDate() + i)
      const ci = (idx + i) % 8
      const label = i === 0 ? '✦ 今天' : `  ${this.formatDate(d)}(${this.getWeekday(d)})`
      weekly += `${label}  ${PVPSchedule.CYCLE[ci]}\n`
    }

    const msg = [
      '⚔️ FF14 每日PVP轮换（7.5）',
      '',
      `📌 今天：${today}`,
      `📅 明天：${tomorrowContent}`,
      '',
      '【本周轮换】',
      weekly.trim(),
      '',
      '📐 轮换顺序：',
      '尘封秘岩 → 荣誉野 → 昂萨哈凯尔 → 沃刻其特',
      '→ 尘封秘岩 → 周边遗迹群 → 昂萨哈凯尔 → 沃刻其特',
      '',
      `⚙️ 版本 7.5 | 周期 8天 | 更新日期 ${now.getFullYear()}`
    ].join('\n')

    await e.reply(msg)
  }
}
