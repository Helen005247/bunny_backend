'use strict'

const DEFAULT_MODEL =
    process.env.GLANCE_SEMANTIC_MODEL ||
    'gpt-5.6-sol'

const MAX_SAMPLE_CHARS = 5500
const MAX_ANALYSES = 24

const LOVE_AND_DEEPSPACE_NAMES = [
    '沈星回',
    '秦彻',
    '黎深',
    '祁煜',
    '夏以昼',
]

function clamp01(value) {
    return Math.max(
        0,
        Math.min(
            1,
            Number(value) || 0
        )
    )
}

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .trim()
}

function stripCodeFence(value) {
    const text =
        cleanText(value)

    if (
        text.startsWith('```') &&
        text.endsWith('```')
    ) {
        return text
            .replace(
                /^```(?:json)?\s*/i,
                ''
            )
            .replace(
                /\s*```$/,
                ''
            )
            .trim()
    }

    return text
}

function parseJsonObject(value) {
    const cleaned =
        stripCodeFence(value)

    try {
        const parsed =
            JSON.parse(cleaned)

        return (
            parsed &&
            typeof parsed ===
                'object' &&
            !Array.isArray(parsed)
        )
            ? parsed
            : null
    } catch (_) {}

    const first =
        cleaned.indexOf('{')

    const last =
        cleaned.lastIndexOf('}')

    if (
        first >= 0 &&
        last > first
    ) {
        try {
            const parsed =
                JSON.parse(
                    cleaned.slice(
                        first,
                        last + 1
                    )
                )

            return (
                parsed &&
                typeof parsed ===
                    'object' &&
                !Array.isArray(parsed)
            )
                ? parsed
                : null
        } catch (_) {}
    }

    return null
}

function uniqueStrings(
    value,
    max = 12
) {
    if (
        !Array.isArray(value)
    ) {
        return []
    }

    const result = []

    for (
        const item
        of value
    ) {
        const text =
            cleanText(item)
                .slice(
                    0,
                    80
                )

        if (
            text &&
            !result.includes(
                text
            )
        ) {
            result.push(text)
        }

        if (
            result.length >=
            max
        ) {
            break
        }
    }

    return result
}

