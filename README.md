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
| [`plugins/music`](plugins/music) | 本地曲库语音放歌 | `#放首歌`　`#放整首 歌名`　`#音乐 歌名 [秒]`　`#音乐列表` | 无（纯本地 + ffmpeg） |

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
```

放好后 Yunzai 的 watcher 会自动 `[新增插件]`，**不用重启**。新增/修改 `plugins/` 下的文件都会热重载；但如果改了 `utils/` 或 `apps/` 就必须重启。

依赖：`puppeteer`（wiki、fflogs 出图）、`xlsx`（bis）。market 只用原生 `fetch`。

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

### music

本地曲库发**语音消息**（不是语音通话，是 QQ 的语音条）。曲库目录默认 `D:/QQBot/music`，可用环境变量 `VOICE_MUSIC_DIR` 覆盖，支持 `mp3 flac wav m4a ogg aac wma opus ape`，子目录递归扫描。

- 依赖 `ffmpeg` + `ffprobe` 在 PATH（或设 `FFMPEG_PATH` / `FFPROBE_PATH`）。**ffprobe 不能拿 ffmpeg 冒充**，`-show_entries` 参数不认会静默返回空、时长恒 0
- 高潮定位三层：手工标注 → 自动分析（ffmpeg 解码 16kHz 单声道 PCM，每 0.5s 一帧算 RMS 响度 + 差分能量，滑 28s 窗口取最热闹且稳定的一段）→ 解码失败直接报错，不瞎切
- QQ 语音单条上限约 60 秒。`#放整首` 按 60 秒拆成多条依次发（段间停 1.2s），最多 12 段；尾巴不足 5 秒就少发一段，避免出现 1 秒残段
- 随机播放用洗牌袋：一轮内每首都会轮到一次，播完重洗，新轮首曲避开上轮末曲
- 标注存 `plugins/example/data/voice-hooks.json`，按文件 mtime 校验，曲子换了标注自动失效

曲库里**放自己的音频文件**，仓库不含任何音频。

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
| `data/voice-hooks.json` | `#音乐标注 歌名 60-95` 写入的高潮区间 |
| `rising-stones.json` | `#石之家绑定` 写入 |

---

## 免责声明

- 全部是个人自用脚本，**没有做多租户隔离、权限审计、限流加固**，直接开给陌生人用风险自负
- 第三方数据（FFLogs、Universalis、灰机 wiki、石之家、金山文档）版权归各自所有，这里只做查询封装
- 石之家签到涉及个人账号 Cookie，请勿提交到任何公开仓库
- 不提供任何游戏内自动化 / 外挂功能

## 致谢

- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) — 机器人框架
- [thewakingsands/ffxiv-datamining-cn](https://github.com/thewakingsands/ffxiv-datamining-cn) — 中文物品数据
- [Universalis](https://universalis.app/) — 物价 API
- [FFLogs](https://www.fflogs.com/) — 战斗记录
- [灰机 wiki](https://ff14.huijiwiki.com/) — 中文资料
- BIS 配装文档作者 **喵叔孤风行**（[原文档](https://www.kdocs.cn/l/ceEcTzlFQBUy)）
- PVP 轮换参考 [duduvok/ff14-calendar](https://duduvok.github.io/ff14-calendar/)
