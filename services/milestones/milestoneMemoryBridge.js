function normalizeText(value) {
    return typeof value === 'string'
        ? value.trim()
        : ''
}

function normalizeForMatch(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function clipText(value, maxLength = 360) {
    const text = normalizeText(value)
    if (!text) {
        return ''
    }

    if (text.length <= maxLength) {
        return text
    }

    return `${text.slice(0, maxLength).trim()}…`
}

function getCategoryAliases(category) {
    const aliases = {
        birthday: [
            '生日',
            'birthday',
            '礼物',
            '庆祝',
        ],
        first_meeting: [
            '第一次相遇',
            '第一次见面',
            '第一次聊天',
            '初次相遇',
            '认识',
            '相遇',
        ],
        anniversary: [
            '纪念日',
            '周年',
            'anniversary',
        ],
        speech: [
            '演讲',
            '发言',
            'presentation',
            'speech',
        ],
    }

    return aliases[normalizeText(category).toLowerCase()] || []
}

function buildKeywords(milestone = {}) {
    const metadata =
        milestone.metadata &&
        typeof milestone.metadata === 'object'
            ? milestone.metadata
            : {}

    const explicitKeywords = Array.isArray(metadata.memory_keywords)
        ? metadata.memory_keywords
        : []

    const values = [
        milestone.title,
        milestone.description,
        milestone.category,
        metadata.category,
        ...explicitKeywords,
        ...getCategoryAliases(
            milestone.category || metadata.category
        ),
    ]

    const keywords = []
    const seen = new Set()

    for (const value of values) {
        const text = normalizeText(value)
        if (!text) {
            continue
        }

        const pieces = [
            text,
            ...text.split(/[\s,，。；;、/|]+/),
        ]

        for (const piece of pieces) {
            const normalized = normalizeForMatch(piece)
            if (normalized.length < 2 || seen.has(normalized)) {
                continue
            }

            seen.add(normalized)
            keywords.push({
                raw: piece.trim(),
                normalized,
            })
        }
    }

    return keywords
}

function scoreMemoryForMilestone(memory, milestone) {
    const summary = normalizeForMatch(memory?.summary)
    if (!summary) {
        return 0
    }

    const keywords = buildKeywords(milestone)
    let score = 0

    for (const keyword of keywords) {
        if (!summary.includes(keyword.normalized)) {
            continue
        }

        // Longer phrases are more specific and should count more.
        if (keyword.normalized.length >= 6) {
            score += 4
        } else if (keyword.normalized.length >= 4) {
            score += 3
        } else {
            score += 2
        }
    }

    return score
}

function rankRelatedMemories({
    memories = [],
    milestones = [],
    limit = 3,
}) {
    const ranked = []

    for (const memory of memories) {
        let bestScore = 0
        let relatedMilestoneTitle = null

        for (const milestone of milestones) {
            const score = scoreMemoryForMilestone(
                memory,
                milestone
            )

            if (score > bestScore) {
                bestScore = score
                relatedMilestoneTitle = milestone.title || null
            }
        }

        if (bestScore <= 0) {
            continue
        }

        ranked.push({
            ...memory,
            summary: clipText(memory.summary),
            relevanceScore: bestScore,
            relatedMilestoneTitle,
        })
    }

    return ranked
        .sort((a, b) => {
            if (b.relevanceScore !== a.relevanceScore) {
                return b.relevanceScore - a.relevanceScore
            }

            return new Date(b.timestamp || 0).getTime() -
                new Date(a.timestamp || 0).getTime()
        })
        .slice(0, limit)
}

async function findRelatedMemories({
    supabase,
    userId,
    milestones = [],
    limit = 3,
    candidateLimit = 12,
}) {
    if (
        !supabase ||
        !userId ||
        !Array.isArray(milestones) ||
        milestones.length === 0
    ) {
        return []
    }

    const hasKeywords = milestones.some(
        (milestone) => buildKeywords(milestone).length > 0
    )

    if (!hasKeywords) {
        return []
    }

    const { data, error } = await supabase
        .from('memories')
        .select(
            'id, summary, timestamp, metadata'
        )
        .eq('user_id', userId)
        .eq('session_id', 'global')
        .order('timestamp', {
            ascending: false,
        })
        .limit(candidateLimit)

    // Memory enrichment must never block normal chat.
    if (error || !Array.isArray(data)) {
        return []
    }

    return rankRelatedMemories({
        memories: data,
        milestones,
        limit,
    })
}

async function buildMilestoneMemoryBridge({
    supabase,
    userId,
    milestones = [],
    limit = 3,
}) {
    try {
        const memories = await findRelatedMemories({
            supabase,
            userId,
            milestones,
            limit,
        })

        return {
            memories,
            hasRelatedMemories: memories.length > 0,
        }
    } catch (error) {
        console.error(
            '[milestone-memory-bridge] failed softly:',
            error?.message || error
        )

        return {
            memories: [],
            hasRelatedMemories: false,
        }
    }
}

module.exports = {
    buildMilestoneMemoryBridge,
    buildKeywords,
    rankRelatedMemories,
    scoreMemoryForMilestone,
}