function normalizeAnalysis(
    raw,
    {
        postSessionId,
        post,
        analysisStage = 'full',
    }
) {
    const allowedContentTypes =
        new Set([
            'fanfiction',
            'romance_fan_content',
            'shipping',
            'game_discussion',
            'game_guide',
            'official_game_content',
            'general_discussion',
            'other',
            'unclear',
        ])

    const allowedRelationshipContexts =
        new Set([
            'romantic',
            'flirty',
            'sexual_or_intimate',
            'platonic',
            'non_romantic',
            'ambiguous',
            'none',
        ])

    const allowedTropeSignals =
        new Set([
            'caught_looking_elsewhere',
            'jealousy_reclaim',
            'attention_reclaim',
            'provoking_jealousy',
            'possessive_claim',
            'role_reversal',
            'teasing_control',
            'protective_control',
            'direct_pursuit',
            'other',
        ])

    const tropeSignals =
        uniqueStrings(
            raw?.trope_signals,
            8
        )
            .filter(
                item =>
                    allowedTropeSignals
                        .has(item)
            )

    const contentType =
        allowedContentTypes.has(
            raw?.content_type
        )
            ? raw.content_type
            : 'unclear'

    const relationshipContext =
        allowedRelationshipContexts.has(
            raw?.relationship_context
        )
            ? raw.relationship_context
            : 'ambiguous'

    const namedCharacters =
        uniqueStrings(
            raw?.named_characters
        )

    const ladCharacters =
        uniqueStrings(
            raw?.love_and_deepspace_characters
        )
            .filter(
                name =>
                    LOVE_AND_DEEPSPACE_NAMES
                        .includes(
                            name
                        )
            )

    return {
        post_session_id:
            postSessionId,

        analyzed_at:
            new Date()
                .toISOString(),

        model:
            DEFAULT_MODEL,

        analysis_stage:
            analysisStage,

        content_type:
            contentType,

        relationship_context:
            relationshipContext,

        romantic_context:
            Boolean(
                raw?.romantic_context
            ),

        named_characters:
            namedCharacters,

        love_and_deepspace_characters:
            ladCharacters,

        primary_focus:
            cleanText(
                raw?.primary_focus
            )
                .slice(
                    0,
                    120
                ) ||
            null,

        fandom_or_work:
            cleanText(
                raw?.fandom_or_work
            )
                .slice(
                    0,
                    120
                ) ||
            null,

        is_fictional_character_content:
            Boolean(
                raw?.is_fictional_character_content
            ),

        is_fan_created_content:
            Boolean(
                raw?.is_fan_created_content
            ),

        is_gameplay_or_strategy:
            Boolean(
                raw?.is_gameplay_or_strategy
            ),

        trope_signals:
            tropeSignals,

        interaction_pattern:
            cleanText(
                raw?.interaction_pattern
            )
                .replace(
                    /\s+/g,
                    ' '
                )
                .slice(
                    0,
                    180
                ) ||
            null,

        summary:
            cleanText(
                raw?.summary
            )
                .replace(
                    /\s+/g,
                    ' '
                )
                .slice(
                    0,
                    240
                ) ||
            null,

        confidence:
            Math.round(
                clamp01(
                    raw?.confidence
                ) *
                1000
            ) /
            1000,

        evidence_terms:
            uniqueStrings(
                raw?.evidence_terms,
                10
            ),

        engagement: {
            dwell_seconds:
                Number(
                    post
                        ?.total_dwell_seconds ||
                    0
                ),

            body_seen:
                Boolean(
                    post
                        ?.body_seen
                ),

            comments_seen:
                Boolean(
                    post
                        ?.comments_seen
                ),

            sample_count:
                Number(
                    post
                        ?.sample_count ||
                    0
                ),
        },
    }
}

