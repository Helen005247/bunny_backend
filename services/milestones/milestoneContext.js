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

    const upcomingMilestones = milestones.map((milestone) => ({
        title: milestone.title,
        description: milestone.description || null,
        eventDate: milestone.event_date,
        daysRemaining: calculateDaysRemaining(
            milestone.event_date
        ),
    }))

    const text = upcomingMilestones
        .map((item) => {
            return `- ${item.title}: ${item.daysRemaining} days remaining`
        })
        .join('\n')

    return {
        hasUpcomingMilestones: true,
        upcomingMilestones,
        text: `Upcoming important events:\n${text}`,
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
