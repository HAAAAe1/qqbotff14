# qqbotff14

自用的 FF14 相关 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) 插件集合，按功能分类归档。

跑在个人 QQ + 协议端（非官方 Bot API）上，**没有做过多适配，直接拿去用可能需要改**。写的时候都是按国服（CN）环境实测的。

---

## 插件清单

| 目录 | 插件 | 命令 | 依赖外部服务 |
|---|---|---|---|
| [`plugins/wiki`](plugins/wiki) | 灰机 wiki 查询 | `#f 关键词`　`#查询`　`#ff14`　`#wiki` | ff14.huijiwiki.com（需本机浏览器） |
| [`plugins/fflogs`](plugins/fflogs) | 战斗记录战绩 | `#fflogs 服务器 角色名` | FFLogs V2 API（需自建 Client） |
| [`plugins/market`](plugins/market) | 物价查询 | `#市场 物品名 [hq]`　`#市场 物品ID`　`#市场更新` | Universalis + 中文物品索引 |
| [`plugins/bis`](plugins/bis) | BIS 配装链接 | `#bis 职业 [关键词]`　`#bis检测`　`#更新bis` | 金山文档（本地 xlsx） |
| [`plugins/house-subscribe`](plugins/house-subscribe) | 房屋在售订阅 | `#房屋查询` / `#房屋查询订阅` / `#房屋查询退订` | house.ffxiv.cyou |
| [`plugins/pvp`](plugins/pvp) | PVP 轮换 + 前线小游戏 | `#pvp`　`#战场` / `#前线` | 无 |
| [`plugins/rising-stones`](plugins/rising-stones) | 石之家签到 | `#石之家签到` / `#石之家绑定` / `#石之家自动签到` | 石之家 + Playwright 刷 Cookie |
| [`plugins/glamour`](plugins/glamour) | 石之家随机幻化 | `#随机幻化`　`#随机幻化 拉拉肥` | 石之家（复用 rising-stones 的 Cookie） |
| [`plugins/news`](plugins/news) | 国服公告推送 | `#开启ff14新闻推送`　`#关闭ff14新闻推送`　`#查看ff14最近新闻` | cqnews.web.sdo.com |
| [`plugins/sites`](plugins/sites) | FF14 网站导航检索 | `#查网站 物价`　`#查网站`　`#更新网站` | gamecircum.com（抓取建本地索引） |

命令速查见 [`docs/命令速查.md`](docs/命令速查.md)。

---

## 安装

本仓库按功能分目录，**插件文件本身没有改相对路径**（都还是 `../../lib/plugins/plugin.js`），所以放进 Yunzai 时要平铺到 `plugins/example/`：

```bash
git clone https://github.com/HAAAAe1/qqbotff14.git
cd qqbotff14

# 按需复制，不要整个目录塞进去
cp plugins/fflogs/fflogs.js      /path/to/TRSS-Yunzai/plugins/example/
cp plugins/market/market.js      /path/to/TRSS-Yunzai/plugins/example/
cp plugins/glamour/glamour.js    /path/to/TRSS-Yunzai/plugins/example/   # 需先装 rising-stones 并绑号
cp plugins/sites/sites.js        /path/to/TRSS-Yunzai/plugins/example/
```

放好后 Yunzai 的 watcher 会自动 `[新增插件]`，**不用重启**。新增/修改 `plugins/` 下的文件都会热重载；但如果改了 `utils/` 或 `apps/` 就必须重启。

依赖：`puppeteer`（wiki、fflogs 出图）、`xlsx`（bis）。market、news、sites 只用原生 `fetch`。

```bash
cd /path/to/TRSS-Yunzai && pnpm add puppeteer xlsx
```

---

## 各插件配置

### wiki

不需要凭据。会用 puppeteer 自己拉起 Edge/Chrome 并 `--remote-debugging-port` 连接，路径在文件顶部的 `BROWSER_PATH` 里，按自己的安装位置改。

> ⚠️ ff14.huijiwiki.com 对机房 IP 不友好，只放行家宽。部署在云服务器上大概率直接失败。

### fflogs

```bash
cp plugins/fflogs/fflogs.example.json /path/to/TRSS-Yunzai/plugins/example/fflogs.json
# 填入 clientId / clientSecret
```

凭据获取：FFLogs 网站 → 右上头像 → **Clients** → Create Client → 类型选 **Public Client**，拿 client id / secret。

- 走 OAuth2 `client_credentials`，token 有效期 1 年
- 服务器名用**中文**（`白银乡`、`红玉海`…），拼音会返回 null
- 一次查询会并发打 14 个 zone，约 **4~5 秒**，结果出图