function buildInput({
    post,
    samples,
    analysisStage = 'full',
}) {
    const joined =
        samples
            .map(
                (
                    sample,
                    index
                ) =>
                    `【采样${index + 1}｜${sample.screen_mode || 'unknown'}】\n${sample.text}`
            )
            .join(
                '\n\n'
            )
            .slice(
                0,
                MAX_SAMPLE_CHARS
            )

    return `你是 Hermit 的“小红书余光内容分类器”。

任务：只根据下面 OCR 文本判断用户正在看的内容是什么。不要替角色说话，不要生成回复，不要做情绪反应。

当前分析阶段：${analysisStage}
- quick：只有一次采样时做快速归类，重点识别内容类型、明确角色与大致互动模式；证据不足就保守输出。
- full：有重复采样/停留证据后做完整归类。

特别注意：
1. 不要因为只出现一个角色名字，就自动判断为恋爱同人。
2. “抽卡、强度、卡池、攻略、数值、配队、技能、活动、版本”等通常属于游戏讨论或攻略。
3. 同人小说、乙女向幻想、暧昧/恋爱片段、CP/代入向内容，才归到 fanfiction / romance_fan_content / shipping。
4. 角色名字只在 OCR 明确出现，或文本有非常强且唯一的指向时才列出；不要凭空猜。
5. 《恋与深空》关注角色包括：沈星回、秦彻、黎深、祁煜、夏以昼。
6. 正文与评论可以属于同一篇帖子。评论里的讨论可以帮助判断原帖内容，但不要把评论者昵称当角色名。
7. 如果证据不足，宁可输出 unclear / ambiguous。
8. 另外识别文本里明显存在的“互动玩法/情境 trope”。只能从下面这些标签里选，证据不够就输出空数组：
   - caught_looking_elsewhere：恋人发现对方在看/关注其他暧昧对象
   - jealousy_reclaim：吃醋后主动把注意力、亲密位置或关系位置拿回来
   - attention_reclaim：不一定明显吃醋，但主动重新占据注意力中心
   - provoking_jealousy：一方故意逗、试探或刺激另一方吃醋
   - possessive_claim：强调“我的位置 / 不让出 / 归属感”的关系表达
   - role_reversal：表面弱势、猎物、无辜，实际反过来掌控节奏
   - teasing_control：用玩笑、游戏、装无辜等方式逐步接管互动节奏
   - protective_control：安全/照顾场景里直接接管行动
   - direct_pursuit：明确主动追近、索取亲密或推进关系
   - other：确有明显互动套路但不属于上面
9. trope 只描述“帖子里的玩法”，绝不能因为用户看了它，就断言用户已经同意现实中被这样对待。
10. 只输出一个 JSON 对象，不要 Markdown，不要解释。

JSON 格式：
{
  "content_type": "fanfiction | romance_fan_content | shipping | game_discussion | game_guide | official_game_content | general_discussion | other | unclear",
  "relationship_context": "romantic | flirty | sexual_or_intimate | platonic | non_romantic | ambiguous | none",
  "romantic_context": true,
  "named_characters": ["文本中明确涉及的虚构角色名"],
  "love_and_deepspace_characters": ["沈星回/秦彻/黎深/祁煜/夏以昼中明确出现者"],
  "primary_focus": "主要在讲什么，简短短语",
  "fandom_or_work": "作品名，无法判断则空字符串",
  "is_fictional_character_content": true,
  "is_fan_created_content": true,
  "is_gameplay_or_strategy": false,
  "trope_signals": ["caught_looking_elsewhere", "jealousy_reclaim"],
  "interaction_pattern": "一句话描述帖子中的互动套路；没有明显套路则空字符串",
  "summary": "一句客观摘要，不超过60字",
  "confidence": 0.0,
  "evidence_terms": ["支持判断的短词/短语"]
}

【帖子状态】
停留秒数：${Number(post?.total_dwell_seconds || 0)}
看过正文：${Boolean(post?.body_seen)}
看过评论：${Boolean(post?.comments_seen)}
采样数：${Number(post?.sample_count || 0)}

【OCR】
${joined}`
}

