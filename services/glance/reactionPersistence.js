async function saveReactionMessage({
    supabase,
    userId,
    sessionId,
    content,
}) {
    const {
        data,
        error,
    } = await supabase
        .from('messages')
        .insert([
            {
                user_id: userId,
                session_id: sessionId,
                role: 'assistant',
                content,
                visible: true,
                reasoning_content: 'glance_reaction',
            },
        ])
        .select(
            'id, session_id, role, content, created_at, visible, reasoning_content'
        )
        .single()

    if (error) {
        throw error
    }

    return data
}

module.exports = {
    saveReactionMessage,
}
