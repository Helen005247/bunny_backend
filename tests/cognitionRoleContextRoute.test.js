'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

test('private Cognition route forwards the dynamic character and story context providers', async () => {
    const originalLoad = Module._load
    const oldApiKey = process.env.AI_API_KEY
    const oldBaseUrl = process.env.AI_BASE_URL
    process.env.AI_API_KEY = 'test-key'
    process.env.AI_BASE_URL = 'https://example.org/v1'
    let handler
    const fakeRouter = { post(route, fn) { assert.equal(route, '/tick'); handler = fn; return this } }
    const fakeExpress = { Router: () => fakeRouter }
    try {
        Module._load = function (request, ...args) {
            if (request === 'express') return fakeExpress
            return originalLoad.call(this, request, ...args)
        }
        const routePath = path.resolve(__dirname, '../routes/cognition.js')
        delete require.cache[routePath]
        const createCognitionRouter = require(routePath)
        const characterProvider = async () => ({ context: 'role lore', selected: [] })
        const storyProvider = async () => ({ context: 'story lore', selected: [] })
        let received
        createCognitionRouter({
            supabase: { from() {} },
            callModel: async () => ({}),
            getSettings: async () => ({}),
            getLatestMemory: async () => null,
            getMilestoneContext: async () => null,
            getCharacterLoreContext: characterProvider,
            getStoryLoreContext: storyProvider,
            expectedSecret: 'test-secret-with-at-least-24-characters',
            expectedUserId: '123e4567-e89b-42d3-a456-426614174000',
            runTick: async (options) => { received = options; return { executed: true } },
        })
        const req = {
            get(name) { return name === 'x-cognition-secret' ? 'test-secret-with-at-least-24-characters' : null },
            body: { userId: '123e4567-e89b-42d3-a456-426614174000', triggerType: 'manual' },
        }
        let statusCode = 200
        let payload
        const res = {
            status(code) { statusCode = code; return this },
            json(value) { payload = value; return this },
        }
        await handler(req, res)
        assert.equal(statusCode, 200)
        assert.equal(payload.ok, true)
        assert.equal(received.getCharacterLoreContext, characterProvider)
        assert.equal(received.getStoryLoreContext, storyProvider)
    } finally {
        Module._load = originalLoad
        if (oldApiKey === undefined) delete process.env.AI_API_KEY
        else process.env.AI_API_KEY = oldApiKey
        if (oldBaseUrl === undefined) delete process.env.AI_BASE_URL
        else process.env.AI_BASE_URL = oldBaseUrl
    }
})
