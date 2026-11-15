// ============================================================
// 平台设置存储：data/state/platform-settings.json（公开配置可入库，账号登录态不在这里）
//
// 设计原则（2026-11-11 与用户对齐后）：
// 1. 「登录」不等于「会去刷」——自动刷流有独立总开关，默认关；
// 2. 打开刷流后，点赞/收藏/评论/回复/私信由它自己判断，
//    关注、转发、发作品当前整体关闭，等重新设计；
//    不是每条都做，看当时的心情和内容；这里只提供能力开关，不设审批；
// 3. 单次刷多久、每条停留多久、读不读评论区、每天各能做几次，全部可配；
// 4. 表情包库、形象设计是跨平台共享能力，设置结构按平台无关设计。
// 补丁式更新：PUT 传部分结构，深合并到叶子；未知键一律丢弃——
// 新能力上线时在 DEFAULTS/清洗逻辑里加字段即可，旧文件自动获得默认值。
// ============================================================

import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { fromRoot } from '../utils/paths.js'
import { normalizeMemoryAllow } from './douyin/memory-access.js'
import { normalizeExpressionLevel } from '../voice/expression.js'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function clampNum(v, min, max, fallback) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
function bool(v) { return v === true }
function textList(v, limit = 30) {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean)
    .map((x) => x.slice(0, 40))
    .slice(0, limit)
}

/** 结构即文档：每个键对应一个已规划能力；清洗时未知的键全部丢弃。 */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = src.douyin && typeof src.douyin === 'object' ? src.douyin : {}
  const browse = d.browse && typeof d.browse === 'object' ? d.browse : {}
  const act = d.actions && typeof d.actions === 'object' ? d.actions : {}
  const listen = d.listen && typeof d.listen === 'object' ? d.listen : {}
  const comments = d.comments && typeof d.comments === 'object' ? d.comments : {}
  const owner = d.owner && typeof d.owner === 'object' ? d.owner : {}
  const st = src.stickers && typeof src.stickers === 'object' ? src.stickers : {}
  const ap = src.appearance && typeof src.appearance === 'object' ? src.appearance : {}
  const img = src.image && typeof src.image === 'object' ? src.image : {}
  const imgDoubao = img.doubao && typeof img.doubao === 'object' ? img.doubao : {}
  const ownerName = typeof listen.ownerName === 'string' ? listen.ownerName.trim().slice(0, 40) : ''
  const memoryAllow = normalizeMemoryAllow(listen.memoryAllow, ownerName)

  return {
    douyin: {
      // 只做权限划分：开关打开 = 允许它在抖音上做任何事；关闭 = 什么都不能做。
      // 会不会自己动、多久动一次，统一由「行为与调度」的自主探索策略与频率上限决定。
      browse: {
        enabled: bool(browse.enabled),
        // 活动方式固定围观：共享浏览器里开一个可见标签页，并把窗口带到前面。
        // 静默模式已下线；保留 mode 字段兼容旧配置/旧接口，读取时一律归一为 watch。
        mode: 'watch',
        // 是否允许它打开评论区读评论（理解内容，也是回复的对象）
        readComments: browse.readComments !== false,
        commentLimit: clampNum(browse.commentLimit, 1, 20, 5),
        // 画面理解：默认关；打开后 douyin_look 会截当前视频的帧给多模态宿主
        vision: browse.vision === true,
        // 兴趣关键词：命中的内容它更爱看（软偏好，不硬筛）
        interests: textList(browse.interests),
      },
      // 单项能力位：关掉的就是「不允许」，工具层直接拒绝
      // 聊天表达浓度：只给用户三个大档位，不把概率数字摆到设置页。
      expressionLevel: normalizeExpressionLevel(d.expressionLevel),
      actions: {
        like: act.like !== false,
        // 关注、发作品：整体暂停，等重新设计；无论旧配置或请求传什么，都保持关闭。
        // 分享给主人（转发）：单独开关，默认关；只把当前视频分享给主人，不随机选人。
        follow: false,
        favorite: act.favorite !== false,
        comment: act.comment !== false,
        // 评论时固定 @ 主人，并把文案写成「对主人说的话」；需要 listen.ownerName
        mentionOwner: act.mentionOwner === true,
        forward: act.forward === true,
        reply: act.reply !== false,
        dm: act.dm !== false,
        // 发作品：整体暂停。这个功能要重新设计，当前无论旧配置或请求传什么，都保持关闭；
        // publish.js 先留在仓库里作重做参考，但不接任何生产入口。
        publish: false,
      },
      // 私信：监听打开后所有新私信都自动回，不再排队等主人审批。
      // memoryAllow 是主人之外还能召回长期记忆的人；不设人数上限。
      // ownerName 既用于认主人，也用于评论 @；ownerId 只核对，不参与判断。
      listen: {
        enabled: listen.enabled === true,
        // 兼容旧字段/旧接口：现在固定所有人，不再有 owner/all 范围。
        scope: 'all',
        // 自动回所有新私信；这里保留字段兼容旧快照，没有单独开关。
        autoReply: true,
        ownerName,
        ownerId: typeof listen.ownerId === 'string' ? listen.ownerId.trim().replace(/^抖音号[:：]?\s*/, '').slice(0, 40) : '',
        // 旧版本默认 60 秒；现在实时优先，老配置一并迁到 3 秒
        intervalSec: clampNum(Number(listen.intervalSec) === 60 ? 3 : listen.intervalSec, 3, 600, 3),
        // 主人始终隐式允许；名单里只放主人之外的人，重复项已去掉，人数不设上限
        memoryAllow,
        // 监听浏览器永远在屏幕里，不做「挪到屏幕外」这种多余选项
        showWindow: true,
      },
      // 回评论：和私信监听平行的另一个常驻工作。
      // 开关只负责「开/关自己的标签页」，不决定它去不去刷视频；
      // 评论通知的读取、判断和回复链路随后接上。
      comments: {
        enabled: comments.enabled === true,
      },
      // 主人主页只读能力：喜欢列表是主人私事，只有明确打开才看；只认完整主页链接
      owner: {
        profileUrl: /^https?:\/\/(?:www\.)?douyin\.com\/user\//i.test(String(owner.profileUrl || '').trim())
          ? String(owner.profileUrl).trim().slice(0, 220)
          : '',
        readLikes: owner.readLikes === true,
      },
    },
    // 跨平台共享能力（抖音 / B站 / QQ 共用）
    stickers: { enabled: bool(st.enabled) },
    appearance: { enabled: bool(ap.enabled) },
    // 豆包桌面版做图：开关打开才允许插件操作本机豆包
    image: { doubao: { enabled: bool(imgDoubao.enabled) } },
  }
}