<details>
<summary>关于「旧版本绝本查不到」的坑（重要）</summary>

FFLogs 给**同一个绝本在每个资料片 zone 里各存了一份 encounter 副本，ID 全不同**。旧版本上传的战斗记录只挂在旧 zone 的副本上，只查 `zone 59` 永远是 0 条。

实测某个角色：亚历山大在 z59 是 0 条、在 z43 是 28 条；究极神兵 z59 只有 2 条、z43 有 67 条。

所以代码里 7 个绝本都挂了它所有历史副本：

| 绝本 | encounterID @ zone |
|---|---|
| 巴哈姆特 | 1039@19 · 1047@30 · 1060@43 · 1073@59 |
| 究极神兵 | 1042@23 · 1048@30 · 1061@43 · 1074@59 |
| 亚历山大 | 1050@32 · 1062@43 · 1075@59 |
| 幻想龙诗 | 1065@45 · 1076@59 |
| 欧米茄 | 1068@53 · 1077@59 |
| 光暗未来 | 1079@65 |
| 妖星乱舞 | 1085@76 |

查完按绝本归并：Kills 求和、Best/RDPS 取最高分那条、最快击杀取最小。零式只查当前大版本 7.x 三期（73/68/62），24 人本只查暗黑之云。

</details>

### market

不需要凭据，但需要一个**中文物品索引**（Universalis 只认数字 itemID，没有名字搜索接口）。

首次使用前发一次：

```
#市场更新 强制
```

会从 `thewakingsands/ffxiv-datamining-cn` 拉 `Item.csv`（约 19MB），和 Universalis 的 `/marketable`（约 95KB）取交集，生成本地索引（约 1.7 万条 / 470KB）。之后：

- 启动 5 分钟后自检一次，**此后每 7 天**一次，只有出现新物品才重建
- `#市场更新` 手动查是否有新物品（无变化不下载）
- `#市场更新 强制` 无视差异强制重建

价格是实时的（每次查询打 28 个国服区服，约 3 秒），NQ / HQ 分开取 `minPriceNQ` / `minPriceHQ`——`minPrice` 会混在一起，不能直接用。

### bis

数据不是在线抓的，是本地 xlsx 解析：

