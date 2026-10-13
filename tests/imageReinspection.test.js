'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// This repository's lightweight source ZIP doesn't include node_modules.
// Stub optional dependencies only at require-time; production uses openai + express.
function loadWithStubs(filename) {
    const realLoad = Module._load
    let routes
    try {
        Module._load = function patched(request, parent, isMain) {
            if (request === 'openai') return class FakeOpenAI {}
            if (request === 'express') {
                return {
                    Router() {
                        routes = { get: {}, post: {} }
                        return {
                            get(path, handler) { routes.get[path] = handler },
                            post(path, middleware, handler) {
                                routes.post[path] = handler || middleware
                            },
                        }
                    },
                    raw: () => (_req, _res, next) => next(),
                }
            }
            return realLoad.call(this, request, parent, isMain)
        }
        delete require.cache[require.resolve(filename)]
        const loaded = require(filename)
        return { loaded, routes: () => routes }
    } finally {
        Module._load = realLoad
    }
}

const { loaded: service } = loadWithStubs('../services/images/imageReinspectionService')
const { loaded: createImagesRouter, routes: getRoutes } = loadWithStubs('../routes/images')
const {
    parseReinspectionInput, getStoredImageForReinspection,
    inspectStoredImage, createReinspectionLimiter,
} = service

const USER_A = '00000000-0000-4000-8000-0000000000aa'
const USER_B = '00000000-0000-4000-8000-0000000000bb'
const ID_A = '00000000-0000-4000-8000-000000000001'
const ID_B = '00000000-0000-4000-8000-000000000002'
const JPEG = Buffer.from([255, 216, 255, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])

function imageRow({ id = ID_A, userId = USER_A, kind = 'uploaded', agentId = 'star', messageId = 301, ...overrides } = {}) {
    return {
        id, user_id: userId, agent_id: agentId, kind,
        session_id: 101, message_id: messageId, summary: '一只小狗',
        storage_path: `${userId}/${agentId}/${id}.jpg`, mime_type: 'image/jpeg',
        byte_size: JPEG.length, created_at: '2026-10-12T12:00:00Z',
        ...overrides,
    }
}

function fakeDb({ rows = [imageRow()], imageBytes = JPEG, downloadError = null, selectError = null } = {}) {
    const calls = []
    return {
        calls,
        from(table) {
            assert.equal(table, 'image_records')
            let data = rows.slice()
            return {
                select(columns) { calls.push(['select', columns]); return this },
                eq(field, value) { calls.push(['eq', field, value]); data = data.filter(row => row[field] === value); return this },
                not(field, op, value) {
                    calls.push(['not', field, op, value])
                    assert.equal(op, 'is'); assert.equal(value, null)
                    data = data.filter(row => row[field] != null)
                    return this
                },
                async maybeSingle() { return { data: data[0] || null, error: selectError } },
            }
        },
        storage: {
            from(bucket) {
                calls.push(['bucket', bucket])
                assert.equal(bucket, 'hermit-chat-images')
                return {
                    async download(path) {
                        calls.push(['download', path])
                        return { data: imageBytes === null ? null : new Blob([imageBytes]), error: downloadError }
                    },
                }
            },
        },
    }
}

function fakeResponse() {
    return {
        statusCode: 200,
        status(n) { this.statusCode = n; return this },
        json(payload) { this.body = payload; return this },
    }
}

const config = { apiKey: 'fake-test-key', baseURL: 'https://example.invalid/v1', model: 'gpt-6.1-sol' }

function instantiate(db = fakeDb(), extras = {}) {
    createImagesRouter({
        supabase: db,
        reinspectVision: async () => '原图里小狗脖子上有蓝色项圈',
        visionConfig: () => config,
        ...extras,
    })
    const route = getRoutes().post['/reinspect']
    assert.equal(typeof route, 'function')
    return route
}

async function invoke(route, body, userId = USER_A) {
    const res = fakeResponse()
    await route({ body, userId }, res)
    return res
}

