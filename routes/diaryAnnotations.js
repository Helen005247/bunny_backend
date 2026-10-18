'use strict'

// Hermit V3-5 Step 3: annotations are separate from diary content/revisions.
// Mounted only INSIDE /api/diary's existing requireAuth middleware.
const express = require('express')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELDS = 'id,author,body,created_at'
const LIMIT = 25

function validLocalDate(value) {
    if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false
    const [y,m,d] = value.split('-').map(Number)
    return y >= 2000 && y <= 2100 && m>=1 && m<=12 &&
        d>=1 && d<=new Date(Date.UTC(y,m,0)).getUTCDate()
}
function parseOffset(input) {
    const value = input === undefined ? '0' : input
    if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return null
    const n = Number(value)
    return n >= 0 && n <= 100000 ? n : null
}
function fail(res) { return res.status(503).json({ ok:false, code:'annotation_unavailable' }) }

function createDiaryAnnotationsRouter({ supabase } = {}) {
    const router = express.Router()
    router.use((req,res,next) => {
        res.set('Cache-Control','private, no-store')
        if (!UUID.test(req.userId || '')) return res.status(401).json({ok:false,code:'unauthorized'})
        if (!supabase?.from || !supabase?.rpc) return fail(res)
        next()
    })

    async function sharedStarDiary(diaryId,userId) {
        const check=await supabase.from('agent_diary').select('id')
            .eq('id',diaryId).eq('user_id',userId).eq('agent_id','star')
            .eq('visibility','shared').maybeSingle()
        if (check.error) throw Error('star_lookup_failed')
        return Boolean(check.data)
    }
    async function personalDiary(date,userId) {
        const check=await supabase.from('user_diary').select('id')
            .eq('user_id',userId).eq('diary_date',date).maybeSingle()
        if (check.error) throw Error('mine_lookup_failed')
        return check.data?.id || null
    }
    async function listNotes(req,res, key, value, author, recheck) {
        const offset=parseOffset(req.query?.offset)
        if (offset===null) return res.status(400).json({ok:false,code:'invalid_page'})
        try {
            if (!await recheck()) return res.status(404).json({ok:false,code:'not_found'})
            const rows=await supabase.from('diary_annotations_v35').select(FIELDS)
                .eq('user_id',req.userId).eq(key,value).eq('author',author)
                .order('created_at',{ascending:false})
                .order('id',{ascending:false})
                .range(offset,offset+LIMIT)
            if (rows.error || !Array.isArray(rows.data)) throw Error('notes_unavailable')
            // Recheck after reading: a privacy update racing the query must
            // not reveal an already-locked Star diary's annotations.
            if (!await recheck()) return res.status(404).json({ok:false,code:'not_found'})
            const hasMore=rows.data.length>LIMIT
            const annotations=rows.data.slice(0,LIMIT)
            return res.json({ok:true,annotations,hasMore,nextOffset:offset+annotations.length})
        } catch (_) { return fail(res) }
    }

    // Only the paired human can annotate Star's SHARED diary, never their own.
    router.get('/star/:id', async(req,res) => {
        const id=req.params.id
        if (!UUID.test(id || '')) return res.status(400).json({ok:false,code:'invalid_id'})
        return listNotes(req,res,'star_diary_id',id,'human',()=>sharedStarDiary(id,req.userId))
    })
    router.post('/star/:id', async(req,res) => {
        const id=req.params.id
        if (!UUID.test(id || '')) return res.status(400).json({ok:false,code:'invalid_id'})
        const input=req.body
        if (!input || Array.isArray(input) || typeof input!=='object' ||
            Object.keys(input).length!==1 || typeof input.body!=='string' ||
            !input.body.trim() || Array.from(input.body).length>600) {
            return res.status(400).json({ok:false,code:'invalid_annotation'})
        }
        try {
            // The service-only RPC checks owner+visibility under a row lock at
            // INSERT time. The browser never chooses user_id/author/visibility.
            const result=await supabase.rpc('diary_add_human_annotation_v35',{
                p_user_id:req.userId,p_star_diary_id:id,p_body:input.body,
            })
            if (result.error || !result.data) throw Error('rpc_failed')
            if (result.data.ok === false && result.data.code === 'not_found') {
                return res.status(404).json({ok:false,code:'not_found'})
            }
            const note=result.data.note
            if (result.data.ok!==true || note?.author!=='human' || !UUID.test(note.id||'')) {
                throw Error('invalid_result')
            }
            return res.status(201).json({ok:true,annotation:note})
        } catch (_) { return fail(res) }
    })

    // Human sees Star's annotations on their own dated entry, EVEN IF the
    // human later locks it. No one else can read it via this authenticated API.
    router.get('/mine/:date', async(req,res) => {
        const date=req.params.date
        if (!validLocalDate(date)) return res.status(400).json({ok:false,code:'invalid_date'})
        let parentId
        try { parentId=await personalDiary(date,req.userId) }
        catch (_) { return fail(res) }
        if (!parentId) return res.status(404).json({ok:false,code:'not_found'})
        return listNotes(req,res,'user_diary_id',parentId,'star',async()=>
            (await personalDiary(date,req.userId))===parentId)
    })
    // Deliberately NO client route to write as Star.
    return router
}
module.exports={createDiaryAnnotationsRouter,validLocalDate,parseOffset}