1. 打开 [原文档](https://www.kdocs.cn/l/ceEcTzlFQBUy)（作者：喵叔孤风行）→ 导出 Excel
2. 存成 `plugins/example/data/bis-source.xlsx`
3. 发 `#更新bis` 解析成 `data/bis-data.json`

**文档更新检测**：金山文档分享页的 HEAD 响应头带 `x-file-version`（形如 `20261021160513-ea8677e50e`，前 14 位是修改时间），匿名可读。插件启动 5 分钟后查一次、之后每 7 天查一次，发现变化就私聊提醒（需要设环境变量）：

```bash
export BIS_MASTER_QQ=你的QQ号    # 不设就只写日志不推送
```

`#bis检测` 可随时手动查。

### house-subscribe

不需要凭据。数据源 `house.ffxiv.cyou`，每个区服一条气泡，首条标注来源，30 秒限流。

订阅后**每晚 21:00** 合并推送到对应群/私聊。管理命令（`#清除订阅群聊` / `#禁止订阅` 等）默认走 Yunzai 的 master 权限。

### pvp

不需要凭据。轮换周期 8 天，`CYCLE_OFFSET = 6`（7.5 版本）。游戏版本更新后需要重新校准，文件头有校准方法。

`#战场` / `#前线` 是纯文字小游戏，最多 3 轮行动，规则参考灰机 wiki。

### rising-stones

依赖一个**外部项目**才能自动续 Cookie：`ff14-signin`（Playwright，`refresh_cookie.py`），需要放在 Yunzai 的 `plugins/` 同级目录下（代码按 `plugins/example/ → ../../ff14-signin` 推导）。没有它就只能手动 `#石之家绑定 <cURL>`，Cookie 过期后重新绑。

```bash
export RISING_STONES_OWNER=你的QQ号      # 不设则不限制使用者（不建议）
export FF14_SIGNIN_PYTHON=C:/path/to/python.exe   # 默认用 PATH 里的 python
```

Cookie 存在 `plugins/example/rising-stones.json`，**不要提交到仓库**。

### glamour

从石之家随机抽一套幻化，发合并转发：图 → 文字（作者/区服/种族/装备/染色）→ 原帖链接。

| 命令 | 说明 |
|---|---|
| `#随机幻化` | 1 次接口，约 0.5~0.8 秒 |
| `#随机幻化 拉拉肥` | 指定种族，客户端反复刷，最多 8 次，约 0.5~4.5 秒 |

- **不单独存凭据**，直接读同目录的 `rising-stones.json`（只读不写），那边每天 09:00 自动续期。没绑号提示先 `#石之家 登录`，Cookie 失效回 `10403` 时提示重绑
- 种族别名 66 个：`拉拉肥 / 土豆 / 矮子`、`猫娘 / 猫猫 / 喵`、`龙娘 / 龙族`、`兔娘 / 兔兔 / 兔女郎`、`大猫 / 大猫猫`、`长耳`、`大块头 / 巨人`、`中原 / 高地` …，也接受数字 `1`~`8`。带「男 / 女」的词只映射种族，**不筛性别**
- 冷却按 QQ 号记：裸命令 10 秒、带种族 30 秒；接口报错会清冷却，让用户能立刻重试
- 图片取「主图 + 图集」去重后最多 2 张。**大部分投稿只传了一张，凑不满 2 张是正常的**（实测 20 条里只有 4 条能凑满）
- 转发发不出去时降级成「图片一条 + 文字一条」两条普通消息

> ⚠️ **`priority` 必须很小（这里用 1）**。earth-k-plugin 的「土块AI画图」带一条 `^#(.*)化$` 的宽正则，会把 `#随机幻化` 当成画图命令吞掉（回你「你还没有填写密钥哦」），而它的 priority 是 5。

<details>
<summary>接口说明与字段坑</summary>

- 接口：`POST/GET https://apiff14risingstones.web.sdo.com/api/home/glamour/randomGlamours`、`glamour/glamourDetail?id=`，**必须带登录 Cookie**，否则 `{"code":10403,"msg":"请先登录"}`
- `randomGlamours` 的返回是 `{code, msg, data: {rows: [...]}}`，**`data` 不是数组**
- `randomGlamours` **不接受任何筛选参数**（`raceIds / race_ids / raceId / race / genderIds` 实测全被忽略），所以按种族挑只能在客户端过滤
- `images` 可能是空串（多数情况），`main_image` 一定有；两者 URL 恒不相同，是同一套的不同镜头
- `dye_ids` 长度常常大于 `dyes` 实际数组（如 `dye_ids=[13114,-1]` 只给 1 个染料对象），不能按长度 zip，要按下标配对
- 列表接口的 `race_ids` 是数字数组 `[3]`，详情接口是对象数组 `[{id:3,name:'拉拉菲尔族'}]`，统一取 `id`
- 空槽 `equipment_id = -1`，`name` 为 `null`，要跳过；`is_fashion = 1` 标「（投影）」
- 列表接口是「首页推荐」，**不能穷举**：`page` 翻到 20000 仍返回 12 条且时间乱跳，只适合当随机 / 热门源

</details>

### news

国服官方公告推送，数据源是盛趣官网 SPA 背后的资讯接口 `cqnews.web.sdo.com`。**不需要凭据，也不需要 cookie / Referer / UA**，裸 `fetch` 就通。

| 命令 | 说明 |
|---|---|
| `#开启ff14新闻推送` | 订阅当前群 / 当前私聊（各自独立），开启时顺手探一次接口并把现有公告记为基线 |
| `#关闭ff14新闻推送` | 退订当前会话 |
| `#查看ff14最近新闻` | 立刻看最近 5 条，不订阅也能用，30 秒冷却 |

- 定时任务用 Yunzai 原生 `task`，cron `10 */2 * * *`（每两小时的第 10 分钟）。公告不是行情，两小时一次足够，正确性只取决于「别停机太久」
- 推送走**合并转发**：标题节点 → 每条公告一个节点 → 超过 8 条时补一个提示节点。转发发不出去会回退成一条纯文本
- 分类 `8324,8325,5310`：公告（暂停/恢复）+ 最新情报（版本更新笔记、季节活动、联动、商城周边）
- **只靠 `Id` 差集判断新旧**。接口返回不按时间排（有 `SortIndex` 人工置顶，实测 10/21 的条目排在 10/26 前面），所以一律自己按 `PublishDate` 重排
- **先写 `seen` 再推送**：推失败也不下一轮重复刷屏，代价是那一次丢了就丢了
- **抓不到数据就整轮退出，绝不动 `seen`**，否则网络一抖恢复后整批重推
- 没人订阅时一次请求都不发

<details>
<summary>接口的几个坑</summary>

- `pageSize` 实际上限 50，传 40 或 100 都回 50 条；传 ≤20 才精确
- `Summary === '333'` 是官网自己隐藏的占位条目，要过滤
- `OutLink` 非空是外链活动页，空才拼站内详情页 `.../#/newstab/newscont/<Id>`
- `PublishDate` 形如 `2026/10/23 14:16:06`，**已经是北京时间**，不需要换算，字符串排序等于时间排序
- 全站 852 条里 `5310` 占 613 条、其中一半是商城周边；不想被周边刷屏就把 `CATEGORIES` 改回 `8324,8325`
- **改过 `CATEGORIES` 之后必须把数据文件里的 `seenInited` 置 `false`**，否则新分类的历史公告会被整批当成新公告推出去（实测差集 24 条）

</details>

### sites

FF14 常用网站导航的模糊检索，数据源是第三方导航站 `gamecircum.com/games/ff14/`（14 个分类，去重后 177 个站点）。**不需要凭据**，抓一次存本地，之后全走本地索引。

| 命令 | 说明 |
|---|---|
| `#查网站` | 列出全部 14 个分类及各分类站点数 |
| `#查网站 <需求>` | 按需求模糊搜索，返回最相关的 6 个站点（名称 / 简介 / 链接） |
| `#查网站 <分类名>` | 输入分类名（如 `幻化相关`）时直接铺该分类，最多显示 12 个 |
| `#更新网站` | 重新抓取导航站重建索引（仅 bot 管理员） |

- 数据落盘 `data/ff14-sites.json`（原子写入，先写 `.tmp` 再 rename）。**过期 7 天后首次查询会在后台静默刷新**，不阻塞本次回复
- 第一次用必须先能抓到数据；抓不到会提示「让 bot 管理员发 `#更新网站`」，不会静默返回空
- 匹配分七层打分：名称精确 → 名称包含 → 描述包含 → 分类包含 → 字覆盖度 → 二元组重合 → 同义词扩展，低于 55 分不返回
- 每人 5 秒冷却（走 redis）
- 结果走合并转发；命中少于 3 条且不是精确命中时，末尾会带出同分类的其他站点名，方便接着翻
- 抓取只解析 HTML 里的 `module-url-list` 块，**没装 cheerio**，纯正则 + `Map` 按 URL 归一去重（同一站点挂多个分类会合并 `cats`）

<details>
<summary>为什么要 priority 2</summary>

`ff14wiki` 是 1、土块（earth-k）原本是 5。**priority 数字越小越先跑，首个命中的插件执行完直接 `return`**，所以宽正则插件会把后面的命令吃掉。这里取 2 夹在中间，保证 `#查网站` 不被抢答。

</details>

---

## 数据文件

仓库里**不含**任何数据文件（`.gitignore` 已排除）。clone 后：

| 文件 | 怎么来 |
|---|---|
| `data/market-items.json` | `#市场更新 强制` 自动生成 |
| `data/bis-source.xlsx` | 从金山文档手动导出 |
| `data/bis-data.json` | `#更新bis` 生成 |
| `data/bis-state.json` | 检测文档版本用，自动生成 |
| `data/house-subscribe.json` | 订阅时自动生成 |
| `data/ff14-news.json` | 首次 `#开启ff14新闻推送` 时生成（订阅表 + 去重表） |
| `data/ff14-sites.json` | 首次 `#查网站` 时抓取生成，7 天后自动后台刷新 |
| `rising-stones.json` | `#石之家绑定` 写入（glamour 也读这一份） |

---

## 免责声明

- 全部是个人自用脚本，**没有做多租户隔离、权限审计、限流加固**，直接开给陌生人用风险自负
- 第三方数据（FFLogs、Universalis、灰机 wiki、gamecircum、石之家、金山文档）版权归各自所有，这里只做查询封装
- 石之家签到 / 随机幻化涉及个人账号 Cookie，请勿提交到任何公开仓库
- 不提供任何游戏内自动化 / 外挂功能

## 致谢

- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) — 机器人框架
- [thewakingsands/ffxiv-datamining-cn](https://github.com/thewakingsands/ffxiv-datamining-cn) — 中文物品数据
- [Universalis](https://universalis.app/) — 物价 API
- [FFLogs](https://www.fflogs.com/) — 战斗记录
- [灰机 wiki](https://ff14.huijiwiki.com/) — 中文资料
- BIS 配装文档作者 **喵叔孤风行**（[原文档](https://www.kdocs.cn/l/ceEcTzlFQBUy)）
- PVP 轮换参考 [duduvok/ff14-calendar](https://duduvok.github.io/ff14-calendar/)
- 公告数据来自盛趣游戏《最终幻想14》国服官网
