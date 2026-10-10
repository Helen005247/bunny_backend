const {
    evaluateMilestones,
} = require('./milestoneDecision')

function calculateDaysRemaining(eventDate) {
    const now = new Date()
    const target = new Date(eventDate)

    const diff = target.getTime() - now.getTime()

    return Math.max(
        0,
        Math.ceil(diff / (1000 * 60 * 60 * 24))
    )
}

function getAttentionRank(attention) {
    switch (attention) {
        case 'high':
            return 3
        case 'medium':
            return 2
        case 'low':
        default:
            return 1
    }
}

function selectSurfacedMilestones(milestones = []) {
    const sorted = [...milestones].sort((a, b) => {
        const attentionDiff =
            getAttentionRank(b.decision?.attention) -
            getAttentionRank(a.decision?.attention)

        if (attentionDiff !== 0) {
            return attentionDiff
        }

        const scoreDiff =
            (b.decision?.score || 0) -
            (a.decision?.score || 0)

        if (scoreDiff !== 0) {
            return scoreDiff
        }

        return a.daysRemaining - b.daysRemaining
    })

    const meaningful = sorted.filter(
        (item) =>
            item.decision?.attention === 'high' ||
            item.decision?.attention === 'medium'
    )

    if (meaningful.length > 0) {
        return meaningful.slice(0, 5)
    }

    return sorted.slice(0, 1)
}

function buildMilestoneContext(milestones = []) {
    if (!Array.isArray(milestones) || milestones.length === 0) {
        return {
            hasUpcomingMilestones: false,
            upcomingMilestones: [],
            surfacedMilestones: [],
            text: '',
        }
    }

    const upcomingMilestones = milestones.map((milestone) => {
        const metadata =
            milestone.metadata &&
            typeof milestone.metadata === 'object'
                ? milestone.metadata
                : {}

        return {
            id: milestone.id || null,
            title: milestone.title,
            description: milestone.description || null,
            eventDate: milestone.event_date,
            daysRemaining: calculateDaysRemaining(
                milestone.event_date
            ),
            category: metadata.category || null,
            importance: metadata.importance || null,
            emotion: metadata.emotion || null,
            relationshipType:
                metadata.relationship_type || 'other',
            metadata,
        }
    })

    const evaluatedMilestones =
        evaluateMilestones(upcomingMilestones)

    const surfacedMilestones =
        selectSurfacedMilestones(evaluatedMilestones)

    const relationshipDescriptions = {
        shared:
            'This is a shared experience between the user and Star.',
        user_related:
            'This is directly related to the user.',
        self:
            'This is related to Star himself.',
        other:
            'This is related to other people or events.',
    }

    const text = surfacedMilestones
        .map((item) => {
            const details = []

            if (item.category) {
                details.push(
                    `category: ${item.category}`
                )
            }

            if (item.importance) {
                details.push(
                    `importance: ${item.importance}`
                )
            }

            if (item.emotion) {
                details.push(
                    `emotion: ${item.emotion}`
                )
            }

            if (item.relationshipType) {
                details.push(
                    `relationship: ${item.relationshipType}`
                )
            }

            if (item.decision?.attention) {
                details.push(
                    `attention: ${item.decision.attention}`
                )
            }

            const relationshipNote =
                relationshipDescriptions[item.relationshipType]
                    ? ` ${relationshipDescriptions[item.relationshipType]}`
                    : ''

            const extra =
                details.length > 0
                    ? ` (${details.join(', ')})`
                    : ''

            return (
                `- ${item.title}: ` +
                `${item.daysRemaining} days remaining` +
                extra +
                relationshipNote
            )
        })
        .join('\n')

    return {
        hasUpcomingMilestones: surfacedMilestones.length > 0,
        upcomingMilestones: evaluatedMilestones,
        surfacedMilestones,
        text:
            'Upcoming meaningful events in the relationship.\n' +
            'Shared experiences and events related to the user carry the highest relationship priority, ' +
            'followed by Star-related events, then other events. ' +
            'Attention level indicates how much awareness the event deserves now; it is not an instruction to mention it. ' +
            'Use this information only when naturally relevant, and do not repeatedly remind the user about the same event.\n' +
            `${text}`,
    }
}

function appendRelatedMemoriesToContext(
    context,
    memories = []
) {
    if (!context || !Array.isArray(memories) || memories.length === 0) {
        return context
    }

    const memoryLines = memories
        .map((memory) => {
            const summary =
                typeof memory.summary === 'string'
                    ? memory.summary.trim()
                    : ''

            if (!summary) {
                return null
            }

            const relation = memory.relatedMilestoneTitle
                ? ` (related to: ${memory.relatedMilestoneTitle})`
                : ''

            return `- ${summary}${relation}`
        })
        .filter(Boolean)
        .join('\n')

    if (!memoryLines) {
        return context
    }

    context.text +=
        '\n\nRelated relationship memories:\n' +
        'These are background memories connected to the upcoming events. ' +
        'Use them only when they genuinely help express continuity or meaning; do not quote or repeat them mechanically.\n' +
        memoryLines

    return context
}

async function getMilestoneContext({
    milestoneService,
    milestoneMemoryBridge,
    supabase,
    userId,
    agentId = 'star',
    days = 30,
}) {
    if (!milestoneService ||
        typeof milestoneService.getUpcomingMilestones !== 'function') {
        throw new Error(
            '生成 milestone context 时缺少 milestoneService'
        )
    }

    const milestones =
        await milestoneService.getUpcomingMilestones({
            supabase,
            userId,
            agentId,
            days,
        })

    const context = buildMilestoneContext(milestones)

    if (
        !context.hasUpcomingMilestones ||
        !milestoneMemoryBridge ||
        typeof milestoneMemoryBridge.buildMilestoneMemoryBridge !== 'function'
    ) {
        return context
    }

    const bridge =
        await milestoneMemoryBridge.buildMilestoneMemoryBridge({
            supabase,
            userId,
            milestones: context.surfacedMilestones,
            limit: 3,
        })

    context.relatedMemories = bridge.memories

    if (bridge.hasRelatedMemories) {
        appendRelatedMemoriesToContext(
            context,
            bridge.memories
        )
    }

    return context
}

module.exports = {
    appendRelatedMemoriesToContext,
    buildMilestoneContext,
    getMilestoneContext,
    selectSurfacedMilestones,
}
