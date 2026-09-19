'use strict'

const express = require('express')
const crypto = require('crypto')

const {
    createGlanceService,
} = require('../services/glanceService')

const {
    createGlanceSemanticService,
} = require('../services/glanceSemanticService')

const {
    createGlanceNoticeService,
} = require('../services/glanceNoticeService')

const {
    createGlancePreferenceService,
} = require('../services/glancePreferenceService')

const {
    createGlanceReactionService,
} = require('../services/glanceReactionService')

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
    callModel = null,
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

    const semanticService =
        createGlanceSemanticService({
            callModel,
        })

    const noticeService =
        createGlanceNoticeService()

    const preferenceService =
        createGlancePreferenceService()

    const reactionService =
        createGlanceReactionService()

    // 公开健康检查：只确认功能是否部署成功，不返回 Secret。
    router.get(
        '/health',
        (req, res) => {
            res
                .status(200)
                .json({
                    ok: true,
                    feature:
                        'hermit-glance-v0.6',
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
                        typeof callModel ===
                        'function',
                    semantic_analysis_enabled:
                        typeof callModel ===
                        'function',
                    notice_engine_enabled:
                        true,
                    notice_storage:
                        'memory-only',
                    preference_hypothesis_enabled:
                        true,
                    reaction_planner_enabled:
                        true,
                    reaction_storage:
                        'memory-only',
                    proactive_message_enabled:
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
                `[glance] xhs ${state.state_transition}`
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


            // v0.4：只在确认用户已在同一篇内容上停留后，
            // 异步做一次语义分类。不会阻塞快捷指令响应。
            const postSessionId =
                result
                    ?.post
                    ?.post_session_id

            if (
                postSessionId &&
                Number(
                    result
                        ?.post
                        ?.total_dwell_seconds ||
                    0
                ) >= 18
            ) {
                const samples =
                    service
                        .getPostSamples(
                            postSessionId
                        )

                semanticService
                    .analyze({
                        post:
                            result.post,
                        samples,
                    })
                    .then(
                        semanticResult => {
                            if (
                                semanticResult
                                    ?.status ===
                                'analyzed'
                            ) {
                                const analysis =
                                    semanticResult
                                        .analysis

                                console.log(
                                    '[glance] semantic:',
                                    {
                                        post_session_id:
                                            analysis
                                                ?.post_session_id,
                                        content_type:
                                            analysis
                                                ?.content_type,
                                        relationship_context:
                                            analysis
                                                ?.relationship_context,
                                        romantic_context:
                                            analysis
                                                ?.romantic_context,
                                        named_characters:
                                            analysis
                                                ?.named_characters,
                                        love_and_deepspace_characters:
                                            analysis
                                                ?.love_and_deepspace_characters,
                                        primary_focus:
                                            analysis
                                                ?.primary_focus,
                                        fandom_or_work:
                                            analysis
                                                ?.fandom_or_work,
                                        trope_signals:
                                            analysis
                                                ?.trope_signals,
                                        interaction_pattern:
                                            analysis
                                                ?.interaction_pattern,
                                        confidence:
                                            analysis
                                                ?.confidence,
                                        dwell_seconds:
                                            analysis
                                                ?.engagement
                                                ?.dwell_seconds,
                                        body_seen:
                                            analysis
                                                ?.engagement
                                                ?.body_seen,
                                        comments_seen:
                                            analysis
                                                ?.engagement
                                                ?.comments_seen,
                                        summary:
                                            analysis
                                                ?.summary,
                                    }
                                )


                                const preferenceResult =
                                    preferenceService
                                        .observe(
                                            analysis
                                        )

                                if (
                                    preferenceResult
                                        ?.updated
                                ) {
                                    const related =
                                        preferenceService
                                            .getForTropes(
                                                analysis
                                                    ?.trope_signals
                                            )

                                    console.log(
                                        '[glance] preference hypothesis:',
                                        related
                                            .map(
                                                item => ({
                                                    trope:
                                                        item
                                                            .trope,
                                                    confidence:
                                                        item
                                                            .confidence,
                                                    evidence_count:
                                                        item
                                                            .evidence_count,
                                                    score:
                                                        item
                                                            .score,
                                                    reading_is_not_consent:
                                                        true,
                                                })
                                            )
                                    )
                                }

                                const noticeResult =
                                    noticeService
                                        .evaluate(
                                            analysis
                                        )

                                if (
                                    noticeResult
                                        ?.created
                                ) {
                                    const notice =
                                        noticeResult
                                            .notice

                                    console.log(
                                        '[glance] notice:',
                                        {
                                            status:
                                                notice
                                                    ?.status,
                                            kind:
                                                notice
                                                    ?.kind,
                                            level:
                                                notice
                                                    ?.level,
                                            salience:
                                                notice
                                                    ?.salience,
                                            character_targets:
                                                notice
                                                    ?.character_targets,
                                            dwell_seconds:
                                                notice
                                                    ?.context
                                                    ?.dwell_seconds,
                                            comments_seen:
                                                notice
                                                    ?.context
                                                    ?.comments_seen,
                                            should_surface_now:
                                                notice
                                                    ?.should_surface_now,
                                        }
                                    )


                                    const matchingPreferences =
                                        preferenceService
                                            .getForTropes(
                                                analysis
                                                    ?.trope_signals
                                            )

                                    const reactionPlan =
                                        reactionService
                                            .plan({
                                                analysis,
                                                notice,
                                                matchingPreferences,
                                            })

                                    console.log(
                                        '[glance] reaction plan:',
                                        {
                                            mode:
                                                reactionPlan
                                                    ?.mode,
                                            should_surface_now:
                                                reactionPlan
                                                    ?.should_surface_now,
                                            strategy:
                                                reactionPlan
                                                    ?.strategy,
                                            reason:
                                                reactionPlan
                                                    ?.reason,
                                            character_targets:
                                                reactionPlan
                                                    ?.character_targets,
                                            trope_signals:
                                                reactionPlan
                                                    ?.trope_signals,
                                            preference_hypothesis:
                                                reactionPlan
                                                    ?.preference_hypothesis,
                                        }
                                    )
                                } else {
                                    console.log(
                                        '[glance] notice decision:',
                                        {
                                            created:
                                                false,
                                            reason:
                                                noticeResult
                                                    ?.reason,
                                        }
                                    )
                                }
                            } else if (
                                semanticResult
                                    ?.status ===
                                'error'
                            ) {
                                console.warn(
                                    '[glance] semantic error:',
                                    semanticResult
                                        ?.reason
                                )
                            }
                        }
                    )
                    .catch(
                        error => {
                            console.warn(
                                '[glance] semantic error:',
                                String(
                                    error
                                        ?.message ||
                                    error
                                )
                            )
                        }
                    )
            }

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
        '/xhs/semantic',
        (req, res) => {
            const postSessionId =
                typeof req.query
                    ?.post_session_id ===
                    'string'
                    ? req.query
                        .post_session_id
                        .trim()
                    : ''

            const analysis =
                postSessionId
                    ? semanticService
                        .getAnalysis(
                            postSessionId
                        )
                    : semanticService
                        .getLatest()

            return res
                .status(200)
                .json({
                    ok: true,
                    analysis,
                })
        }
    )

    router.delete(
        '/xhs/semantic',
        (req, res) => {
            semanticService.clear()

            return res
                .status(200)
                .json({
                    ok: true,
                })
        }
    )

    router.get(
        '/xhs/notices',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    notices:
                        noticeService
                            .list(),
                })
        }
    )

    router.get(
        '/xhs/notices/latest',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    notice:
                        noticeService
                            .getLatest(),
                })
        }
    )

    router.delete(
        '/xhs/notices',
        (req, res) => {
            noticeService.clear()

            return res
                .status(200)
                .json({
                    ok: true,
                })
        }
    )

    router.get(
        '/xhs/preferences',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    hypotheses:
                        preferenceService
                            .list(),
                })
        }
    )

    router.get(
        '/xhs/reactions',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    reactions:
                        reactionService
                            .list(),
                })
        }
    )

    router.get(
        '/xhs/reactions/latest',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    reaction:
                        reactionService
                            .getLatest(),
                })
        }
    )

    router.delete(
        '/xhs/preferences',
        (req, res) => {
            preferenceService.clear()
            reactionService.clear()

            return res
                .status(200)
                .json({
                    ok: true,
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