function createGlanceSemanticService({
    callModel,
} = {}) {

    const analyses =
        new Map()

    const pending =
        new Map()

    function trimCache() {
        while (
            analyses.size >
            MAX_ANALYSES
        ) {
            const oldest =
                analyses
                    .keys()
                    .next()
                    .value

            analyses.delete(
                oldest
            )
        }
    }

    function shouldAnalyze({
        post,
        samples,
        analysisStage = 'full',
    }) {
        if (
            typeof callModel !==
            'function'
        ) {
            return {
                ok: false,
                reason:
                    'model_unavailable',
            }
        }

        if (
            !post
                ?.post_session_id
        ) {
            return {
                ok: false,
                reason:
                    'no_post_session',
            }
        }

        if (
            !Array.isArray(
                samples
            ) ||
            samples.length < 1
        ) {
            return {
                ok: false,
                reason:
                    'not_enough_samples',
            }
        }

        const usefulChars =
            samples
                .reduce(
                    (
                        total,
                        sample
                    ) =>
                        total +
                        cleanText(
                            sample?.text
                        ).length,
                    0
                )

        if (
            analysisStage ===
            'quick'
        ) {
            if (
                usefulChars < 70
            ) {
                return {
                    ok: false,
                    reason:
                        'not_enough_text',
                }
            }

            return {
                ok: true,
                reason:
                    'quick_ready',
            }
        }

        if (
            Number(
                post
                    ?.total_dwell_seconds ||
                0
            ) < 18
        ) {
            return {
                ok: false,
                reason:
                    'not_engaged_enough',
            }
        }

        if (
            samples.length < 2
        ) {
            return {
                ok: false,
                reason:
                    'not_enough_samples',
            }
        }

        if (
            usefulChars < 60
        ) {
            return {
                ok: false,
                reason:
                    'not_enough_text',
            }
        }

        return {
            ok: true,
            reason:
                'full_ready',
        }
    }

    function withCurrentEngagement(
        analysis,
        post
    ) {
        if (!analysis) {
            return analysis
        }

        return {
            ...analysis,

            engagement: {
                dwell_seconds:
                    Number(
                        post
                            ?.total_dwell_seconds ||
                        analysis
                            ?.engagement
                            ?.dwell_seconds ||
                        0
                    ),

                body_seen:
                    Boolean(
                        post
                            ?.body_seen ||
                        analysis
                            ?.engagement
                            ?.body_seen
                    ),

                comments_seen:
                    Boolean(
                        post
                            ?.comments_seen ||
                        analysis
                            ?.engagement
                            ?.comments_seen
                    ),

                sample_count:
                    Math.max(
                        Number(
                            post
                                ?.sample_count ||
                            0
                        ),
                        Number(
                            analysis
                                ?.engagement
                                ?.sample_count ||
                            0
                        )
                    ),
            },
        }
    }

    async function analyze({
        post,
        samples,
        analysisStage = 'full',
    }) {
        const postSessionId =
            post
                ?.post_session_id

        const gate =
            shouldAnalyze({
                post,
                samples,
                analysisStage,
            })

        if (!gate.ok) {
            return {
                status:
                    'skipped',
                reason:
                    gate.reason,
                analysis:
                    null,
            }
        }

        const cached =
            analyses.get(
                postSessionId
            )

        if (
            cached &&
            !(
                cached
                    ?.analysis_stage ===
                    'quick' &&
                analysisStage ===
                    'full'
            )
        ) {
            const refreshed =
                withCurrentEngagement(
                    cached,
                    post
                )

            analyses.set(
                postSessionId,
                refreshed
            )

            return {
                status:
                    'cached',
                reason:
                    'already_analyzed',
                analysis:
                    refreshed,
            }
        }

        const pendingKey =
            `${postSessionId}:${analysisStage}`

        if (
            pending.has(
                pendingKey
            )
        ) {
            return pending.get(
                pendingKey
            )
        }

        const job =
            (async () => {
                try {
                    const response =
                        await callModel(
                            {
                                model:
                                    DEFAULT_MODEL,

                                input:
                                    buildInput({
                                        post,
                                        samples,
                                        analysisStage,
                                    }),
                            },
                            2
                        )

                    const parsed =
                        parseJsonObject(
                            response
                                ?.output_text
                        )

                    if (!parsed) {
                        throw new Error(
                            '语义识别器没有返回有效 JSON'
                        )
                    }

                    const normalized =
                        normalizeAnalysis(
                            parsed,
                            {
                                postSessionId,
                                post,
                                analysisStage,
                            }
                        )

                    analyses.set(
                        postSessionId,
                        normalized
                    )

                    trimCache()

                    return {
                        status:
                            'analyzed',
                        reason:
                            'ok',
                        analysis:
                            normalized,
                    }
                } catch (error) {
                    return {
                        status:
                            'error',
                        reason:
                            String(
                                error
                                    ?.message ||
                                'semantic_analysis_failed'
                            )
                                .slice(
                                    0,
                                    240
                                ),
                        analysis:
                            null,
                    }
                } finally {
                    pending.delete(
                        pendingKey
                    )
                }
            })()

        pending.set(
            pendingKey,
            job
        )

        return job
    }

    function getAnalysis(
        postSessionId
    ) {
        if (
            !postSessionId
        ) {
            return null
        }

        return (
            analyses.get(
                postSessionId
            ) ||
            null
        )
    }

    function getLatest() {
        const all =
            Array.from(
                analyses.values()
            )

        return (
            all[
                all.length - 1
            ] ||
            null
        )
    }

    function list() {
        return Array.from(
            analyses.values()
        )
            .reverse()
    }

    function clear() {
        analyses.clear()
    }

    return {
        shouldAnalyze,
        analyze,
        getAnalysis,
        getLatest,
        list,
        clear,
    }
}

module.exports = {
    createGlanceSemanticService,
}
