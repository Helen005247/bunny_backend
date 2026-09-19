'use strict'

const express = require('express')
const crypto = require('crypto')

const {
    createGlanceService,
} = require('../services/glanceService')

function safeEqualString(
    left,
    right
) {
    const leftBuffer =
        Buffer.from(
            String(left ?? ''),
            'utf8'
        )

    const rightBuffer =
        Buffer.from(
            String(right ?? ''),
            'utf8'
        )

    if (
        leftBuffer.length !==
        rightBuffer.length
    ) {
        return false
    }

    if (leftBuffer.length === 0) {
        return false
    }

    return crypto.timingSafeEqual(
        leftBuffer,
        rightBuffer
    )
}

function getShortcutKey(req) {
    const customHeader =
        typeof req.headers[
            'x-hermit-glance-key'
        ] === 'string'
            ? req.headers[
                'x-hermit-glance-key'
            ].trim()
            : ''

    if (customHeader) {
        return customHeader
    }

    const authorization =
        typeof req.headers
            .authorization ===
            'string'
            ? req.headers
                .authorization
                .trim()
            : ''

    if (
        authorization
            .toLowerCase()
            .startsWith('bearer ')
    ) {
        return authorization
            .slice(7)
            .trim()
    }

    return ''
}

function createGlanceRouter({
    supabase = null,
} = {}) {

    const router =
        express.Router()

    const shortcutToken =
        String(
            process.env
                .GLANCE_SHORTCUT_TOKEN ||
            ''
        ).trim()

    const ownerId =
        String(
            process.env
                .GLANCE_USER_ID ||
            ''
        ).trim()

    const service =
        createGlanceService({
            ownerId,
        })

    // 公开健康检查：只确认功能是否部署成功，不返回 Secret。
    router.get(
        '/health',
        (req, res) => {
            res
                .status(200)
                .json({
                    ok: true,
                    feature:
                        'hermit-glance-v0.3.1',
                    shortcut_token_configured:
                        Boolean(
                            shortcutToken
                        ),
                    owner_id_configured:
                        Boolean(
                            ownerId
                        ),
                    storage:
                        'memory-only',
                    ai_enabled:
                        false,
                    database_write_enabled:
                        false,
                    supabase_available:
                        Boolean(
                            supabase
                        ),
                })
        }
    )

    // 余光模式接口使用独立快捷指令 Secret。
    router.use(
        (req, res, next) => {
            if (!shortcutToken) {
                return res
                    .status(503)
                    .json({
                        ok: false,
                        code:
                            'GLANCE_NOT_CONFIGURED',
                        error:
                            '余光模式尚未配置 GLANCE_SHORTCUT_TOKEN',
                    })
            }

            const suppliedKey =
                getShortcutKey(req)

            if (
                !safeEqualString(
                    suppliedKey,
                    shortcutToken
                )
            ) {
                return res
                    .status(401)
                    .json({
                        ok: false,
                        code:
                            'GLANCE_UNAUTHORIZED',
                        error:
                            '余光模式鉴权失败',
                    })
            }

            return next()
        }
    )

    // 给 iOS 快捷指令使用的最简单前台状态门控。
    // 返回纯文本 1 / 0，避免 Shortcuts 对 JSON Boolean 的类型判断问题。
    router.get(
        '/xhs/active',
        (req, res) => {
            const state =
                service
                    .getPublicState()

            return res
                .status(200)
                .type('text/plain')
                .send(
                    state.active
                        ? '1'
                        : '0'
                )
        }
    )

    router.get(
        '/xhs/state',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    state:
                        service
                            .getPublicState(),
                })
        }
    )

    router.post(
        '/xhs/state',
        (req, res) => {
            const active =
                req.body?.active

            if (
                typeof active !==
                'boolean'
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,
                        code:
                            'INVALID_ACTIVE',
                        error:
                            'active 必须是 true 或 false',
                    })
            }

            const state =
                service
                    .setXhsActive(
                        active,
                        {
                            trigger:
                                req.body
                                    ?.trigger ||
                                'ios-shortcuts',
                            device:
                                req.body
                                    ?.device ||
                                'iphone',
                        }
                    )

            console.log(
                `[glance] xhs ${active ? 'opened' : 'closed'}`
            )

            return res
                .status(200)
                .json({
                    ok: true,
                    state,
                })
        }
    )

    router.post(
        '/xhs/observe',
        (req, res) => {
            const result =
                service
                    .recordXhsObservation({
                        text:
                            req.body?.text,
                        capturedAt:
                            req.body
                                ?.captured_at,
                        source:
                            req.body
                                ?.source ||
                            'ios-shortcuts',
                    })

            if (!result.accepted) {
                const status =
                    result.reason ===
                    'xhs_inactive'
                        ? 409
                        : 400

                return res
                    .status(status)
                    .json({
                        ok: false,
                        code:
                            result.reason
                                ?.toUpperCase() ||
                            'OBSERVATION_REJECTED',
                        ...result,
                    })
            }
            // v0.2：日志同时显示停留判断。
            console.log(
                '[glance] xhs observation:',
                {
                    duplicate:
                        result.duplicate,
                    char_count:
                        result.observation?.char_count,
                    reading_state:
                        result.reading?.reading_state,
                    dwell_seconds:
                        result.reading?.dwell_seconds,
                    similarity:
                        result.reading?.similarity,
                    repeated_terms:
                        result.reading?.repeated_terms,
                    post_session_id:
                        result.post?.post_session_id,
                    post_status:
                        result.post?.status,
                    post_dwell_seconds:
                        result.post?.total_dwell_seconds,
                    screen_mode:
                        result.post?.current_screen_mode,
                    body_seen:
                        result.post?.body_seen,
                    comments_seen:
                        result.post?.comments_seen,
                    same_post_confidence:
                        result.post?.same_post_confidence,
                    post_transition:
                        result.post?.transition_reason,
                    preview:
                        String(
                            result.observation?.preview || ''
                        ).slice(0, 160),
                }
            )

            return res
                .status(200)
                .json({
                    ok: true,
                    ...result,
                })
        }
    )

    router.get(
        '/xhs/summary',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    state:
                        service
                            .getPublicState(),
                    reading:
                        service
                            .getReadingSummary(),
                })
        }
    )

    router.get(
        '/xhs/post-summary',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    post:
                        service
                            .getPostSummary(),
                })
        }
    )

    router.get(
        '/xhs/recent',
        (req, res) => {
            const includeText =
                String(
                    req.query?.full ||
                    ''
                ) === '1'

            return res
                .status(200)
                .json({
                    ok: true,
                    state:
                        service
                            .getPublicState(),
                    observations:
                        service
                            .getRecentObservations({
                                includeText,
                            }),
                })
        }
    )

    router.delete(
        '/xhs/recent',
        (req, res) => {
            const state =
                service
                    .clearRecent()

            return res
                .status(200)
                .json({
                    ok: true,
                    state,
                })
        }
    )

    return router
}

module.exports =
    createGlanceRouter
