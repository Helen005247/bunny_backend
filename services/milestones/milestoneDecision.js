function getRelationshipWeight(relationshipType) {
    switch (relationshipType) {
        case 'shared':
        case 'user_related':
            return 2
        case 'self':
            return 1
        case 'other':
        default:
            return 0
    }
}

function getTimeWeight(daysRemaining) {
    if (daysRemaining <= 7) {
        return 3
    }

    if (daysRemaining <= 30) {
        return 2
    }

    return 1
}

function getImportanceWeight(importance) {
    switch (importance) {
        case 'high':
            return 2
        case 'medium':
            return 1
        default:
            return 0
    }
}

function decideMilestoneAttention(milestone = {}) {
    const relationshipType =
        milestone.relationshipType ||
        milestone.relationship_type ||
        'other'

    const score =
        getRelationshipWeight(relationshipType) +
        getTimeWeight(
            Number.isFinite(milestone.daysRemaining)
                ? milestone.daysRemaining
                : 9999
        ) +
        getImportanceWeight(milestone.importance)

    let attention = 'low'

    if (score >= 6) {
        attention = 'high'
    } else if (score >= 3) {
        attention = 'medium'
    }

    return {
        attention,
        score,
        reason: {
            relationshipType,
            daysRemaining: milestone.daysRemaining ?? null,
            importance: milestone.importance || null,
        },
    }
}

function evaluateMilestones(milestones = []) {
    if (!Array.isArray(milestones)) {
        return []
    }

    return milestones.map((milestone) => ({
        ...milestone,
        decision: decideMilestoneAttention(milestone),
    }))
}

module.exports = {
    decideMilestoneAttention,
    evaluateMilestones,
}
