# 出厂预设

这里放**随仓库分发的拟人化设定**，下一个使用者装上就有。分两类内容：

- 说话方式与脾气：`voice-default.json`（被 `src/persona/schema.js` 读取，`{{owner}}` 会替换成人格里的称呼）；
- 以后可以加更多预设卡（温柔版 / 毒舌版 / 话痨版），命名 `<id>.json`，代码按 id 选用。

## 放什么

- 让角色像人的**规则与台词**：短句、分条、别复述、会烦、会拒绝、难受时先接住；
- 通用、不绑定某一个人的表达：网络用语、句式、口语替换（这些在 `src/voice/corpus.js` 里，也可以搬到 `assets/voice/`）。

## 不放什么

- 私人性格卡：`persona/my-persona.json` 这类个人文件（不进 git）。`data/persona/core-persona.json` 是作者公开的蛋蛋人格，已入库，供别人在此基础上改；
- 别人的真实对话、手机号、邮箱、住址、Cookie 与登录态；
- 别人的人设正文（许可与角色归属都不合适）。

`.gitignore` 里 `persona/*` 会忽略私人文件，但 `persona/presets/**` 已经放行 —— 预设必须入库。
