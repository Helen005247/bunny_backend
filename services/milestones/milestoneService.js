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
        .order('event_date', {
            ascending: true,
        })

    if (error) {
        throw error
    }

    return data || []
}

module.exports = {
    getUpcomingMilestones,
}
