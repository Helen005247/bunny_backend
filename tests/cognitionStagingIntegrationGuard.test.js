'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateStagingConfig, parseProjectUrl } = require('./cognitionStagingIntegration')

const good = {
    BC_STAGING_CONFIRM: 'I_HAVE_A_SEPARATE_STAGING_PROJECT',
    BC_STAGING_SUPABASE_URL: 'https://test-project.supabase.co',
    BC_PRODUCTION_SUPABASE_URL: 'https://prod-project.supabase.co',
    BC_STAGING_SERVICE_ROLE_KEY: 'TEST_VALUE_NOT_A_REAL_KEY_1234567890',
}
test('rejects accidental run without explicit staging confirmation', () => {
    assert.throws(() => validateStagingConfig({ ...good, BC_STAGING_CONFIRM: undefined }),
        /confirmation missing/)
})
test('rejects staging URL identical to production', () => {
    assert.throws(() => validateStagingConfig({ ...good,
        BC_PRODUCTION_SUPABASE_URL: good.BC_STAGING_SUPABASE_URL }), /SAME project/)
})
test('rejects accidental local, insecure, or non-Supabase endpoints', () => {
    for (const url of ['http://test-project.supabase.co',
        'http://127.0.0.1:54321', 'https://example.com',
        'https://test-project.supabase.co/evil',
        'https://name:password@test-project.supabase.co']) {
        assert.throws(() => validateStagingConfig({ ...good,
            BC_STAGING_SUPABASE_URL: url }))
    }
})
test('rejects missing staging key', () => {
    assert.throws(() => validateStagingConfig({ ...good,
        BC_STAGING_SERVICE_ROLE_KEY: '' }), /KEY is missing/)
})
test('valid staging config only reports non-secret details', () => {
    const config = validateStagingConfig(good)
    assert.equal(config.stagingHost, 'test-project.supabase.co')
    assert.equal(config.stagingUrl, good.BC_STAGING_SUPABASE_URL)
    assert.equal(config.key, good.BC_STAGING_SERVICE_ROLE_KEY)
})
test('public URLs cannot include credentials or fragments', () => {
    assert.throws(() => parseProjectUrl('https://abc.supabase.co/#key', 'test'), /plain/)
})
