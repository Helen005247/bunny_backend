'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// Lightweight deployment source ZIP contains no node_modules.
const originalLoad = Module._load
let service
try {
    Module._load = function patched(request, parent, isMain) {
        if (request === 'openai') return class FakeOpenAI {}
        return originalLoad.call(this, request, parent, isMain)
    }
    service = require('../services/images/chatVisualRecallService')
} finally {
    Module._load = originalLoad
}

const { detectVisualRecallIntent, extractTopic, createChatVisualRecallService } = service
const { createReinspectionLimiter } = require('../services/images/imageReinspectionService')
const USER_A = '00000000-0000-4000-8000-0000000000aa'
const USER_B = '00000000-0000-4000-8000-0000000000bb'
const DOG_ID = '00000000-0000-4000-8000-000000000001'
const CAT_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_DOG_ID = '00000000-0000-4000-8000-000000000003'
const JPEG = Buffer.from([255,216,255,0xe0,0,0,0,0,0,0,0,0,1,2,3])

function row(id, userId, summary, sessionId, created = '2026-10-12T06:30:00.000Z', extras = {}) {
    return {
        id, user_id: userId, agent_id: 'star', kind: 'uploaded', session_id: sessionId,
        message_id: 100 + sessionId, summary, mime_type: 'image/jpeg',
        byte_size: JPEG.length, storage_path: `${userId}/star/${id}.jpg`,
        created_at: created, ...extras,
    }
}
function fakeDatabase(rows) {
    const calls = []
    return {
        calls,
        from(table) {
            assert.equal(table, 'image_records')
            let selected = rows.slice()
            return {
                select(cols) { calls.push(['select', cols]); return this },
                eq(field, value) { calls.push(['eq',field,value]); selected = selected.filter(x => x[field] === value); return this },
                not(field, op, value) { calls.push(['not',field,op,value]); assert.equal(op,'is'); assert.equal(value,null); selected = selected.filter(x => x[field] != null); return this },
                ilike(field, pattern) { calls.push(['ilike',field,pattern]); selected = selected.filter(x => String(x[field] || '').toLowerCase().includes(pattern.slice(1,-1).toLowerCase())); return this },
                order(field, { ascending }) { selected.sort((a,b) => (ascending ? 1 : -1) * String(a[field]).localeCompare(String(b[field]))); return this },
                range(start,end) { return Promise.resolve({ data: selected.slice(start,end+1), error: null }) },
                maybeSingle() { return Promise.resolve({ data: selected[0] || null, error: null }) },
            }
        },
        storage: {
            from(bucket) {
                calls.push(['bucket',bucket]); assert.equal(bucket, 'hermit-chat-images')
                return { async download(path) { calls.push(['download',path]); return {data:new Blob([JPEG]),error:null} } }
            },
        },
    }
}
function fixture(rows, overrides = {}) {
    const db = fakeDatabase(rows)
    let inspectionCalls = 0
    const instance = createChatVisualRecallService({
        visionConfig: () => ({ apiKey:'test', model:'vision-test' }),
        inspect: async ({ bytes, mimeType, question }) => {
            inspectionCalls += 1
            assert.deepEqual(bytes, JPEG)
            assert.equal(mimeType, 'image/jpeg')
            assert.ok(question.length <= 400)
            return '原图确认：棕色卷毛小狗坐在车里，脖子有蓝色项圈。'
        },
        ...overrides,
    })
    return { db, instance, getInspectionCalls: () => inspectionCalls }
}