test('parseReinspectionInput accepts valid UUID and question, rejects invalid inputs', () => {
    assert.deepEqual(parseReinspectionInput({ image_id: ID_A, question: ' 小狗项圈什么颜色？ ' }),
        { imageId: ID_A, question: '小狗项圈什么颜色？' })
    assert.ok(parseReinspectionInput({ image_id: ID_A }).question)
    for (const input of [null, [], {}, { image_id: 'bad' }, { image_id: 42 },
        { image_id: ID_A, question: [] }, { image_id: ID_A, question: 'a'.repeat(401) },
        { image_id: ID_A, question: 'hello\u0000world' }]) {
        assert.throws(() => parseReinspectionInput(input), e => e.status === 400)
    }
})

test('authenticated owner can reread an already sent image from private storage', async () => {
    const db = fakeDb()
    const result = await getStoredImageForReinspection({ supabase: db, userId: USER_A, imageId: ID_A })
    assert.deepEqual(result.bytes, JPEG)
    assert.equal(result.mimeType, 'image/jpeg')
    assert.equal(result.record.summary, '一只小狗')
    assert.ok(db.calls.some(c => c[0] === 'eq' && c[1] === 'user_id' && c[2] === USER_A))
    assert.ok(db.calls.some(c => c[0] === 'eq' && c[1] === 'agent_id' && c[2] === 'star'))
    assert.ok(db.calls.some(c => c[0] === 'not' && c[1] === 'message_id'))
    assert.deepEqual(db.calls.find(c => c[0] === 'download'), ['download', `${USER_A}/star/${ID_A}.jpg`])
})

test('cannot re-open other user, other agent, generated image or unsent upload', async () => {
    for (const row of [imageRow({userId: USER_B}), imageRow({agentId: 'other'}),
        imageRow({kind: 'generated'}), imageRow({messageId: null})]) {
        const db = fakeDb({rows: [row]})
        await assert.rejects(
            getStoredImageForReinspection({supabase: db, userId: USER_A, imageId: ID_A}),
            e => e.status === 404 && e.code === 'IMAGE_NOT_FOUND'
        )
        assert.ok(!db.calls.some(c => c[0] === 'download'))
    }
})

test('same owner can access a previously sent image from another session', async () => {
    const db = fakeDb({rows: [imageRow({session_id: 278})]})
    const result = await getStoredImageForReinspection({supabase: db, userId: USER_A, imageId: ID_A})
    assert.equal(result.record.session_id, 278)
})

test('query errors are propagated without exposing SQL details from the route', async () => {
    const db = fakeDb({selectError: new Error('secret SQL details')})
    const res = await invoke(instantiate(db), {image_id: ID_A})
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.code, 'IMAGE_REINSPECTION_FAILED')
    assert.doesNotMatch(JSON.stringify(res.body), /secret SQL/)
})

test('rejects malformed Storage location, declared size and mismatched file content', async () => {
    const variants = [
        { rows: [imageRow({ storage_path: `${USER_B}/star/${ID_A}.jpg` })] },
        { rows: [imageRow({ byte_size: 99999 })] },
        { rows: [imageRow({ mime_type: 'image/png' })] },
        { imageBytes: Buffer.from('hello world!') },
        { imageBytes: Buffer.from([255,216,255,1,2,3,4,5,6,7,8,9]) },
    ]
    for (const variant of variants) {
        const db = fakeDb(variant)
        await assert.rejects(getStoredImageForReinspection({supabase: db, userId: USER_A, imageId: ID_A}),
            e => e.status === 422 && e.code === 'IMAGE_DATA_INVALID')
    }
})

test('Storage read errors are sanitized', async () => {
    const res = await invoke(instantiate(fakeDb({downloadError: new Error('secret storage path')})), {image_id: ID_A})
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.code, 'IMAGE_STORAGE_UNAVAILABLE')
    assert.doesNotMatch(JSON.stringify(res.body), /secret storage/)
})

