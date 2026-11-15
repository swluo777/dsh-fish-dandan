# 专注创作 · 角色底稿

这些 PNG 是「专注创作」画图页使用的透明角色立绘。运行时由 Canvas 直接读取，不调用任何生图模型。

## 来源与许可

- 角色原型：`child-initial-maid`（蛋蛋 / 幼年初始女仆），来自本项目的形象库。
- 立绘由角色三视图经手绘化处理后生成，仅保留本项目角色身份特征；生成过程不在运行时执行。
- 与角色原型同一许可：**CC BY-NC-SA 4.0**。分发、商用、二次创作请遵守该许可，并在衍生作品中保留署名与相同方式共享。
- 这些文件是项目资产，不随用户下载的角色包一起安装；删掉本目录会导致画图页回退到旧的几何角色层。

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

## 维护

- 新增或替换文件后，必须同步更新 `assets/draw/renderer.js` 里的 `SPRITE_FILES`，否则页面不会加载。
- 保持透明背景、单角色、无文字/水印/网格；建议高度 1200px 左右，侧躺图宽度 1600px 以内。
- 缺图时渲染器会回退到 `drawChibi*` 几何角色层，但那一层只作为兜底，不应作为交付质量。
