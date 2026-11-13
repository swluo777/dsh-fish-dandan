// 主对话的长期记忆检索工具。
// 不依赖 systemPrompt 里是否成功注入了记忆段：模型可以在任何会话里主动查一次，
// 避免旧会话/新会话没拿到记忆上下文时，凭当前对话历史回答“我没去过”。

function text(value, max = 100) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function tagsOf(record) {
  return Array.isArray(record?.tags) ? record.tags : []
}

function isPrivate(record) {
  return tagsOf(record).includes('隐私')
}

function latestByTag(episodes, tags) {
  return [...episodes]
    .filter((r) => !isPrivate(r) && tags.some((tag) => tagsOf(r).includes(tag)))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null
}

function brief(record) {
  if (!record) return null
  return {
    content: text(record.content, 160),
    createdAt: record.createdAt || null,
    tags: tagsOf(record).slice(0, 8),
    importance: record.importance ?? null,
  }
}

/**
 * 生成一个只读的记忆检索工具描述。
 * @param {object} memory createMemory() 返回的实例
 */
export function createMemorySearchTool(memory) {
  return {
    name: 'fish_memory_search',
    description:
      '查大肥鱼的长期记忆（只读）。用户问「你刚才/之前做了什么」「主人最近喜欢什么」「记不记得…」，' +
      '或涉及抖音值班、主人主页、喜欢列表时，先调用它再回答；不要只凭当前会话说“没去过/不记得”。' +
      'query 填问题里的关键词；不填则返回最近的主人和平台动态。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的主题，例如「主人喜欢列表」「刚才值班」；可留空' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条，默认 6' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const query = String(args?.query || '').trim().slice(0, 200)
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 6))
      const episodes = memory.list({ tier: 'episodic', limit: 200 })
      const ordered = [...episodes].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      const ownerLatest = latestByTag(ordered, ['主人'])
      const platformLatest = latestByTag(ordered, ['抖音', '平台'])
      const hits = query
        ? memory.recall(query, { limit, reinforce: false })
        : ordered.filter((r) => !isPrivate(r)).slice(0, limit)
      const memories = hits
        .filter((r) => !isPrivate(r))
        .map(brief)
      return {
        ok: true,
        query,
        ownerLatest: brief(ownerLatest),
        platformLatest: brief(platformLatest),
        memories,
        hint: '这是长期记忆，不是当前会话。回答过去发生的事时以它为准；没查到就如实说没查到，不要编。',
      }
    },
  }
}
