'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    createAgentIdentityResolver,
} = require('../services/agentIdentity')

const STAR_USER_ID = '00000000-0000-4000-8000-000000000001'
const GUAI_USER_ID = '00000000-0000-4000-8000-000000000002'

test('Me resolves to Star storage ID and Xingxing persona key', () => {
    const resolve = createAgentIdentityResolver({
        HERMIT_STAR_USER_ID: STAR_USER_ID,
        HERMIT_GUAI_USER_ID: GUAI_USER_ID,
    })

    assert.deepEqual(resolve(STAR_USER_ID), {
        userId: STAR_USER_ID,
        agentId: 'star',
        agentKey: 'xingxing',
    })
})

test('Mom resolves to Guai storage ID and persona key', () => {
    const resolve = createAgentIdentityResolver({
        HERMIT_STAR_USER_ID: STAR_USER_ID,
        HERMIT_GUAI_USER_ID: GUAI_USER_ID,
    })

    assert.deepEqual(resolve(GUAI_USER_ID), {
        userId: GUAI_USER_ID,
        agentId: 'guai',
        agentKey: 'guai',
    })
})

test('UUID matching is case-insensitive', () => {
    const resolve = createAgentIdentityResolver({
        HERMIT_STAR_USER_ID: STAR_USER_ID.toUpperCase(),
        HERMIT_GUAI_USER_ID: GUAI_USER_ID,
    })

    assert.equal(resolve(STAR_USER_ID.toUpperCase()).agentId, 'star')
})

test('unknown authenticated users fail closed', () => {
    const resolve = createAgentIdentityResolver({
        HERMIT_STAR_USER_ID: STAR_USER_ID,
        HERMIT_GUAI_USER_ID: GUAI_USER_ID,
    })

    assert.throws(
        () => resolve('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        { code: 'AGENT_IDENTITY_NOT_MAPPED' }
    )
})

test('invalid user IDs fail closed', () => {
    const resolve = createAgentIdentityResolver({
        HERMIT_STAR_USER_ID: STAR_USER_ID,
        HERMIT_GUAI_USER_ID: GUAI_USER_ID,
    })

    assert.throws(
        () => resolve('Mom'),
        { code: 'AGENT_IDENTITY_INVALID_USER' }
    )
})

test('missing server-side mapping fails closed', () => {
    const resolve = createAgentIdentityResolver({})

    assert.throws(
        () => resolve(STAR_USER_ID),
        { code: 'AGENT_IDENTITY_CONFIG_INVALID' }
    )
})

test('duplicate Star and Guai IDs are rejected', () => {
    const resolve = createAgentIdentityResolver({
        HERMIT_STAR_USER_ID: STAR_USER_ID,
        HERMIT_GUAI_USER_ID: STAR_USER_ID,
    })

    assert.throws(
        () => resolve(STAR_USER_ID),
        { code: 'AGENT_IDENTITY_CONFIG_COLLISION' }
    )
})
