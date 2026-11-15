# assets · 素材与许可

这个目录只放插件运行时需要的图标、头像、初始角色形象和表情包索引；不放用户上传的表情包或角色图（那些在 `data/stickers/`、`data/characters/`，且已被 `.gitignore` 忽略）。

## 文件清单

| 文件 | 用途 | 来源 / 许可 |
|------|------|-------------|
| `icon.svg` | 设置页、网页 brand 的矢量图标 | 本仓库自绘，随代码按 **MIT** 使用 |
| `icon.png` | 插件图标 | 由 `fornarwhal/deepseek-whale-girl-icon` 的 `improved-1.png` 裁切/缩放，**CC BY-NC-SA 4.0** |
| `avatar.png` | 设置侧栏头像 | 同上，头部特写裁切，**CC BY-NC-SA 4.0** |
| `character/dandan/` | 蛋蛋初始形象库：13 张缩略图 + `manifest.json` + 素材说明；13 张原图在 GitHub Release | AI 重绘，基于社区二创「大肥鱼／溟月」；**CC BY-NC-SA 4.0**，见该目录 [`README.md`](./character/dandan/README.md) |
| `character-packs.json` | 形象资源包下载清单（pack id、Release tag、文件大小、SHA-256） | 本项目维护，随代码按 **MIT** 使用 |
| `stickers/recommended.json` | 推荐表情包索引（只含元数据，不含图片） | 本项目维护的索引；指向的第三方表情包各自适用上游许可，下载前请阅读对应仓库的 LICENSE |
| `fonts/LongCang-Regular.ttf` | 专注创作手绘稿的手写体文字与落款 | `googlefonts/longcang`，**OFL-1.1**（`LongCang-OFL.txt`）；随仓库分发，不依赖用户安装 |
| `draw/sprites/` | 专注创作角色底稿（35 张透明手绘立绘：13 种姿态 × 常用表情） | 基于蛋蛋初始形象的手绘化衍生稿，**CC BY-NC-SA 4.0**；见该目录 [`README.md`](./draw/sprites/README.md) |
| `draw/renderer.js` | 专注创作纸张、浅色场景物件、角色合成与落款绘制代码 | 本项目自研，随代码按 **MIT** 使用；不含第三方图片 |

## 角色立绘署名

- 原创 OC「溟月」：上善无形（Bilibili）
- DeepSeek 元素女仆鲸鱼娘二次设计：ZipZipPipe（Bilibili）
- `improved-1.png` 去伪影修复：QYQCAMIAO
- 上游仓库：<https://github.com/fornarwhal/deepseek-whale-girl-icon>
- 上游仓库另注明「图片来自网络流传，具体作者未确认」

## 蛋蛋初始形象库

`character/dandan/` 是项目的初始形象资产，13 张 **2848 × 1600 PNG** 三视图，按年龄段和造型命名，全部放在一个文件夹里，不按年龄建子目录。**原图不进 Git**，放在同仓库的 GitHub Release `character-dandan-v1`；同目录只保留 13 张 **640 × 360 WebP 缩略图**（合计约 0.51MB）、`manifest.json` 和授权说明。`manifest.json` 是网页形象库和后续创作流程的唯一读取入口，新增、改名、授权的规则见该目录 [`README.md`](./character/dandan/README.md)。

- 幼年 Q 版 3 张：浅海奶油小水手、深海星庭小礼服、初始深蓝女仆装；
- 少女成长版 10 张：深海星庭小礼服、极光信使制服、初始深蓝女仆装 V1–V8；
- 当前没有成年版素材；
- 网页先用缩略图展示；用户点“下载初始形象原图”后，运行时下载到 `data/characters/packs/dandan-initial/`，不进 Git；
- 这组图和 `icon.png` / `avatar.png` 一样，是 **CC BY-NC-SA 4.0** 的 AI 重绘衍生稿，**不适用 MIT**，不能商用；
- 用户自己上传的形象图放 `data/characters/`，已被 `.gitignore` 忽略，不进仓库。

## 使用边界

`assets/icon.png`、`assets/avatar.png` 和 `assets/character/dandan/` 的 13 张原图（通过 GitHub Release 分发，连同同目录 `*-thumb.webp`）不是 MIT 代码的一部分，按 **CC BY-NC-SA 4.0** 单独约束；`assets/draw/sprites/` 的 35 张专注创作底稿同样按 **CC BY-NC-SA 4.0**。`assets/draw/renderer.js` 是自研绘制代码，按 **MIT**。

- 必须保留署名与许可说明；
- **不得用于商业用途**；
- 二次分发必须采用相同协议（CC BY-NC-SA 4.0）；
- 本项目当前把它们用于个人本地自用的插件图标和页面形象；若要商用、公开发行或打包分发给他人，请先替换为自有/已获授权素材，或取得原作者许可。

代码本身的许可见根目录 [`LICENSE`](../LICENSE)；第三方组件总表见 [`docs/legal/THIRD_PARTY_NOTICES.md`](../docs/legal/THIRD_PARTY_NOTICES.md)。
