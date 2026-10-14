'use strict'

const STATUS = {
    CANDIDATE: 'candidate',
    APPROVED: 'approved',
    ARCHIVED: 'archived',
}

function assertStatus(status) {
    if (!Object.values(STATUS).includes(status)) {
        throw new Error('INVALID_VISUAL_IDENTITY_STATUS')
    }
}

async function getCurrentVisualIdentity({ supabase, agentId = 'star' }) {
    const { data, error } = await supabase
        .from('visual_identity')
        .select('*')
        .eq('agent_id', agentId)
        .eq('status', STATUS.APPROVED)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) throw error
    return data || null
}

async function addCandidate({ supabase, payload }) {
    const row = {
        agent_id: payload.agentId || 'star',
        image_url: payload.imageUrl,
        source_image_id: payload.sourceImageId || null,
        description: payload.description || '',
        version: payload.version || 1,
        status: STATUS.CANDIDATE,
    }

    const { data, error } = await supabase
        .from('visual_identity')
        .insert(row)
        .select('*')
        .single()

    if (error) throw error
    return data
}

async function approveVisualIdentity({ supabase, id }) {
    const { error: archiveError } = await supabase
        .from('visual_identity')
        .update({ status: STATUS.ARCHIVED })
        .eq('status', STATUS.APPROVED)

    if (archiveError) throw archiveError

    const { data, error } = await supabase
        .from('visual_identity')
        .update({
            status: STATUS.APPROVED,
            approved_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select('*')
        .single()

    if (error) throw error
    return data
}

async function getHistory({ supabase, agentId = 'star' }) {
    const { data, error } = await supabase
        .from('visual_identity')
        .select('*')
        .eq('agent_id', agentId)
        .order('version', { ascending: false })

    if (error) throw error
    return data || []
}

module.exports = {
    STATUS,
    assertStatus,
    getCurrentVisualIdentity,
    addCandidate,
    approveVisualIdentity,
    getHistory,
}
