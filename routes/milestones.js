const express = require('express')
const {
    getUpcomingMilestones,
} = require('../services/milestones/milestoneService')

const DEFAULT_AGENT_ID = 'star'
const DEFAULT_DAYS = 30
const MAX_DAYS = 3650

function normalizeAgentId(value) {
    if (value === undefined || value === null) {
        return DEFAULT_AGENT_ID
    }

    if (typeof value !== 'string') {
        return null
    }

    const normalized = value.trim()

    if (!normalized || normalized.length > 100) {
        return null
    }

    return normalized
}

function normalizeDays(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_DAYS
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
        return null
    }

    const normalized =
        typeof value === 'string'
            ? value.trim()
            : value

    if (normalized === '') {
        return DEFAULT_DAYS
    }

    const days = Number(normalized)

    if (
        !Number.isInteger(days) ||
        days < 1 ||
        days > MAX_DAYS
    ) {
        return null
    }

    return days
}

function createMilestonesRouter({
    supabase,
    getUpcoming = getUpcomingMilestones,
} = {}) {
    if (typeof getUpcoming !== 'function') {
        throw new Error(
            '创建 milestones router 时缺少 getUpcomingMilestones'
        )
    }

    const router = express.Router()

    // 健康检查：确认 milestones router 已被 server.js 正确挂载。
    // GET /api/milestones/health
    router.get(
        '/health',
        (req, res) => {
            return res
                .status(200)
                .json({
                    ok: true,
                    service: 'milestones',
                })
        }
    )

    // 临时验证入口：读取当前登录用户自己的 upcoming milestones。
    // GET /api/milestones/debug/upcoming?agentId=star&days=30
    //
    // user_id 永远取自 requireAuth 写入的 req.userId，
    // 不允许客户端通过 query/path 指定其他用户。
    router.get(
        '/debug/upcoming',
        async (
            req,
            res
        ) => {
            try {
                if (!supabase) {
                    return res
                        .status(500)
                        .json({
                            ok: false,
                            error:
                                'Supabase 客户端没有初始化',
                        })
                }

                if (!req.userId) {
                    return res
                        .status(401)
                        .json({
                            ok: false,
                            error:
                                '缺少已验证的用户身份',
                        })
                }

                const agentId =
                    normalizeAgentId(
                        req.query?.agentId
                    )

                if (!agentId) {
                    return res
                        .status(400)
                        .json({
                            ok: false,
                            error:
                                'agentId 无效',
                        })
                }

                const days =
                    normalizeDays(
                        req.query?.days
                    )

                if (!days) {
                    return res
                        .status(400)
                        .json({
                            ok: false,
                            error:
                                `days 必须是 1-${MAX_DAYS} 的整数`,
                        })
                }

                const milestones =
                    await getUpcoming({
                        supabase,
                        userId:
                            req.userId,
                        agentId,
                        days,
                    })

                return res
                    .status(200)
                    .json({
                        ok: true,
                        agentId,
                        days,
                        count:
                            milestones.length,
                        milestones,
                    })

            } catch (error) {
                console.error(
                    '读取 milestones debug 数据失败：',
                    error
                )

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            '读取 milestones 失败',
                        detail:
                            error?.message ||
                            String(error),
                    })
            }
        }
    )

    return router
}

module.exports = createMilestonesRouter
module.exports.normalizeAgentId = normalizeAgentId
module.exports.normalizeDays = normalizeDays
