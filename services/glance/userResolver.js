async function resolveGlanceUserId(
    configuredUserId = '',
    supabase = null
) {

    const configured =
        String(
            configuredUserId || ''
        ).trim()

    if (configured) {
        return {
            userId:
                configured,
            source:
                'configured',
        }
    }

    if (!supabase) {
        return {
            userId:
                null,
            source:
                'supabase_unavailable',
        }
    }

    const {
        data,
        error,
    } =
        await supabase
            .from('sessions')
            .select('user_id')
            .not(
                'user_id',
                'is',
                null
            )
            .limit(50)

    if (error) {
        throw error
    }

    const ids = [
        ...new Set(
            (data || [])
                .map(
                    item =>
                        item.user_id
                )
                .filter(Boolean)
        ),
    ]

    if (ids.length === 1) {
        return {
            userId:
                ids[0],
            source:
                'single_user_inferred',
        }
    }

    return {
        userId:
            null,
        source:
            ids.length === 0
                ? 'no_users'
                : 'multiple_users',
    }
}

module.exports = {
    resolveGlanceUserId,
}
