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

const {
    createGlanceInterestService,
} = require('../services/glanceInterestService')

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
    emitReaction = null,
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

    const interestService =
        createGlanceInterestService()

    // 公开健康检查：只确认功能是否部署成功，不返回 Secret。
    router.get(
        '/health',
        (req, res) => {
            res
                .status(200)
                .json({
                    ok: true,
                    feature:
                        'hermit-glance-v0.8.1',
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
                    deep_read_detection_enabled:
                        true,
                    interest_streak_detection_enabled:
                        true,
                    quick_semantic_enabled:
                        true,
                    interest_storage:
                        'memory-only',
                    interest_thresholds:
                        interestService
                            .getConfig(),
                    live_reaction_enabled:
                        String(
                            process.env
                                .GLANCE_LIVE_REACTION ||
                            ''
                        )
                            .trim()
                            .toLowerCase() ===
                        'true',
                    live_reaction_handler_ready:
                        typeof emitReaction ===
                        'function',
                    proactive_message_enabled:
                        String(
                            process.env
                                .GLANCE_LIVE_REACTION ||
                            ''
                        )
                            .trim()
                            .toLowerCase() ===
                        'true',
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


            // v0.8：
            // 1) 长文/稳定停留：full semantic
            // 2) 短篇系列：如果首屏已经明确出现关注角色，允许 quick semantic
            // 3) 已有语义结果时，每次新采样都会刷新 engagement，
            //    因而能够在后续达到 deep_read 阈值时再触发 interest signal。
            const postSessionId =
                result
                    ?.post
                    ?.post_session_id

            const processAnalysis =
                analysis => {
                    if (!analysis) {
                        return
                    }

                    console.log(
                        '[glance] semantic:',
                        {
                            post_session_id:
                                analysis
                                    ?.post_session_id,
                            analysis_stage:
                                analysis
                                    ?.analysis_stage,
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
                            sample_count:
                                analysis
                                    ?.engagement
                                    ?.sample_count,
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

                    const interestResult =
                        interestService
                            .observeAnalysis(
                                analysis
                            )

                    if (
                        interestResult
                            ?.updated
                    ) {
                        console.log(
                            '[glance] interest:',
                            {
                                reason:
                                    interestResult
                                        ?.reason,
                                signals:
                                    interestResult
                                        ?.signals
                                        ?.map(
                                            signal => ({
                                                triggered:
                                                    signal
                                                        ?.triggered,
                                                kind:
                                                    signal
                                                        ?.kind,
                                                target:
                                                    signal
                                                        ?.target,
                                                self_related:
                                                    signal
                                                        ?.self_related,
                                                level:
                                                    signal
                                                        ?.level,
                                                salience:
                                                    signal
                                                        ?.salience,
                                                distinct_posts:
                                                    signal
                                                        ?.distinct_posts,
                                                cumulative_dwell_seconds:
                                                    signal
                                                        ?.cumulative_dwell_seconds,
                                                current_post_dwell_seconds:
                                                    signal
                                                        ?.current_post_dwell_seconds,
                                            })
                                        ),
                            }
                        )
                    }

                    const interestSignal =
                        interestResult
                            ?.strongest_signal ||
                        null

                    const noticeResult =
                        noticeService
                            .evaluate(
                                analysis,
                                {
                                    interestSignal,
                                }
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
                                interest_signal:
                                    notice
                                        ?.context
                                        ?.interest_signal,
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
                                notice_kind:
                                    reactionPlan
                                        ?.notice_kind,
                                interest_signal:
                                    reactionPlan
                                        ?.interest_signal,
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

                        const liveEnabled =
                            String(
                                process.env
                                    .GLANCE_LIVE_REACTION ||
                                ''
                            )
                                .trim()
                                .toLowerCase() ===
                            'true'

                        if (
                            liveEnabled &&
                            reactionPlan
                                ?.should_surface_now &&
                            typeof emitReaction ===
                            'function'
                        ) {
                            emitReaction({
                                ownerId,
                                analysis,
                                notice,
                                reactionPlan,
                            })
                                .then(
                                    liveResult => {
                                        console.log(
                                            '[glance] live reaction:',
                                            {
                                                sent:
                                                    Boolean(
                                                        liveResult
                                                            ?.sent
                                                    ),
                                                reason:
                                                    liveResult
                                                        ?.reason ||
                                                    null,
                                                session_id:
                                                    liveResult
                                                        ?.session_id ||
                                                    null,
                                                message_id:
                                                    liveResult
                                                        ?.assistant_message_id ||
                                                    null,
                                                push_sent:
                                                    Number(
                                                        liveResult
                                                            ?.push_sent ||
                                                        0
                                                    ),
                                            }
                                        )
                                    }
                                )
                                .catch(
                                    error => {
                                        console.warn(
                                            '[glance] live reaction error:',
                                            String(
                                                error
                                                    ?.message ||
                                                error
                                            )
                                        )
                                    }
                                )
                        }
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
                }

            if (postSessionId) {
                const samples =
                    service
                        .getPostSamples(
                            postSessionId
                        )

                const dwell =
                    Number(
                        result
                            ?.post
                            ?.total_dwell_seconds ||
                        0
                    )

                const fullReady =
                    dwell >= 18 &&
                    Array.isArray(samples) &&
                    samples.length >= 2

                const quickReady =
                    !fullReady &&
                    interestService
                        .shouldQuickAnalyzeText(
                            req.body?.text
                        )

                const existingAnalysis =
                    semanticService
                        .getAnalysis(
                            postSessionId
                        )

                if (
                    existingAnalysis &&
                    !(
                        existingAnalysis
                            ?.analysis_stage ===
                            'quick' &&
                        fullReady
                    )
                ) {
                    const refreshed = {
                        ...existingAnalysis,

                        engagement: {
                            dwell_seconds:
                                Number(
                                    result
                                        ?.post
                                        ?.total_dwell_seconds ||
                                    existingAnalysis
                                        ?.engagement
                                        ?.dwell_seconds ||
                                    0
                                ),

                            body_seen:
                                Boolean(
                                    result
                                        ?.post
                                        ?.body_seen ||
                                    existingAnalysis
                                        ?.engagement
                                        ?.body_seen
                                ),

                            comments_seen:
                                Boolean(
                                    result
                                        ?.post
                                        ?.comments_seen ||
                                    existingAnalysis
                                        ?.engagement
                                        ?.comments_seen
                                ),

                            sample_count:
                                Math.max(
                                    Number(
                                        result
                                            ?.post
                                            ?.sample_count ||
                                        0
                                    ),
                                    Number(
                                        existingAnalysis
                                            ?.engagement
                                            ?.sample_count ||
                                        0
                                    )
                                ),
                        },
                    }

                    processAnalysis(
                        refreshed
                    )
                }

                if (
                    fullReady ||
                    (
                        quickReady &&
                        !existingAnalysis
                    )
                ) {
                    semanticService
                        .analyze({
                            post:
                                result.post,
                            samples,
                            analysisStage:
                                fullReady
                                    ? 'full'
                                    : 'quick',
                        })
                        .then(
                            semanticResult => {
                                if (
                                    semanticResult
                                        ?.status ===
                                        'analyzed'
                                ) {
                                    processAnalysis(
                                        semanticResult
                                            .analysis
                                    )
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
        '/xhs/interests',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    thresholds:
                        interestService
                            .getConfig(),
                    latest_signals:
                        interestService
                            .getLatestSignals(),
                    events:
                        interestService
                            .listEvents(),
                })
        }
    )

    router.delete(
        '/xhs/interests',
        (req, res) => {
            interestService.clear()

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