/** 补丁来自本地网页，仍要拒绝原型链相关的键，避免 `__proto__` 改写对象原型。 */
const UNSAFE_PATCH_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** 深合并补丁：只合并普通对象，其余按值覆盖。 */
function deepMerge(base, patch) {
  const out = { ...base }
  for (const k of Object.keys(patch || {})) {
    if (UNSAFE_PATCH_KEYS.has(k)) continue
    const pv = patch[k]
    const bv = out[k]
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv)
    } else if (pv !== undefined) {
      out[k] = pv
    }
  }
  return out
}

export function createPlatformSettings({ config, logger = console } = {}) {
  const filePath = fromRoot(config.platforms.settingsPath)
  // 新装还没有运行配置时，用仓库里的公开示例做默认值：
  // 这样打开「平台」页就能看到一组可直接体验的昵称/抖音号/主页，
  // 用户保存后会写自己的运行文件，不会改坏仓库里的示例。
  const examplePath = fromRoot('data/share/platform-settings.example.json')
  let cached = null

  /** 读取（带缓存）；文件缺失/损坏时回落默认值。 */
  /**
   * 读取：每次都读文件（文件很小，读得也不频繁）。
   * 不能缓存——否则设置页保存后，适配器这边还拿着启动时的旧值，
   * 会出现「开关明明打开了，它还说没打开」。
   */
  function get() {
    const stored = readJsonSafe(filePath, null, (err) => logger.warn?.(`平台设置读取失败，按默认值运行：${err.message}`))
    const fallback = stored ?? readJsonSafe(examplePath, null)
    cached = sanitizeSettings(fallback)
    return cached
  }

  /** 补丁式更新：深合并后整体清洗、原子写盘。写盘失败抛错（调用方回 500，前端提示）。 */
  function patch(partial) {
    const next = sanitizeSettings(deepMerge(get(), partial))
    writeJsonAtomic(filePath, next)
    cached = next
    return next
  }

  return { get, patch, filePath }
}
