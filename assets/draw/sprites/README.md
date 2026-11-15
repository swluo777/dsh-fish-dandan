# 专注创作 · 角色底稿

这些 PNG 是「专注创作」画图页使用的透明角色立绘。运行时由 Canvas 直接读取，不调用任何生图模型。仓库里没有它们，画图页会退回到低精度的几何角色层，无法复现验收样张。

## 来源与许可

- 角色原型：`child-initial-maid`（蛋蛋 / 幼年初始女仆），来自本项目的形象库。
- 立绘以角色三视图与现有 v4 底稿为参考，一次性生成；运行时只做 Canvas 合成，不调用生图模型。
- 新增姿势的生成参考：`ref-front-only.png` 与 `front-calm.png`，只在制作阶段使用，不进运行时。
- 与角色原型同一许可：**CC BY-NC-SA 4.0**。分发、商用、二次创作请遵守该许可，并在衍生作品中保留署名与相同方式共享。

## 手稿化

35 张底稿统一过一道「很轻」的手稿质感处理，只动质感层：

- 轮廓 1–2px 轻微毛化、少量断边；
- 轮廓外侧垫一层很淡的暖纸色，模拟彩铅落在纸上的边；
- 整体叠轻微纸纹和颜色噪点；
- 深色头发/裙装的暗部加很淡的彩铅排线。

不动脸、比例、服装、尾巴；不做全局滤镜，不把角色重新画一遍。强度按「略微手稿化」控制，避免变成另一种画风。

## 文件

| 文件 | 姿态 | 心情 |
|---|---|---|
| `front-happy.png` | 正面站姿 | 开心 |
| `front-sad.png` | 正面站姿 | 难过 |
| `front-sleepy.png` | 正面站姿 | 困 |
| `front-excited.png` | 正面站姿 | 兴奋 |
| `front-blank.png` | 正面站姿 | 发呆 |
| `front-wronged.png` | 正面站姿 | 委屈 |
| `front-proud.png` | 正面站姿 | 得意 |
| `front-calm.png` | 正面站姿 | 平静 |
| `sit-happy.png` | 坐姿 | 开心 |
| `sit-sad.png` | 坐姿 | 难过 |
| `sit-sleepy.png` | 坐姿 | 困 |
| `sit-calm.png` | 坐姿 | 平静 |
| `back-happy.png` | 背影 | 开心 |
| `back-sad.png` | 背影 | 难过 |
| `curl-wronged.png` | 抱膝 | 委屈 |
| `peek-blank.png` | 扒纸边 | 发呆 |
| `sleep-sleepy.png` | 侧躺 | 困 |
| `walk-calm.png` / `walk-happy.png` / `walk-sad.png` | 侧身走路 | 平静 / 开心 / 难过 |
| `chair-calm.png` / `chair-happy.png` / `chair-sad.png` | 坐椅（画面里不画椅子） | 平静 / 开心 / 难过 |
| `floor-calm.png` / `floor-happy.png` / `floor-sad.png` | 盘腿坐 | 平静 / 开心 / 难过 |
| `tummy-calm.png` / `tummy-happy.png` / `tummy-sad.png` | 趴着（横向） | 平静 / 开心 / 难过 |
| `hold-calm.png` / `hold-happy.png` / `hold-sad.png` | 双手捧着 | 平静 / 开心 / 难过 |
| `bike-calm.png` / `bike-happy.png` / `bike-sad.png` | 骑车（已含自行车） | 平静 / 开心 / 难过 |

**注意**

- `chair-*` 故意不画椅子：椅子/桌子由场景层画，才能和桌沿、椅背对齐。
- `bike-*` 已经含一辆自行车：渲染器在 `pose === 'bike'` 时不会再叠一个 `bicycle` 场景物件，避免两辆车。
- 所有图统一透明背景、单角色、无文字/水印/网格；竖向图高度 1200px，横向图看比例裁到同高。

## 维护

- 新增或替换文件后，必须同步更新 `assets/draw/renderer.js` 里的 `SPRITE_FILES`，否则页面不会加载。
- 新增姿势要同时更新 `src/creative/draw/plan.js` 的 `POSES`、姿态候选，以及 `assets/draw/renderer.js` 的 `spriteKeyFor` / `drawSpriteCharacter`。
- 缺图时渲染器会回退到 `drawChibi*` 几何角色层，但那一层只作为兜底，不应作为交付质量。
- 底稿一次性制作脚本与原始生成图不随仓库分发；仓库只保存可复现运行所需的最终 PNG。
