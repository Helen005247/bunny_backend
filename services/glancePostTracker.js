'use strict'

const crypto = require('crypto')

const COMMENT_MARKERS = [
    '评论',
    '条评论',
    '留下你的想法',
    '说点什么',
    '回复',
    '作者赞过',
]

const FEED_MARKERS = [
    '推荐',
    '关注',
    '热点',
    '发现',
    '直播',
    '同城',
    '短剧',
    '游戏',
    '穿搭',
]

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .trim()
}

function shortPreview(value, max = 220) {
    const text = cleanText(value)
        .replace(/\s+/g, ' ')

    return text.length <= max
        ? text
        : text.slice(0, max - 1) + '…'
}

function newPostId() {
    return (
        'post_' +
        Date.now().toString(36) +
        '_' +
        crypto.randomBytes(4).toString('hex')
    )
}

function secondsBetween(a, b) {
    const aa = new Date(a).getTime()
    const bb = new Date(b).getTime()

    if (
        Number.isNaN(aa) ||
        Number.isNaN(bb)
    ) {
        return 0
    }

    return Math.max(
        0,
        Math.round(
            (bb - aa) / 1000
        )
    )
}

function countOccurrences(value, needle) {
    if (!needle) return 0

    let count = 0
    let from = 0

    while (true) {
        const index = value.indexOf(
            needle,
            from
        )

        if (index === -1) break

        count += 1
        from =
            index +
            needle.length
    }

    return count
}

function detectScreenMode(text) {
    const value = cleanText(text)

    const uniqueCommentMarkers =
        COMMENT_MARKERS.filter(
            marker =>
                value.includes(marker)
        ).length

    const replyCount =
        countOccurrences(
            value,
            '回复'
        )

    const relativeTimeMatches =
        value.match(
            /\d+\s*(?:秒前|分钟前|小时前|天前|周前|月前)/g
        ) || []

    const commentScore =
        uniqueCommentMarkers +
        Math.min(2, replyCount) +
        Math.min(
            2,
            relativeTimeMatches.length
        )

    if (
        /共\s*\d+\s*条评论/.test(value) ||
        replyCount >= 2 ||
        (
            replyCount >= 1 &&
            relativeTimeMatches.length >= 2
        ) ||
        commentScore >= 4
    ) {
        return 'comments'
    }

    const feedHits =
        FEED_MARKERS.filter(
            marker =>
                value.includes(marker)
        ).length

    if (
        feedHits >= 4
    ) {
        return 'feed'
    }

    if (
        value.length >= 90
    ) {
        return 'post_body'
    }

    return 'unknown'
}

function createEmptyPostState() {
    return {
        post_session_id: null,
        started_at: null,
        last_seen_at: null,
        total_dwell_seconds: 0,
        sample_count: 0,
        body_seen: false,
        comments_seen: false,
        current_screen_mode: 'unknown',
        previous_screen_mode: 'unknown',
        same_post_confidence: 0,
        representative_preview: '',
        last_preview: '',
        last_text: '',
        last_similarity: 0,
        status: 'idle',
    }
}