test('vision reinspection sends original image plus detail question, without saved summary', async () => {
    let seen
    const result = await inspectStoredImage({
        bytes: JPEG, mimeType: 'image/jpeg', question: '项圈是什么颜色？', config,
        createCompletion: async request => {
            seen = request
            return { choices: [{message: {content: '蓝色'}}] }
        },
    })
    assert.equal(result, '蓝色')
    assert.equal(seen.model, 'gpt-6.1-sol')
    assert.match(seen.messages[1].content[0].text, /项圈是什么颜色/)
    assert.match(seen.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/)
    assert.doesNotMatch(JSON.stringify(seen.messages), /一只小狗/)
})

test('empty model response fails cleanly', async () => {
    await assert.rejects(inspectStoredImage({bytes:JPEG,mimeType:'image/jpeg',question:'细节?',config,
        createCompletion:async()=>({choices:[{message:{content:''}}]})}),
    e => e.status === 502 && e.code === 'VISION_EMPTY_RESPONSE')
})

test('per-user limiter blocks overlapping calls and applies cooldown after success only', () => {
    let clock = 100000
    const limiter = createReinspectionLimiter({ now: () => clock, cooldownMs: 20000 })
    const release = limiter.acquire(USER_A)
    assert.throws(() => limiter.acquire(USER_A), e => e.status === 429 && e.code === 'REINSPECTION_BUSY')
    const other = limiter.acquire(USER_B)
    other(false)
    release(true)
    assert.throws(() => limiter.acquire(USER_A), e => e.status === 429 && e.code === 'REINSPECTION_COOLDOWN')
    clock += 20000
    limiter.acquire(USER_A)(false)
    limiter.acquire(USER_A)(false)
})

test('route returns only summary and observation; no private path or image bytes', async () => {
    const db = fakeDb()
    const res = await invoke(instantiate(db), {image_id: ID_A, question: '小狗脖子有什么？'})
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.image.id, ID_A)
    assert.match(res.body.image.observation, /蓝色项圈/)
    assert.equal(res.body.image.summary, '一只小狗')
    assert.equal(Object.hasOwn(res.body.image, 'storage_path'), false)
    assert.equal(Object.hasOwn(res.body.image, 'url'), false)
    assert.equal(Object.hasOwn(res.body.image, 'bytes'), false)
})

test('route rejects malformed ID before DB and does not run vision for unowned images', async () => {
    let calls = 0
    const db = fakeDb({rows:[imageRow({userId: USER_B})]})
    const route = instantiate(db, {reinspectVision: async () => {calls++; return 'SHOULD NOT RUN'}})
    const malformed = await invoke(route, {image_id:'invalid'})
    assert.equal(malformed.statusCode, 400)
    const forbidden = await invoke(route, {image_id: ID_A})
    assert.equal(forbidden.statusCode, 404)
    assert.equal(calls, 0)
    assert.ok(!db.calls.some(c => c[0] === 'download'))
})

test('unknown model errors return sanitized 500; limiter is released on failure', async () => {
    const db = fakeDb()
    const route = instantiate(db, {reinspectVision: async () => { throw new Error('UPSTREAM SECRET') }})
    const res = await invoke(route, {image_id: ID_A})
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.code, 'IMAGE_REINSPECTION_FAILED')
    assert.doesNotMatch(JSON.stringify(res.body), /UPSTREAM SECRET/)
    // Failed calls do not impose a success cooldown.
    const retry = await invoke(route, {image_id: ID_A})
    assert.equal(retry.statusCode, 500)
    assert.notEqual(retry.body.code, 'REINSPECTION_BUSY')
})

test('successful route call enforces cooldown without a second model invocation', async () => {
    let calls = 0
    const route = instantiate(fakeDb(), { reinspectVision: async () => { calls++; return '看见小狗' } })
    assert.equal((await invoke(route, {image_id: ID_A})).statusCode, 200)
    const second = await invoke(route, {image_id: ID_A})
    assert.equal(second.statusCode, 429)
    assert.equal(second.body.code, 'REINSPECTION_COOLDOWN')
    assert.equal(calls, 1)
})

