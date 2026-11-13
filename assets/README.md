# assets · 素材与许可

这个目录只放插件运行时需要的图标、头像和表情包索引，不放用户上传的表情包（那些在 `data/stickers/`，且已被 `.gitignore` 忽略）。

## 文件清单

| 文件 | 用途 | 来源 / 许可 |
|------|------|-------------|
| `icon.svg` | 设置页、网页 brand 的矢量图标 | 本仓库自绘，随代码按 **MIT** 使用 |
| `icon.png` | 插件图标 | 由 `fornarwhal/deepseek-whale-girl-icon` 的 `improved-1.png` 裁切/缩放，**CC BY-NC-SA 4.0** |
| `avatar.png` | 设置侧栏头像 | 同上，头部特写裁切，**CC BY-NC-SA 4.0** |
| `stickers/recommended.json` | 推荐表情包索引（只含元数据，不含图片） | 本项目维护的索引；指向的第三方表情包各自适用上游许可，下载前请阅读对应仓库的 LICENSE |

## 角色立绘署名

- 原创 OC「溟月」：上善无形（Bilibili）
- DeepSeek 元素女仆鲸鱼娘二次设计：ZipZipPipe（Bilibili）
- `improved-1.png` 去伪影修复：QYQCAMIAO
- 上游仓库：<https://github.com/fornarwhal/deepseek-whale-girl-icon>
- 上游仓库另注明「图片来自网络流传，具体作者未确认」

## 使用边界

`assets/icon.png` 和 `assets/avatar.png` 不是 MIT 代码的一部分，按 **CC BY-NC-SA 4.0** 单独约束：

- 必须保留署名与许可说明；
- **不得用于商业用途**；
- 二次分发必须采用相同协议（CC BY-NC-SA 4.0）；
- 本项目当前把它们用于个人本地自用的插件图标和页面形象；若要商用、公开发行或打包分发给他人，请先替换为自有/已获授权素材，或取得原作者许可。

代码本身的许可见根目录 [`LICENSE`](../LICENSE)；第三方组件总表见 [`docs/legal/THIRD_PARTY_NOTICES.md`](../docs/legal/THIRD_PARTY_NOTICES.md)。