function createGlancePostTracker() {

    let state =
        createEmptyPostState()

    function reset() {
        state =
            createEmptyPostState()

        return getSummary()
    }

    function startPost({
        text,
        sampleAt,
        screenMode,
        similarity = 0,
    }) {
        state = {
            post_session_id:
                newPostId(),

            started_at:
                sampleAt,

            last_seen_at:
                sampleAt,

            total_dwell_seconds:
                0,

            sample_count:
                1,

            body_seen:
                screenMode ===
                'post_body',

            comments_seen:
                screenMode ===
                'comments',

            current_screen_mode:
                screenMode,

            previous_screen_mode:
                'unknown',

            same_post_confidence:
                0.5,

            representative_preview:
                shortPreview(text),

            last_preview:
                shortPreview(text),

            last_text:
                cleanText(text),

            last_similarity:
                Number(
                    similarity
                ) || 0,

            status:
                'tracking',
        }

        return getSummary()
    }

    function shouldKeepSamePost({
        text,
        reading,
        exactDuplicate,
        screenMode,
        gapSeconds,
    }) {

        if (
            !state.post_session_id
        ) {
            return {
                same: false,
                confidence: 0,
                reason: 'no_previous_post',
            }
        }

        if (exactDuplicate) {
            return {
                same: true,
                confidence: 1,
                reason: 'exact_duplicate',
            }
        }

        const similarity =
            Number(
                reading
                    ?.similarity
            ) || 0

        if (
            similarity >= 0.30
        ) {
            return {
                same: true,
                confidence:
                    Math.min(
                        0.98,
                        0.68 +
                        similarity * 0.30
                    ),
                reason:
                    'text_similarity',
            }
        }

        // 正文 → 评论区：文字可能完全变掉，但仍然明显属于同一篇。
        if (
            screenMode ===
                'comments' &&
            ['post_body', 'comments', 'unknown']
                .includes(
                    state
                        .current_screen_mode
                ) &&
            gapSeconds <= 45
        ) {
            return {
                same: true,
                confidence: 0.88,
                reason:
                    'body_to_comments',
            }
        }

        // 评论区内部继续翻评论。
        if (
            screenMode ===
                'comments' &&
            state
                .current_screen_mode ===
                'comments' &&
            gapSeconds <= 45
        ) {
            return {
                same: true,
                confidence: 0.92,
                reason:
                    'comments_continue',
            }
        }

        // 同一篇正文里轻微滚动，OCR 可能相似度不高。
        // 只在时间间隔很短且双方都不像推荐流时保守续接。
        if (
            gapSeconds <= 30 &&
            screenMode !==
                'feed' &&
            state
                .current_screen_mode !==
                'feed' &&
            (
                reading
                    ?.reading_state ===
                    'likely_same_content' ||
                reading
                    ?.reading_state ===
                    'engaged' ||
                state
                    .current_screen_mode ===
                    'post_body'
            )
        ) {
            return {
                same: true,
                confidence: 0.64,
                reason:
                    'probable_scroll',
            }
        }

        return {
            same: false,
            confidence: 0.15,
            reason:
                screenMode === 'feed'
                    ? 'returned_to_feed'
                    : 'content_changed',
        }
    }

    function record({
        text,
        sampleAt,
        reading,
        exactDuplicate = false,
    }) {

        const screenMode =
            detectScreenMode(
                text
            )

        if (
            !state.post_session_id
        ) {
            return {
                ...startPost({
                    text,
                    sampleAt,
                    screenMode,
                    similarity:
                        reading
                            ?.similarity,
                }),
                transition_reason:
                    'first_post_sample',
            }
        }

        const gapSeconds =
            secondsBetween(
                state
                    .last_seen_at,
                sampleAt
            )

        const decision =
            shouldKeepSamePost({
                text,
                reading,
                exactDuplicate,
                screenMode,
                gapSeconds,
            })

        if (
            !decision.same
        ) {
            const previousPostId =
                state
                    .post_session_id

            const next =
                startPost({
                    text,
                    sampleAt,
                    screenMode,
                    similarity:
                        reading
                            ?.similarity,
                })

            return {
                ...next,
                previous_post_session_id:
                    previousPostId,
                transition_reason:
                    decision.reason,
            }
        }

        // 每次采样最多给 dwell 增加 45 秒。
        // 避免快捷指令/网络长时间卡住后，一次补出几小时。
        const dwellIncrement =
            Math.min(
                45,
                gapSeconds
            )

        const previousMode =
            state
                .current_screen_mode

        state = {
            ...state,

            last_seen_at:
                sampleAt,

            total_dwell_seconds:
                state
                    .total_dwell_seconds +
                dwellIncrement,

            sample_count:
                state
                    .sample_count +
                1,

            body_seen:
                state
                    .body_seen ||
                screenMode ===
                    'post_body',

            comments_seen:
                state
                    .comments_seen ||
                screenMode ===
                    'comments',

            previous_screen_mode:
                previousMode,

            current_screen_mode:
                screenMode,

            same_post_confidence:
                decision
                    .confidence,

            last_preview:
                shortPreview(
                    text
                ),

            last_text:
                cleanText(
                    text
                ),

            last_similarity:
                Number(
                    reading
                        ?.similarity
                ) || 0,

            status:
                state
                    .total_dwell_seconds +
                    dwellIncrement >=
                    18
                    ? 'engaged_post'
                    : 'tracking',
        }

        return {
            ...getSummary(),
            transition_reason:
                decision.reason,
        }
    }

    function getSummary() {
        return {
            post_session_id:
                state
                    .post_session_id,

            started_at:
                state
                    .started_at,

            last_seen_at:
                state
                    .last_seen_at,

            total_dwell_seconds:
                state
                    .total_dwell_seconds,

            sample_count:
                state
                    .sample_count,

            body_seen:
                state
                    .body_seen,

            comments_seen:
                state
                    .comments_seen,

            current_screen_mode:
                state
                    .current_screen_mode,

            previous_screen_mode:
                state
                    .previous_screen_mode,

            same_post_confidence:
                state
                    .same_post_confidence,

            representative_preview:
                state
                    .representative_preview,

            last_preview:
                state
                    .last_preview,

            last_similarity:
                state
                    .last_similarity,

            status:
                state
                    .status,
        }
    }

    return {
        reset,
        record,
        getSummary,
    }
}

module.exports = {
    createGlancePostTracker,
    detectScreenMode,
}
