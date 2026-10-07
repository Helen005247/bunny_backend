function calculateDaysRemaining(eventDate) {
    const now = new Date()
    const target = new Date(eventDate)

    const diff = target.getTime() - now.getTime()

    return Math.max(
        0,
        Math.ceil(diff / (1000 * 60 * 60 * 24))
    )
}

function buildMilestoneContext(milestones = []) {
    if (!Array.isArray(milestones) || milestones.length === 0) {
        return {
            hasUpcomingMilestones: false,
            upcomingMilestones: [],
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
            title: milestone.title,
            description: milestone.description || null,
            eventDate: milestone.event_date,
            daysRemaining: calculateDaysRemaining(
                milestone.event_date
            ),
            category: metadata.category || null,
            importance: metadata.importance || null,
            emotion: metadata.emotion || null,
            relationshipType: metadata.relationship_type || 'other',
        }
    })

    const text = upcomingMilestones
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

            const extra =
                details.length > 0
                    ? ` (${details.join(', ')})`
                    : ''

            return (
                `- ${item.title}: ` +
                `${item.daysRemaining} days remaining` +
                extra
            )
        })
        .join('\n')

    return {
        hasUpcomingMilestones: true,
        upcomingMilestones,
        text:
            'Upcoming meaningful events in the relationship.\n' +
            'Use this information only when it is naturally relevant. ' +
            'Do not mention upcoming events repeatedly unless the conversation calls for it.\n' +
            `${text}`,
    }
}

async function getMilestoneContext({
    milestoneService,
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

    return buildMilestoneContext(milestones)
}

module.exports = {
    buildMilestoneContext,
    getMilestoneContext,
}