test('conservative intent: triggers historical photo requests but not normal chat or new uploads/voice', () => {
    const yes = [
        '星星，你还记得之前那张小狗照片吗？',
        '可以重新看看那张狗狗照片的细节吗？',
        '把上次给你看的图片再仔细看一下好吗？',
        '我之前发给你的截图还在吗？能找出来吗？',
    ]
    for (const text of yes) assert.ok(detectVisualRecallIntent(text), text)
    const no = [
        '今天天气怎么样？', '我刚才看到一只小狗',
        '我之前喝过咖啡', '请给我画一张小狗图片',
        '这张照片里有一只狗，你觉得可爱吗？',
    ]
    for (const text of no) assert.equal(detectVisualRecallIntent(text), null, text)
    assert.equal(detectVisualRecallIntent(yes[0], {hasCurrentImage:true}), null)
    assert.equal(detectVisualRecallIntent(yes[0], {channel:'voice'}), null)
    assert.equal(detectVisualRecallIntent(yes[0], {channel:'text'}).mode, 'recall')
    assert.equal(detectVisualRecallIntent(yes[1]).mode, 'reinspect')
})

test('topic extraction handles dog/cat synonyms and generic objects', () => {
    assert.equal(extractTopic('你能重新看看那张狗狗照片吗？'), '狗')
    assert.equal(extractTopic('之前那张小猫图片呢？'), '猫')
    assert.equal(extractTopic('我以前发给你的一张咖啡图片，再看一眼'), '咖啡')
    assert.equal(extractTopic('之前给你的那张图片'), '')
})

test('cross-session recall of a specific dog works and verifies user isolation', async () => {
    const f = fixture([
        row(DOG_ID,USER_A,'棕色卷毛小狗坐在车里',501),
        row(CAT_ID,USER_A,'桌子上有一只猫',502),
        row(OTHER_DOG_ID,USER_B,'用户 B 的小狗照片',503),
    ])
    const r = await f.instance.buildContext({
        supabase:f.db,userId:USER_A,message:'星星，能重新看看之前那张狗狗照片的细节吗？',
    })
    assert.equal(r.status,'inspected')
    assert.equal(r.imageId,DOG_ID)
    assert.match(r.context,/蓝色项圈/u)
    assert.match(r.context,/重新查看历史原图/u)
    assert.equal(f.getInspectionCalls(),1)
    assert.ok(f.db.calls.some(x=>x[0]==='eq'&&x[1]==='user_id'&&x[2]===USER_A))
    assert.ok(f.db.calls.some(x=>x[0]==='eq'&&x[1]==='agent_id'&&x[2]==='star'))
    assert.ok(f.db.calls.some(x=>x[0]==='download'&&x[1]===`${USER_A}/star/${DOG_ID}.jpg`))
    assert.equal(r.context.includes('user B'),false)
    assert.equal(r.context.includes('data:image/'),false)
})

test('simple remembering reads only summary, no storage download or vision model', async () => {
    const f = fixture([row(DOG_ID,USER_A,'一只棕色小狗',501)])
    const r = await f.instance.buildContext({
        supabase:f.db,userId:USER_A,message:'你还记得之前那张小狗照片吗？',
    })
    assert.equal(r.status,'summary')
    assert.match(r.context,/尚未重新看原图/)
    assert.equal(f.getInspectionCalls(),0)
    assert.equal(f.db.calls.some(x=>x[0]==='download'),false)
})

test('missing and ambiguous images never pretend to visually verify details', async () => {
    const none = fixture([row(CAT_ID,USER_A,'一只猫',502)])
    const n = await none.instance.buildContext({supabase:none.db,userId:USER_A,
        message:'能重新看看之前那张小狗照片的细节吗？'})
    assert.equal(n.status,'not_found')
    assert.match(n.context,/没有找到/)
    assert.equal(none.getInspectionCalls(),0)
    const many = fixture([
        row(DOG_ID,USER_A,'棕色小狗睡觉',501),
        row(CAT_ID,USER_A,'白色小狗吃饭',502),
    ])
    const a = await many.instance.buildContext({supabase:many.db,userId:USER_A,
        message:'能重新看看之前那张小狗照片的细节吗？'})
    assert.equal(a.status,'ambiguous')
    assert.match(a.context,/询问具体是哪一张/)
    assert.equal(many.getInspectionCalls(),0)
})

