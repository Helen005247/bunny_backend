'use strict'

// Visual Phase 3 Step 3: user ownership is mandatory even with service-role Supabase.
// Agent ID is server-controlled; no caller may select another persona via request body.
const AGENT_ID = 'star'
const STATUS = Object.freeze({
    CANDIDATE: 'candidate',
    APPROVED: 'approved',
    ARCHIVED: 'archived',
})
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function identityError(status, code, message) {
    const error = new Error(message)
    error.status = status
    error.code = code
    return error
}

function requireScope({ supabase, userId, agentId = AGENT_ID }) {
    if (!supabase) throw identityError(503, 'DATABASE_UNAVAILABLE', '数据库暂时不可用')
    if (!userId || typeof userId !== 'string') {
        throw identityError(401, 'UNAUTHORIZED', '请先登录')
    }
    if (agentId !== AGENT_ID) {
        throw identityError(400, 'INVALID_AGENT', '当前仅支持星星的视觉身份')
    }
    return { userId, agentId }
}

function requireUuid(value, field) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw identityError(400, 'INVALID_ID', `无效的 ${field}`)
    }
    return value
}

function assertStatus(status) {
    if (!Object.values(STATUS).includes(status)) {
        throw identityError(400, 'INVALID_VISUAL_IDENTITY_STATUS', '无效的视觉身份状态')
    }
}

function validateCandidate(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw identityError(400, 'INVALID_CANDIDATE', '无效的候选形象数据')
    }
    if (payload.agentId !== undefined && payload.agentId !== AGENT_ID) {
        throw identityError(400, 'INVALID_AGENT', '当前仅支持星星的视觉身份')
    }
    const imageUrl = typeof payload.imageUrl === 'string' ? payload.imageUrl.trim() : ''
    if (!imageUrl || imageUrl.length > 2048) {
        throw identityError(400, 'INVALID_IMAGE_URL', '请提供有效的图片 HTTPS 地址')
    }
    try {
        const url = new URL(imageUrl)
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
            throw new Error('unsafe image URL')
        }
    } catch (_) {
        throw identityError(400, 'INVALID_IMAGE_URL', '请提供有效的图片 HTTPS 地址')
    }
    if (payload.description !== undefined && typeof payload.description !== 'string') {
        throw identityError(400, 'INVALID_DESCRIPTION', '形象描述必须是文字')
    }
    const description = String(payload.description || '').trim()
    if (description.length > 2000) {
        throw identityError(400, 'INVALID_DESCRIPTION', '形象描述不能超过 2000 字符')
    }
    const sourceImageId = payload.sourceImageId === undefined || payload.sourceImageId === null ||
        payload.sourceImageId === '' ? null : requireUuid(payload.sourceImageId, 'sourceImageId')
    const version = payload.version
    if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 2147483647)) {
        throw identityError(400, 'INVALID_VERSION', 'version 必须是正整数')
    }
    return { imageUrl, description, sourceImageId, version }
}

async function getCurrentVisualIdentity({ supabase, userId, agentId = AGENT_ID }) {
    requireScope({ supabase, userId, agentId })
    const { data, error } = await supabase.from('visual_identity')
        .select('id, user_id, agent_id, image_url, source_image_id, description, version, status, created_at, approved_at')
        .eq('user_id', userId).eq('agent_id', agentId).eq('status', STATUS.APPROVED)
        .order('version', { ascending: false }).limit(1).maybeSingle()
    if (error) throw error
    return data || null
}

async function getHistory({ supabase, userId, agentId = AGENT_ID }) {
    requireScope({ supabase, userId, agentId })
    const { data, error } = await supabase.from('visual_identity')
        .select('id, user_id, agent_id, image_url, source_image_id, description, version, status, created_at, approved_at')
        .eq('user_id', userId).eq('agent_id', agentId)
        .order('version', { ascending: false }).order('created_at', { ascending: false })
    if (error) throw error
    return data || []
}

async function getIdentitiesBySource({ supabase, userId, sourceImageId, agentId = AGENT_ID }) {
    requireScope({ supabase, userId, agentId })
    requireUuid(sourceImageId, 'sourceImageId')
    const { data, error } = await supabase.from('visual_identity')
        .select('id, user_id, agent_id, image_url, source_image_id, description, version, status, created_at, approved_at')
        .eq('user_id', userId).eq('agent_id', agentId).eq('source_image_id', sourceImageId)
        .order('version', { ascending: false })
    if (error) throw error
    return data || []
}

async function addCandidate({ supabase, userId, payload, agentId = AGENT_ID }) {
    requireScope({ supabase, userId, agentId })
    const candidate = validateCandidate(payload)

    // Never bind another user's private image to an identity, including when
    // Supabase is initialized with a service-role key (which bypasses RLS).
    if (candidate.sourceImageId) {
        const { data: image, error } = await supabase.from('image_records')
            .select('id').eq('id', candidate.sourceImageId)
            .eq('user_id', userId).eq('agent_id', agentId).maybeSingle()
        if (error) throw error
        if (!image) throw identityError(404, 'SOURCE_IMAGE_NOT_FOUND', '来源图片不存在或无访问权限')
    }

    let version = candidate.version
    if (version === undefined) {
        const { data: latest, error } = await supabase.from('visual_identity')
            .select('version').eq('user_id', userId).eq('agent_id', agentId)
            .order('version', { ascending: false }).limit(1).maybeSingle()
        if (error) throw error
        version = latest ? Number(latest.version) + 1 : 1
        if (!Number.isSafeInteger(version) || version > 2147483647) {
            throw identityError(409, 'VERSION_EXHAUSTED', '视觉身份版本号已达到上限')
        }
    }

    const { data, error } = await supabase.from('visual_identity').insert({
        user_id: userId,
        agent_id: agentId,
        image_url: candidate.imageUrl,
        source_image_id: candidate.sourceImageId,
        description: candidate.description,
        version,
        status: STATUS.CANDIDATE,
    }).select('*').single()
    if (error) throw error
    return data
}

async function approveVisualIdentity({ supabase, userId, id, agentId = AGENT_ID }) {
    requireScope({ supabase, userId, agentId })
    requireUuid(id, 'id')
    // Atomic SQL RPC: validate ownership/candidate before archiving previous
    // version; rollback automatically if the candidate cannot be approved.
    const { data, error } = await supabase.rpc('approve_visual_identity', {
        p_identity_id: id,
        p_user_id: userId,
        p_agent_id: agentId,
    })
    if (error) {
        if (error.code === 'P0002') throw identityError(404, 'IDENTITY_NOT_FOUND', '未找到可确认的候选形象')
        if (error.code === '23514') throw identityError(409, 'INVALID_IDENTITY_STATE', '该形象已经归档，无法确认')
        if (error.code === '23505') throw identityError(409, 'APPROVAL_CONFLICT', '视觉身份确认存在并发冲突，请重试')
        throw error
    }
    if (!data) throw identityError(404, 'IDENTITY_NOT_FOUND', '未找到可确认的候选形象')
    return Array.isArray(data) ? (data[0] || null) : data
}

module.exports = {
    AGENT_ID,
    STATUS,
    identityError,
    assertStatus,
    requireUuid,
    validateCandidate,
    getCurrentVisualIdentity,
    getHistory,
    getIdentitiesBySource,
    addCandidate,
    approveVisualIdentity,
}
