'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

// The tests use an injected model result; no provider connection or secrets.
const originalLoad = Module._load
Module._load = function (request, parent, main) {
    if (request === 'openai') return class MockOpenAI {}
    return originalLoad.call(this, request, parent, main)
}
const { describeImage, getVisionConfig } = require('../services/images/visionService')
Module._load = originalLoad

const {
    imageMimeFromBytes, parseSessionId, getImageForChat, findImageForMessage,
    assertSessionOwned, storeUploadedImage, bindImageToMessage, getSessionImageMap,
} = require('../services/images/imageService')

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const IMG = '00000000-0000-4000-8000-000000000001'

function fakeSupabase({ failInsert = false } = {}) {
    const rows = {
        sessions: [{ id: 1, user_id: USER_A }, { id: 2, user_id: USER_B }],
        image_records: [{
            id: IMG, user_id: USER_A, agent_id: 'star', session_id: 1,
            message_id: null, kind: 'uploaded', summary: '一只白色猫',
            storage_path: `${USER_A}/star/example.png`,
        }],
    }
    const removed = []
    const uploaded = []
    const signed = []
    const storage = {
        upload: async (path, bytes) => { uploaded.push([path, bytes.length]); return { data: { path }, error: null } },
        remove: async (paths) => { removed.push(...paths); return { data: {}, error: null } },
        createSignedUrl: async (path) => { signed.push(path); return { data: { signedUrl: 'https://example.com/token/' + path }, error: null } },
    }
    function table(name) {
        let conditions = [], action = 'read', changes = null, options = {}
        let limitValue
        function run() {
            if (failInsert && action === 'insert') return { data: null, error: new Error('insert failed') }
            const matches = (item) => conditions.every(([field, op, value]) =>
                op === 'eq' ? String(item[field]) === String(value)
                    : op === 'is' ? item[field] === value
                        : op === 'notIs' ? item[field] !== value : true)
            let matched = (rows[name] || []).filter(matches)
            if (action === 'insert') {
                const row = { ...changes }; rows[name].push(row); matched = [row]
            } else if (action === 'update') {
                matched.forEach((item) => Object.assign(item, changes))
            }
            if (limitValue) matched = matched.slice(0, limitValue)
            if (options.single) return { data: matched[0] || null, error: matched.length ? null : new Error('not found') }
            if (options.maybeSingle) return { data: matched[0] || null, error: null }
            return { data: matched, error: null }
        }
        const builder = {
            select: () => builder,
            eq: (field, val) => { conditions.push([field, 'eq', val]); return builder },
            is: (field, val) => { conditions.push([field, 'is', val]); return builder },
            not: (field, op, val) => { conditions.push([field, 'notIs', val]); return builder },
            order: () => builder,
            limit: (val) => { limitValue = val; return builder },
            maybeSingle: async () => { options.maybeSingle = true; return run() },
            single: async () => { options.single = true; return run() },
            insert: (row) => { action = 'insert'; changes = row; return builder },
            update: (row) => { action = 'update'; changes = row; return builder },
            then: (yes, no) => Promise.resolve(run()).then(yes, no),
        }
        return builder
    }
    return {
        from: table,
        storage: { from: (bucket) => { assert.equal(bucket, 'hermit-chat-images'); return storage } },
        rows, removed, uploaded, signed,
    }
}

async function main() {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const webp = Buffer.from('RIFF1234WEBP')
    assert.equal(imageMimeFromBytes(jpeg), 'image/jpeg')
    assert.equal(imageMimeFromBytes(png), 'image/png')
    assert.equal(imageMimeFromBytes(webp), 'image/webp')
    assert.equal(imageMimeFromBytes(Buffer.from('wrong data 12')), null)
    assert.equal(parseSessionId('1'), 1)
    assert.equal(parseSessionId('2.3'), null)
    assert.equal(parseSessionId('-1'), null)

    const db = fakeSupabase()
    await assertSessionOwned(db, USER_A, 1)
    await assert.rejects(() => assertSessionOwned(db, USER_B, 1), { status: 404 })
    const picture = await getImageForChat({ supabase: db, userId: USER_A, sessionId: 1, imageId: IMG })
    assert.equal(picture.summary, '一只白色猫')
    await assert.rejects(() => getImageForChat({ supabase: db, userId: USER_B, sessionId: 1, imageId: IMG }), { status: 404 })
    await assert.rejects(() => getImageForChat({ supabase: db, userId: USER_A, sessionId: 2, imageId: IMG }), { status: 404 })
    await assert.rejects(() => getImageForChat({ supabase: db, userId: USER_A, sessionId: 1, imageId: 'abc' }), { status: 400 })

    await bindImageToMessage({ supabase: db, userId: USER_A, sessionId: 1, image: picture, messageId: 100 })
    assert.equal((await findImageForMessage({ supabase: db, userId: USER_A, sessionId: 1, messageId: 100 })).id, IMG)
    assert.equal(await findImageForMessage({ supabase: db, userId: USER_B, sessionId: 1, messageId: 100 }), null)
    await assert.rejects(() => getImageForChat({ supabase: db, userId: USER_A, sessionId: 1, imageId: IMG }), { status: 409 })
    const reuse = await getImageForChat({ supabase: db, userId: USER_A, sessionId: 1, imageId: IMG, retryMessageId: 100 })
    await bindImageToMessage({ supabase: db, userId: USER_A, sessionId: 1, image: reuse, messageId: 100 })

    const map = await getSessionImageMap({ supabase: db, userId: USER_A, sessionId: 1 })
    assert.equal(map['100'].id, IMG)
    assert.equal(db.signed.length, 1)
    assert.deepEqual(await getSessionImageMap({ supabase: db, userId: USER_B, sessionId: 2 }), {})

    const saved = await storeUploadedImage({ supabase: db, userId: USER_A, sessionId: 1,
        bytes: png, mimeType: 'image/png', summary: '风景' })
    assert.match(saved.id, /^[0-9a-f-]{36}$/)
    assert.equal(db.uploaded.length, 1)
    assert.equal(db.rows.image_records.length, 2)
    assert.equal(db.removed.length, 0)

    const failingDb = fakeSupabase({ failInsert: true })
    await assert.rejects(() => storeUploadedImage({ supabase: failingDb, userId: USER_A, sessionId: 1,
        bytes: jpeg, mimeType: 'image/jpeg', summary: '测试' }), /insert failed/)
    assert.equal(failingDb.removed.length, 1, 'Storage rolled back on DB insert error')

    assert.throws(() => getVisionConfig({}), /VISION_MODEL/)
    let observedRequest
    const description = await describeImage({ bytes: png, mimeType: 'image/png',
        config: { model: 'mock-vision' },
        createCompletion: async (request) => {
            observedRequest = request
            return { choices: [{ message: { content: '画面中有一只白猫。' } }] }
        } })
    assert.equal(description, '画面中有一只白猫。')
    assert.equal(observedRequest.messages[1].content[1].type, 'image_url')
    assert.match(observedRequest.messages[1].content[1].image_url.url, /^data:image\/png;base64,/)
    await assert.rejects(() => describeImage({ bytes: png, mimeType: 'image/png',
        config: { model: 'mock-vision' },
        createCompletion: async () => ({ choices: [{ message: { content: '' } }] }) }), /没有返回有效/)
    console.log('Visual Phase 1 tests passed: MIME, ownership, binding, retry, history, persistence, rollback, vision')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
