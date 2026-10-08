
function normalizeText(value) {
    return typeof value === 'string'
        ? value.trim()
        : ''
}

function buildKeywords(milestone = {}) {
    const values = [
        milestone.title,
        milestone.description,
    ]

    const metadata = milestone.metadata || {}
    values.push(
        metadata.category,
        metadata.relationship_type
    )

    return values
        .map(normalizeText)
        .filter(Boolean)
        .flatMap((text) => text.split(/\s+/))
        .filter((word) => word.length >= 2)
}

async function findRelatedMemories({
    supabase,
    userId,
    milestones = [],
    limit = 3,
}) {
    if (!supabase || !userId || !Array.isArray(milestones)) {
        return []
    }

    const keywords = buildKeywords(milestones[0])

    if (keywords.length === 0) {
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
        .limit(limit)

    if (error || !data) {
        return []
    }

    return data
}

async function buildMilestoneMemoryBridge({
    supabase,
    userId,
    milestones = [],
}) {
    const memories = await findRelatedMemories({
        supabase,
        userId,
        milestones,
    })

    return {
        memories,
        hasRelatedMemories: memories.length > 0,
    }
}

module.exports = {
    buildMilestoneMemoryBridge,
}