test('explicit most-recent photo is allowed and picks the latest owned image', async () => {
    const f = fixture([
        row(DOG_ID,USER_A,'较早的小狗',501,'2026-10-10T01:00:00.000Z'),
        row(CAT_ID,USER_A,'最新的一张小猫',502,'2026-10-13T01:00:00.000Z'),
    ])
    const r = await f.instance.buildContext({supabase:f.db,userId:USER_A,
        message:'你能重新看看最近那张照片的细节吗？'})
    assert.equal(r.status,'inspected')
    assert.equal(r.imageId,CAT_ID)
})

test('unsent uploads, generated images, different agents, other users are not candidates', async () => {
    const f = fixture([
        row(DOG_ID,USER_A,'一只小狗',501,'2026-10-12T00:00:00.000Z',{message_id:null}),
        row(CAT_ID,USER_A,'一只小狗',502,'2026-10-12T01:00:00.000Z',{kind:'generated'}),
        row(OTHER_DOG_ID,USER_B,'一只小狗',503),
    ])
    const r = await f.instance.buildContext({supabase:f.db,userId:USER_A,
        message:'请重新看之前的小狗照片的细节'})
    assert.equal(r.status,'not_found')
    assert.equal(f.getInspectionCalls(),0)
})

test('same message retry reuses cached observations and avoids repeat paid inference', async () => {
    let clock = 100000
    const f = fixture([row(DOG_ID,USER_A,'车里有一只小狗',501)],{
        now: () => clock,
        limiter: createReinspectionLimiter({now: () => clock}),
    })
    const arg = {supabase:f.db,userId:USER_A,message:'重新看看之前那张小狗照片的细节吗？'}
    const first = await f.instance.buildContext(arg)
    assert.equal(first.status,'inspected')
    assert.equal(first.fromCache,undefined)
    const again = await f.instance.buildContext(arg)
    assert.equal(again.fromCache,true)
    assert.equal(f.getInspectionCalls(),1)
    clock += 4 * 60 * 1000
    const afterExpiry = await f.instance.buildContext(arg)
    assert.equal(afterExpiry.status,'inspected')
    assert.equal(f.getInspectionCalls(),2)
})

test('failure releases limiter and can retry, without claiming original was inspected', async () => {
    let count = 0
    let failures = 0
    const f = fixture([row(DOG_ID,USER_A,'小狗',501)], {
        inspect:async () => { count++; if (count===1) {failures++; throw new Error('vision is down')} return '重新确认的细节' },
    })
    const arg = {supabase:f.db,userId:USER_A,message:'重新看看之前那张小狗照片的细节'}
    await assert.rejects(() => f.instance.buildContext(arg),/vision is down/)
    const success = await f.instance.buildContext(arg)
    assert.equal(success.status,'inspected')
    assert.match(success.context,/重新确认的细节/)
    assert.equal(failures,1)
})

test('non-visual chats and current-image uploads do not touch database', async () => {
    const f = fixture([])
    const a = await f.instance.buildContext({supabase:f.db,userId:USER_A,message:'我今天喝了咖啡'})
    const b = await f.instance.buildContext({supabase:f.db,userId:USER_A,
        message:'你还能重看刚才那张图片吗',hasCurrentImage:true})
    assert.equal(a.status,'skipped')
    assert.equal(b.status,'skipped')
    assert.equal(f.db.calls.length,0)
})

test('source integration is restricted to a single chat context hook and shared rate limiter', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8')
    assert.match(source, /const chatVisualRecall = createChatVisualRecallService\(\{ limiter: visualReinspectionLimiter \}\)/)
    assert.match(source, /createImagesRouter\(\{\s*supabase, reinspectionLimiter: visualReinspectionLimiter/)
    assert.match(source, /await chatVisualRecall\.buildContext\(\{/)
    assert.match(source, /if \(historicalImageReplyContext\) \{\s*modelInputSections\.push\(historicalImageReplyContext\)/)
    assert.match(source, /if \(messageChannel === 'text' && !chatImage\)/)
})
