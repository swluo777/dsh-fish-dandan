# 蛋蛋 · 初始形象库

这里放 DeepSeek 大肥鱼／鲸鱼娘的初始三视图素材。所有图都是 **16:9 横版角色设定表**，尺寸 **2848 × 1600 PNG**，同一角色、同一套服装的正面 / 侧面 / 背面，加细节格和表情差分。

## 原图在哪

**13 张 PNG 原图不进 Git**，放在同一个 GitHub Release：

- 仓库：`swluo777/dsh-fish-dandan`
- tag：`character-dandan-v1`
- 地址：`https://github.com/swluo777/dsh-fish-dandan/releases/tag/character-dandan-v1`
- 单文件下载：`https://github.com/swluo777/dsh-fish-dandan/releases/download/character-dandan-v1/<文件名>`

本目录只保留 **13 张 `*-thumb.webp` 缩略图**（640 × 360，合计约 0.51MB）、`manifest.json`、本说明和 `LICENSE.md`。网页先用缩略图展示；用户点“下载初始形象原图”后，运行时下载到 `data/characters/packs/dandan-initial/`，不进 Git。

发布新版本时，更新 `assets/character-packs.json` 的 `version`、`releaseTag`、`baseUrl` 和每个文件的 `sha256`，再建一个新的 Release tag；不要覆盖旧 tag。

同目录的 `*-thumb.webp` 是 **640 × 360** 网页缩略图，只给列表和卡片用；详情页和下载仍用原 PNG。缩略图由原图生成，不要手工改。

## 命名规则

`序号-年龄段-造型-版本.png`

- `child`：幼年 Q 版，约 2.5–3 头身。
- `teen`：少女成长版，约 6.5–7 头身。
- `adult`：成年版，当前暂无素材。
- 同一个造型的多个生成结果用 `v1`、`v2` 区分；不要覆盖旧版本。

## 当前清单

下表是 Release 中的 13 张原图；Git 里对应的是同名 `*-thumb.webp` 缩略图。

| 文件 | 年龄段 | 造型 | 说明 |
|------|--------|------|------|
| `01-child-cream-sailor.png` | 幼年 | 浅海奶油小水手 | 浅色水手领、贝壳围裙、双肩小鱼鳍包 |
| `02-child-starlit-cape.png` | 幼年 | 深海星庭小礼服 | 白裙 + 深蓝星披肩 + 小皇冠 |
| `03-child-initial-maid.png` | 幼年 | 初始深蓝女仆装 | 最初版深蓝女仆装，项目初始形象 |
| `04-teen-starlit-cape.png` | 少女 | 深海星庭小礼服 | 少女比例的白裙 + 深蓝星披肩 |
| `05-teen-aurora-courier.png` | 少女 | 极光信使制服 | 雾紫短外套、百褶裙、贝雷帽、邮差包 |
| `06-teen-initial-maid-v1.png` | 少女 | 初始深蓝女仆装 V1 | 当前主形象 |
| `07-teen-initial-maid-v2.png` | 少女 | 初始深蓝女仆装 V2 | 女仆装变体 |
| `08-teen-initial-maid-v3.png` | 少女 | 初始深蓝女仆装 V3 | 女仆装变体 |
| `09-teen-initial-maid-v4.png` | 少女 | 初始深蓝女仆装 V4 | 女仆装变体 |
| `10-teen-initial-maid-v5.png` | 少女 | 初始深蓝女仆装 V5 | 女仆装变体 |
| `11-teen-initial-maid-v6.png` | 少女 | 初始深蓝女仆装 V6 | 女仆装变体 |
| `12-teen-initial-maid-v7.png` | 少女 | 初始深蓝女仆装 V7 | 女仆装变体 |
| `13-teen-initial-maid-v8.png` | 少女 | 初始深蓝女仆装 V8 | 女仆装变体 |

## 元数据

`manifest.json` 是网页端和创作流程的唯一入口。新增图片时：

1. 按命名规则生成原图，先放进 Release 待上传目录（不要放进 Git 工作区）；
2. 生成同名 `*-thumb.webp` 缩略图，放进本目录；
3. 在 `manifest.json` 的 `images` 里增加一条，填 `id`、`file`、`thumbFile`、`title`、`ageGroup`、`outfitId`、`tags`、`width`、`height`、`bytes`、`sha256`；
4. 在 `assets/character-packs.json` 的 `files` 里增加同名文件、字节数和 SHA-256；如果换新版本，改 `version` / `releaseTag` / `baseUrl`；
5. 不要改旧图片的 `id` 和文件名，避免网页端已选中的形象失效；
6. 用户自己上传的图不要放这里，运行时上传进 `data/characters/`，不进 Git。

## 角色与许可

这些图是 **AI 重绘稿**，角色来自社区二创，不是 DeepSeek 官方设定。

- 原创 OC「溟月」：上善无形（Bilibili）
- DeepSeek 元素女仆鲸鱼娘二次设计：ZipZipPipe（Bilibili）
- 许可：**CC BY-NC-SA 4.0**（署名、非商业、相同方式共享）
- 商用、公开发行或打包分发前，需取得原作者许可，或替换为自有/已获授权素材。
- 更细的素材边界见 [`../../README.md`](../../README.md) 与 [`../../../docs/legal/THIRD_PARTY_NOTICES.md`](../../../docs/legal/THIRD_PARTY_NOTICES.md)。

## 给后续功能留的字段

- `ageGroup`：`child` / `teen` / `adult`，网页端按这个分组。
- `outfitId`：同一套衣服的唯一标识，未来换装和“按心情选衣服”都靠它。
- `variant`：同一造型的多个生成版本。
- `viewType`：目前统一是 `turnaround-sheet`，以后可以加 `single-illustration`、`expression-sheet`。
- `threeView`：是否包含正面 / 侧面 / 背面，创作流程用它判断能不能直接做动画参考。
- `tags`：给搜索和自动选图用，例如“日常 / 华丽 / 冬季 / 女仆 / 星庭”。
- `bytes` / `sha256`：原图大小与校验值，下载器用它验证文件完整。
- `origin`：`release` 表示内置原图从 Release 下载；用户上传的图运行时标为 `upload`。
- `isOrigin`：最初版身份锚点。
- `isPrimary`：默认主形象；网页端“设为主形象”会写 `data/state/character.json`，不改图片本身。
