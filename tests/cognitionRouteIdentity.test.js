'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { matchesExpectedUserId } = require('../services/agentIdentity')

const STAR_USER_ID = '00000000-0000-4000-8000-000000000001'
const MOM_USER_ID = '00000000-0000-4000-8000-000000000002'

test('private Cognition endpoint accepts only the configured Star user', () => {
    assert.equal(matchesExpectedUserId(STAR_USER_ID, STAR_USER_ID), true)
    assert.equal(matchesExpectedUserId(MOM_USER_ID, STAR_USER_ID), false)
})

test('private Cognition endpoint rejects invalid or missing IDs', () => {
    assert.equal(matchesExpectedUserId('Mom', STAR_USER_ID), false)
    assert.equal(matchesExpectedUserId(STAR_USER_ID, ''), false)
    assert.equal(matchesExpectedUserId('', STAR_USER_ID), false)
})
