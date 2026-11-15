# 第三方组件声明（THIRD_PARTY NOTICES）

本文件记录本项目依赖、打包或复制的所有第三方软件，确保归属与许可证合规。每新增一个依赖都必须同步更新本表。

## 运行时宿主关系说明

本项目是 **DeepSeek Harness（DSH）的插件**，不是独立应用：DSH 与 Node.js 属于运行时宿主，不随本仓库分发，其许可证由宿主自身提供。本项目仅通过其公开插件 API 接入，不修改宿主源码。

## 当前清单

| 组件 | 版本 | 来源 | 许可证（SPDX） | 复用方式 | 用途 | 是否修改 |
|------|------|------|----------------|----------|------|----------|
| Q 版鲸鱼娘立绘 `improved-1.png` | 仓库 main（2026-08） | https://github.com/fornarwhal/deepseek-whale-girl-icon | CC BY-NC-SA-4.0 | 裁切/缩放为 `assets/icon.png`，头部特写为 `assets/avatar.png` | 插件图标、设置侧栏头像、网页 brand、主页大图 | 是（仅裁切与缩放，未改画） |
| 蛋蛋初始三视图 13 张（`assets/character-packs.json` + GitHub Release `character-dandan-v1`） | 本项目 AI 重绘（2026-11） | 基于社区二创「大肥鱼／溟月」角色；原创 OC 与女仆装设计署名见下 | CC BY-NC-SA-4.0 | 原图不入 Git，随 Release 分发；仓库内只保留 13 张缩略图与 `manifest.json` | 网页形象库、抖音图文/动画/视频的参考底图 | 是（AI 重绘、命名整理与元数据登记） |
| 推荐表情包索引 `assets/stickers/recommended.json` | 本项目维护（2026-11） | https://github.com/anka-afk/astrbot-meme-pack-index | 索引元数据随本项目；指向的图片包各自适用上游许可 | 只随仓库分发 JSON 元数据，不打包图片 | 新用户选择并远程下载表情包 | 否 |
| 龙藏体 Long Cang `assets/fonts/LongCang-Regular.ttf` | 2018 | https://github.com/googlefonts/longcang | OFL-1.1 | 随仓库分发 TTF（`assets/fonts/LongCang-OFL.txt`），手稿页用 `@font-face` 从项目内加载；不内联、不请求外网 | 专注创作手绘稿的手写体文字与落款 | 否 |
| 专注创作角色底稿 17 张 `assets/draw/sprites/*.png` | 本项目 AI 重绘（2026-11） | 基于蛋蛋初始形象（社区二创「大肥鱼／溟月」）；角色 OC 与女仆装设计署名见 `assets/character/dandan/README.md` | CC BY-NC-SA-4.0 | 17 张透明 PNG 随仓库分发，作为专注创作的运行时角色层；来源与维护见 `assets/draw/sprites/README.md` | 专注创作手绘稿 | 是（AI 重绘、去白与裁切） |
| README 状态页截图 `docs/assets/status-page.png` | 本项目截图（2026-11） | 界面截图，含上述 Q 版鲸鱼娘立绘 | 截图部分按 CC BY-NC-SA 4.0（衍生展示）；界面代码仍 MIT | 文档展示 | 项目介绍 | 是（截图裁切） |
| ~~鲸鱼娘头像剪影 `head-mark.svg`~~ | 仓库 main | https://github.com/dyguests/dsh-custom-brand | 社区同人立绘 | **曾**用于 16px 单色剪影；v0.2 起已换成彩色头像，路径数据已从仓库移除 | 历史素材（不再分发） | — |

## 美术素材与代码许可分离（重要）

本项目**代码**沿用 MIT；上表当前在用的**美术素材**不适用 MIT，按上游条款单独约束：

- 立绘：CC BY-NC-SA 4.0 —— 需署名、**非商业使用**、二次分发须以相同协议共享。
- `assets/character/dandan/` 的 13 张初始三视图同样是 AI 重绘衍生稿，按 CC BY-NC-SA 4.0 单独约束；原图通过 GitHub Release `character-dandan-v1` 分发，**不进入 Git**，仓库内只保留缩略图与元数据；不得按 MIT 再授权。用户自己上传的形象图放 `data/characters/`，不进仓库。
- 曾用的剪影来自 `dsh-pet-dafeiyu / codex-deepseek-pet` 系列同人立绘，现已移除；`assets/icon.svg` 改为本仓库自绘的彩色矢量头像，不含第三方素材。
- 角色谱系署名：原创 OC「溟月」＝ 上善无形（Bilibili）；DeepSeek 元素女仆鲸鱼娘二次设计 ＝ ZipZipPipe（Bilibili）；`improved-1.png` 去伪影修复 ＝ QYQCAMIAO。上游仓库另注明「图片来自网络流传，具体作者未确认」。
- 因此当前素材适合**个人本地自用**；若要商用、公开发行或打包分发给他人，请先替换为自有/已获授权的素材，或取得原作者许可，并保留本段署名。更细的素材清单与边界见 [`assets/README.md`](../../assets/README.md)。
- 素材由本机 web 服务经 `/fish-dandan/ui/icon.png` 提供，不上传到任何服务器。

补充说明：

- 记忆存储使用 Node 内置模块 `node:sqlite`，随 Node 运行时提供，**不属于第三方依赖**，无需在本表登记；
- 客户端 bundle `src/client/client.js` 为手写代码，仅通过平台模块表 `require("react")`，不引入打包器与第三方 UI 库；设置侧栏头像以 data URI 内联，零外部请求；
- 若后续接入向量检索、浏览器自动化等组件，先按本文模板登记，再写代码。

## 借鉴思路（未复制代码）

人格、记忆、主动行为和平台自动化的一部分设计参考了社区开源项目与公开研究。完整名单、各自许可证和“只借机制 / 未复制源码”的处理方式见根目录 [README 的「感谢与借鉴」](../../README.md#感谢与借鉴)。

这些项目不构成运行时依赖；除上表列出的头像素材外，本仓库未复制它们的源码、词表或素材。许可证不兼容的项目（AGPL-3.0、NOASSERTION、无 License）只作为设计参考，不进入本仓库代码。

## 登记条目模板

复制以下模板填写，禁止漏项：

```
### 组件名
- 版本：
- 来源 URL：
- 许可证 SPDX：MIT / Apache-2.0 / BSD-3-Clause / MPL-2.0 / LGPL-3.0 / GPL-3.0 / AGPL-3.0
- 复用方式：声明依赖 / 打包进产物 / 复制进 third_party
- 用途：
- 是否修改：否 / 是（说明位置与 MODIFICATIONS.md）
- 版权声明：（按上游要求原文保留）
```

## 合规红线

- 宽松型（MIT / Apache-2.0 / BSD）：保留本声明即可使用；
- 弱传染（MPL / LGPL）：修改文件须开源或以独立文件隔离；
- 强传染（GPL / AGPL）：与本项目分发组合前必须评估，可能要求整体开源，必要时改用替代或自研；
- 任何组件的许可证与本项目 MIT 不兼容时，先解决合规问题再引入，不得先使用后补票。
