async function generateReaction({
    reactionInput,
    callModelWithRetry,
}) {
    const response =
        await callModelWithRetry(
            {
                model: 'gpt-5.6-sol',
                input: reactionInput,
            },
            2
        )

    const reply =
        typeof response?.output_text === 'string'
            ? response.output_text.trim()
            : ''

    if (!reply) {
        throw new Error(
            'Glance reaction generated empty reply'
        )
    }

    return reply
}

module.exports = {
    generateReaction,
}
