function normalizeMilestoneInput({
    userId,
    agentId = 'star',
    title,
    description = null,
    eventDate,
    metadata = {},
}) {
    const normalizedUserId =
        typeof userId === 'string' ? userId.trim() : userId
    const normalizedAgentId =
        typeof agentId === 'string' ? agentId.trim() : agentId
    const normalizedTitle =
        typeof title === 'string' ? title.trim() : title

    if (!normalizedUserId) {
        throw new Error('创建 milestone 时缺少 user_id')
    }
    if (!normalizedAgentId) {
        throw new Error('创建 milestone 时缺少 agent_id')
    }
    if (!normalizedTitle) {
        throw new Error('创建 milestone 时缺少 title')
    }
    if (!eventDate) {
        throw new Error('创建 milestone 时缺少 event_date')
    }

    const parsedEventDate = new Date(eventDate)
    if (Number.isNaN(parsedEventDate.getTime())) {
        throw new Error('创建 milestone 时 event_date 无效')
    }
    if (
        metadata === null ||
        Array.isArray(metadata) ||
        typeof metadata !== 'object'
    ) {
        throw new Error('创建 milestone 时 metadata 必须是对象')
    }

    return {
        user_id: normalizedUserId,
        agent_id: normalizedAgentId,
        title: normalizedTitle,
        description:
            typeof description === 'string'
                ? description.trim() || null
                : description ?? null,
        event_date: parsedEventDate.toISOString(),
        metadata,
    }
}

async function createMilestone({
    supabase,
    userId,
    agentId = 'star',
    title,
    description = null,
    eventDate,
    metadata = {},
}) {
    if (!supabase) {
        throw new Error('创建 milestone 时缺少 supabase')
    }

    const milestone = normalizeMilestoneInput({
        userId,
        agentId,
        title,
        description,
        eventDate,
        metadata,
    })

    const { data, error } = await supabase
        .from('milestones')
        .insert(milestone)
        .select(
            'id, user_id, agent_id, title, description, event_date, metadata'
        )
        .single()

    if (error) {
        throw error
    }

    return data
}

async function getUpcomingMilestones({
    supabase,
    userId,
    agentId = 'star',
    days = 30,
}) {
    if (!supabase) {
        throw new Error('读取 milestones 时缺少 supabase')
    }
    if (!userId) {
        throw new Error('读取 milestones 时缺少 user_id')
    }

    const now = new Date()
    const future = new Date(now)
    future.setDate(future.getDate() + days)

    const { data, error } = await supabase
        .from('milestones')
        .select(
            'id, user_id, agent_id, title, description, event_date, metadata'
        )
        .eq('user_id', userId)
        .eq('agent_id', agentId)
        .gte('event_date', now.toISOString())
        .lte('event_date', future.toISOString())
        .order('event_date', { ascending: true })

    if (error) {
        throw error
    }

    return data || []
}

module.exports = {
    createMilestone,
    getUpcomingMilestones,
}
