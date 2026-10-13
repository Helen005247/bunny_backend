'use strict'

const express = require('express')
const { searchPastImages, parseRecallFilters } = require('../services/images/imageRecallService')
const { getVisionConfig, describeImage } = require('../services/images/visionService')
const {
    MAX_IMAGE_BYTES, MIME_EXT, imageMimeFromBytes, parseSessionId,
    httpError, assertSessionOwned, storeUploadedImage, getSignedImageUrl,
} = require('../services/images/imageService')

function createImagesRouter({ supabase, vision = describeImage }) {
    const router = express.Router()

    // Binary upload: no dependency on multipart libraries; normal JSON chat body stays at 1 MB.
    router.post('/upload', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), async (req, res) => {
        try {
            if (!supabase) throw httpError(503, 'DATABASE_UNAVAILABLE', '数据库未连接')
            const sessionId = parseSessionId(req.query.session_id)
            if (!sessionId) throw httpError(400, 'INVALID_SESSION', '请先打开有效的聊天会话')
            await assertSessionOwned(supabase, req.userId, sessionId)

            const bytes = req.body
            if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
                throw httpError(400, 'INVALID_IMAGE', '请上传 5MB 以内的 JPG、PNG 或 WebP 图片')
            }
            const actualMime = imageMimeFromBytes(bytes)
            const claimedMime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase()
            if (!actualMime || !MIME_EXT[claimedMime] || actualMime !== claimedMime) {
                throw httpError(415, 'UNSUPPORTED_IMAGE', '图片内容与格式不符；只支持 JPG、PNG、WebP')
            }

            // Explicitly fail when vision is unavailable; never pretend the text model saw an image.
            const config = getVisionConfig()
            const summary = await vision({ bytes, mimeType: actualMime, config })
            const image = await storeUploadedImage({
                supabase, userId: req.userId, sessionId,
                bytes, mimeType: actualMime, summary,
            })
            const url = await getSignedImageUrl(supabase, image.storage_path)
            return res.status(201).json({ ok: true, image: {
                id: image.id, summary: image.summary,
                created_at: image.created_at, url,
            } })
        } catch (error) {
            console.error('[images] upload failed:', error?.code || error?.status || 'error')
            return res.status(error.status >= 400 && error.status < 600 ? error.status : 500)
                .json({ ok: false, code: error.code || 'IMAGE_UPLOAD_FAILED',
                    error: error.status ? error.message : '图片理解或保存失败，请稍后再试' })
        }
    })

    // Phase 2 Step 1: authenticated, user-scoped image index across chat sessions.
    // Example: GET /api/images/recall?q=小狗&limit=10
    // No Storage URL or unreviewed historical image is passed to an AI at this step.
    router.get('/recall', async (req, res) => {
        try {
            if (!supabase) throw httpError(503, 'DATABASE_UNAVAILABLE', '数据库未连接')
            const filters = parseRecallFilters(req.query)
            if (filters.sessionId !== null) {
                await assertSessionOwned(supabase, req.userId, filters.sessionId)
            }
            const result = await searchPastImages({ supabase, userId: req.userId, filters: req.query })
            return res.status(200).json({ ok: true, ...result })
        } catch (error) {
            console.error('[images] recall failed:', error?.code || 'database_error')
            // Expose only our own validation/ownership errors, not SQL or storage details.
            const isClientError = typeof error?.code === 'string' &&
                (error.code.startsWith('INVALID_') || error.code === 'SESSION_NOT_FOUND' ||
                    error.code === 'UNAUTHORIZED' || error.code === 'DATABASE_UNAVAILABLE')
            const status = isClientError ? (error.status || 400) : 500
            return res.status(status).json({
                ok: false,
                code: isClientError ? error.code : 'IMAGE_RECALL_FAILED',
                error: isClientError ? error.message : '历史图片检索失败，请稍后重试',
            })
        }
    })

    return router
}

module.exports = createImagesRouter
