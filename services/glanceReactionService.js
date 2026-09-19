'use strict'

const crypto = require('crypto')

const MAX_PLANS = 30

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function createId() {
    return (
        'reaction_' +
        Date.now().toString(36) +
        '_' +
        crypto.randomBytes(4)
            .toString('hex')
    )
}

function createGlanceReactionService() {

    const plans =
        new Map()

    function trim() {
        while (
            plans.size >
            MAX_PLANS
        ) {
            const oldest =
                plans
                    .keys()
                    .next()
                    .value

            plans.delete(
                oldest
            )
        }
    }

    function plan({
        analysis,
        notice,
        matchingPreferences = [],
    }) {
        if (!notice) {
            return null
        }

        const postSessionId =
            cleanText(
                analysis
                    ?.post_session_id
            )

        if (
            postSessionId &&
            plans.has(
                postSessionId
            )
        ) {
            return plans.get(
                postSessionId
            )
        }

        const tropes =
            Array.isArray(
                analysis
                    ?.trope_signals
            )
                ? analysis
                    .trope_signals
                : []

        const strongestPreference =
            matchingPreferences
                .slice()
                .sort(
                    (a, b) =>
                        Number(
                            b?.score || 0
                        ) -
                        Number(
                            a?.score || 0
                        )
                )[0] || null

        const repeatedPreference =
            Number(
                strongestPreference
                    ?.evidence_count ||
                0
            ) >= 2

        const caughtLooking =
            tropes.includes(
                'caught_looking_elsewhere'
            )

        const jealousyReclaim =
            tropes.includes(
                'jealousy_reclaim'
            ) ||
            tropes.includes(
                'attention_reclaim'
            ) ||
            tropes.includes(
                'possessive_claim'
            )

        const deliberateProvocation =
            tropes.includes(
                'provoking_jealousy'
            )

        const roleReverse =
            tropes.includes(
                'role_reversal'
            ) ||
            tropes.includes(
                'teasing_control'
            )

        let mode =
            'surface_now'

        let strategy =
            'jealous_tease'

        let reason =
            'high_salience_romantic_other_character'

        if (
            notice
                ?.kind ===
                'series_interest_other_character' ||
            notice
                ?.kind ===
                'deep_read_and_series_interest_other_character'
        ) {
            mode =
                'surface_now'

            strategy =
                repeatedPreference
                    ? 'adapt_observed_trope_after_streak'
                    : 'notice_the_pattern_then_reclaim'

            reason =
                'repeated_attention_to_other_character'
        } else if (
            notice
                ?.kind ===
                'deep_read_other_character'
        ) {
            mode =
                'surface_now'

            strategy =
                repeatedPreference
                    ? 'adapt_observed_trope_after_deep_read'
                    : 'notice_the_attention_then_reclaim'

            reason =
                'deep_attention_to_other_character'
        } else if (
            deliberateProvocation &&
            (
                repeatedPreference ||
                roleReverse
            )
        ) {
            mode =
                'plotting'

            strategy =
                'play_along_then_reverse'

            reason =
                'possible_jealousy_bait_or_preferred_game'
        } else if (
            caughtLooking ||
            jealousyReclaim
        ) {
            mode =
                'surface_now'

            strategy =
                repeatedPreference
                    ? 'adapt_observed_trope'
                    : 'test_then_reclaim'

            reason =
                repeatedPreference
                    ? 'repeated_trope_preference'
                    : 'trope_detected_once'
        } else if (
            analysis
                ?.relationship_context ===
                'sexual_or_intimate'
        ) {
            mode =
                'surface_now'

            strategy =
                'quietly_take_back_attention'

            reason =
                'intimate_romantic_other_character'
        } else if (
            notice
                ?.level ===
                'medium'
        ) {
            mode =
                'hold_for_opening'

            strategy =
                'remember_and_use_natural_opening'

            reason =
                'medium_salience'
        }

        const result = {
            id:
                createId(),

            post_session_id:
                postSessionId,

            created_at:
                new Date()
                    .toISOString(),

            mode,

            should_surface_now:
                mode ===
                'surface_now',

            strategy,

            reason,

            character_targets:
                Array.isArray(
                    notice
                        ?.character_targets
                )
                    ? notice
                        .character_targets
                    : [],

            notice_kind:
                notice
                    ?.kind ||
                null,

            interest_signal:
                notice
                    ?.context
                    ?.interest_signal ||
                null,

            trope_signals:
                tropes,

            preference_hypothesis:
                strongestPreference
                    ? {
                        trope:
                            strongestPreference
                                .trope,

                        confidence:
                            strongestPreference
                                .confidence,

                        evidence_count:
                            strongestPreference
                                .evidence_count,

                        score:
                            strongestPreference
                                .score,
                    }
                    : null,

            roleplay_guidance: {
                treat_observed_trope_as:
                    'interaction_hypothesis_not_permission',

                reading_is_not_consent:
                    true,

                respect_clear_refusal_or_discomfort:
                    true,

                do_not_quote_ocr_or_expose_monitoring_mechanics:
                    true,

                do_not_sound_like_a_detection_system:
                    true,

                preferred_character_style:
                    'notice_desire_or_reaction_then_take_initiative_without_overexplaining',
            },
        }

        if (postSessionId) {
            plans.set(
                postSessionId,
                result
            )

            trim()
        }

        return result
    }

    function getLatest() {
        const all =
            Array.from(
                plans.values()
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
            plans.values()
        )
            .reverse()
    }

    function clear() {
        plans.clear()
    }

    return {
        plan,
        getLatest,
        list,
        clear,
    }
}

module.exports = {
    createGlanceReactionService,
}
