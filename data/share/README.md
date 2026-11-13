# data/share · 可分享的“养成配方”

这里放的是**脱敏后的示例数据**，不是运行时原始数据。目的：别人拿到仓库后，不用从零捏人格，可以在蛋蛋的基础上改。

| 文件 | 作用 | 怎么用 |
|---|---|---|
| `persona.example.json` | 完整人格：身份、五维、口头禅、日常反应、边界、背景故事 | 先备份 `data/persona/core-persona.json`，再把这份复制过去；称呼已改成通用的“主人”，用网页或文本编辑器改成自己的 |
| `platform-settings.example.json` | 抖音能力位的安全起点：默认不自动跑、不监听；预填了一组公开的昵称 / 抖音号 / 主页，方便直接体验「艾特主人」和「私信认人」 | 新装没有运行配置时会自动用它做默认值；也可以在网页「平台」页逐项改成自己的。换成自己的账号时，不要把别人的账号、Cookie 或私信内容一起提交 |
| `memory-samples.jsonl` | 8 条示例记忆，演示三层记忆的写法与字段 | 只作参考。新装且使用 JSONL 后端时，可复制为 `data/memory/memory.jsonl`；已有 SQLite 记忆库时不要直接合并 |

## 哪些数据在仓库里，哪些不在

**在仓库里**：`data/persona/core-persona.json`（当前人格，方便别人在蛋蛋的基础上改）、`data/state/platform-settings.json`（公开平台开关与表达浓度）、`data/share/**`（脱敏示例）。

**不在仓库里**（仍在 `.gitignore` 里，不要为了分享而提交）：

- `data/browser-profile*/`：登录态、Cookie、浏览器历史
- `data/platform/*`：抖音会话与加密 Cookie
- `data/memory/memory.db`、`memory.db-*`：真实记忆库
- `data/state/douyin-inbox.json`、`douyin-journal.json`、`duty-events.jsonl`：私信、评论、行为原文
- `data/persona/audit.jsonl`：人格改动审计
- `data/state/affect.json`、`decision.json`：心情、精力等私密状态
- `data/stickers/`：大体积表情包
- `data/plugin.log`、`duty/*.log`：运行日志

## 分享前自检

1. 搜索手机号、邮箱、抖音号、主页链接、真实姓名、住址、密钥和 Cookie；
2. 不要复制原始 `memory.db`、收件箱、流水账或浏览器档案；
3. 图片只保留 `assets/` 下登记了许可的图标；`data/templates/` 的模板底图和头像属于本地素材，默认不进仓库，表情包走远程安装，不塞进仓库；
4. 跑 `node --test test/privacy.test.js`，确认隐私红线没被打开。
