'use strict'

const { randomUUID } = require('node:crypto')

const BUCKET = 'hermit-chat-images'
// Cache signed URLs for 45m so 5-second message polling does not re-sign every image.
const signedUrlCache = new Map()
const SIGNED_CACHE_MS = 45 * 60 * 1000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
}

function imageMimeFromBytes(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    return null
}

function parseSessionId(id) {
    const number = Number(id)
    return Number.isSafeInteger(number) && number > 0 ? number : null
}

function httpError(status, code, message) {
    const error = new Error(message)
    error.status = status
    error.code = code
    return error
}

async function assertSessionOwned(supabase, userId, sessionId) {
    const { data, error } = await supabase.from('sessions')
        .select('id').eq('id', sessionId).eq('user_id', userId).maybeSingle()
    if (error) throw error
    if (!data) throw httpError(404, 'SESSION_NOT_FOUND', '会话不存在或无访问权限')
    return data
}

async function storeUploadedImage({ supabase, userId, sessionId, bytes, mimeType, summary, agentId = 'star' }) {
    const id = randomUUID()
    const path = `${userId}/${agentId}/${id}.${MIME_EXT[mimeType]}`
    const { error: storageError } = await supabase.storage.from(BUCKET)
        .upload(path, bytes, { contentType: mimeType, cacheControl: '3600', upsert: false })
    if (storageError) throw storageError

    try {
        const { data, error } = await supabase.from('image_records').insert({
            id,
            user_id: userId,
            agent_id: agentId,
            session_id: sessionId,
            kind: 'uploaded',
            storage_path: path,
            mime_type: mimeType,
            byte_size: bytes.length,
            summary,
            metadata: {},
        }).select('id, summary, created_at, storage_path').single()
        if (error) throw error
        return data
    } catch (error) {
        try { await supabase.storage.from(BUCKET).remove([path]) } catch (cleanupError) {
            console.warn('[images] storage rollback failed', cleanupError?.message)
        }
        throw error
    }
}

async function getImageForChat({ supabase, userId, sessionId, imageId, retryMessageId = null }) {
    if (!UUID_RE.test(String(imageId || ''))) {
        throw httpError(400, 'INVALID_IMAGE_ID', '无效的图片 ID')
    }
    const { data, error } = await supabase.from('image_records')
        .select('id, summary, message_id').eq('id', imageId)
        .eq('user_id', userId).eq('session_id', sessionId).eq('agent_id', 'star')
        .eq('kind', 'uploaded').maybeSingle()
    if (error) throw error
    if (!data) throw httpError(404, 'IMAGE_NOT_FOUND', '找不到这张图片，或它不属于当前会话')
    if (data.message_id !== null && data.message_id !== undefined &&
        String(data.message_id) !== String(retryMessageId || '')) {
        throw httpError(409, 'IMAGE_ALREADY_SENT', '这张图片已经发送过，请重新选择图片')
    }
    return data
}

async function findImageForMessage({ supabase, userId, sessionId, messageId }) {
    const { data, error } = await supabase.from('image_records')
        .select('id, summary, message_id').eq('user_id', userId)
        .eq('session_id', sessionId).eq('message_id', messageId).maybeSingle()
    if (error) throw error
    return data || null
}

async function bindImageToMessage({ supabase, userId, sessionId, image, messageId }) {
    if (!image || String(image.message_id) === String(messageId)) return
    const { data, error } = await supabase.from('image_records')
        .update({ message_id: messageId })
        .eq('id', image.id).eq('user_id', userId).eq('session_id', sessionId)
        .is('message_id', null).select('id').maybeSingle()
    if (error) throw error
    if (!data) throw httpError(409, 'IMAGE_BIND_CONFLICT', '图片关联已发生变化，请重新发送')
}

async function getSignedImageUrl(supabase, path) {
    const cached = signedUrlCache.get(path)
    if (cached && cached.expiresAt > Date.now()) return cached.url
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600)
    if (error || !data?.signedUrl) {
        console.warn('[images] image signing failed:', error?.message)
        return null
    }
    if (signedUrlCache.size >= 500) {
        for (const [key, entry] of signedUrlCache) {
            if (entry.expiresAt <= Date.now()) signedUrlCache.delete(key)
        }
        if (signedUrlCache.size >= 500) signedUrlCache.delete(signedUrlCache.keys().next().value)
    }
    signedUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + SIGNED_CACHE_MS })
    return data.signedUrl
}

async function getSessionImageMap({ supabase, userId, sessionId }) {
    const { data, error } = await supabase.from('image_records')
        .select('id, message_id, summary, storage_path').eq('user_id', userId)
        .eq('session_id', sessionId).eq('agent_id', 'star')
        .not('message_id', 'is', null)
        .order('created_at', { ascending: false }).limit(150)
    if (error) throw error
    const entries = await Promise.all((data || []).map(async (item) => {
        const url = await getSignedImageUrl(supabase, item.storage_path)
        if (!url) return null
        return [String(item.message_id), { id: item.id, url, summary: item.summary }]
    }))
    return Object.fromEntries(entries.filter(Boolean))
}

module.exports = {
    BUCKET, MAX_IMAGE_BYTES, UUID_RE, MIME_EXT,
    imageMimeFromBytes, parseSessionId, httpError, assertSessionOwned,
    storeUploadedImage, getImageForChat, findImageForMessage,
    bindImageToMessage, getSessionImageMap, getSignedImageUrl,
}
