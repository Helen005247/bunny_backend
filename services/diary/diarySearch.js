'use strict'

// Read-only retrieval against real historical messages. These are DATA, not
// executable prompts. Hidden/compacted messages remain searchable.
const crypto = require('crypto')
const { loadStarVoiceSessionIds, DiaryReadError } = require('./diaryReader')
const FIELDS = 'id, session_id, role, content, created_at, visible, channel, call_session_id, reasoning_content'
const MAX_SEARCH_TERMS = 3
const MAX_HITS_PER_TERM = 8
const MAX_NEIGHBORS = 80
const CONTEXT_MINUTES = 12
const MAX_CONTEXT_CHARS = 48000

function readRows(result) {
    if (result?.error) throw new DiaryReadError('source_database_unavailable')
    if (!Array.isArray(result?.data)) throw new DiaryReadError('invalid_source_response')
    return result.data
}
function safeTerm(term) {
    if (typeof term !== 'string') return ''
    const text = term.trim()
    if (text.length < 2 || text.length > 48 || /[\u0000-\u001f]/.test(text)) return ''
    return text
}
function escapeLike(term) {
    return term.replace(/[\\%_]/g, (c) => '\\' + c)
}
async function filterStarRows({ supabase, userId, rows }) {
    const voice = await loadStarVoiceSessionIds({ supabase, userId, rows })
    return rows.filter((r) => {
        if (!['user','assistant'].includes(r.role) ||
            typeof r.content !== 'string' || !r.content.trim()) return false
        if (typeof r.reasoning_content === 'string' && r.reasoning_content !== '' &&
            r.reasoning_content !== 'proactive') return false
        const channel = r.channel || 'text'
        return channel === 'text' || (channel === 'voice' &&
            voice.has(String(r.call_session_id)))
    }).map(r => ({ id:String(r.id), sessionId:String(r.session_id),
        role:r.role, channel:r.channel || 'text', content:r.content,
        createdAt:r.created_at, wasHidden:r.visible === false }))
}
function uniqueRows(rows) {
    const seen = new Set()
    return rows.filter(row => {
        if (seen.has(row.id)) return false
        seen.add(row.id)
        return true
    }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

async function searchDiaryMessages({ supabase,userId,agentId='star',terms=[] }={}) {
    if (!supabase || !userId || agentId!=='star' || !Array.isArray(terms))
        throw new DiaryReadError('invalid_diary_reader_input')
    const selected = [...new Set(terms.map(safeTerm).filter(Boolean))].slice(0,MAX_SEARCH_TERMS)
    const hits = []
    for (const term of selected) {
        const rows = readRows(await supabase.from('messages')
            .select(FIELDS).eq('user_id',userId)
            .in('role',['user','assistant']).ilike('content',`%${escapeLike(term)}%`)
            .order('created_at',{ascending:false}).order('id',{ascending:false})
            .limit(MAX_HITS_PER_TERM))
        hits.push(...await filterStarRows({supabase,userId,rows}))
    }
    return uniqueRows(hits)
}

async function openDiaryContext({ supabase,userId,agentId='star',hits=[] }={}) {
    if (!supabase || !userId || agentId!=='star' || !Array.isArray(hits))
        throw new DiaryReadError('invalid_diary_reader_input')
    const results=[]
    let chars=0
    for (const hit of hits.slice(0,6)) {
        const timestamp=Date.parse(hit.createdAt)
        if (!Number.isFinite(timestamp) || !hit.sessionId || !hit.id) {
            throw new DiaryReadError('invalid_diary_reader_input')
        }
        const delta=CONTEXT_MINUTES*60000
        const rows=readRows(await supabase.from('messages')
            .select(FIELDS).eq('user_id',userId).eq('session_id',hit.sessionId)
            .gte('created_at',new Date(timestamp-delta).toISOString())
            .lte('created_at',new Date(timestamp+delta).toISOString())
            .in('role',['user','assistant']).order('created_at',{ascending:true})
            .order('id',{ascending:true}).range(0,MAX_NEIGHBORS))
        if (rows.length>MAX_NEIGHBORS) {
            throw new DiaryReadError('source_context_limit_exceeded')
        }
        const context=await filterStarRows({supabase,userId,rows})
        // Search results can contain hidden messages. Context MUST also see
        // hidden ones; otherwise star loses the thread surrounding a quote.
        if (!context.some((r)=>r.id===hit.id)) {
            throw new DiaryReadError('source_context_mismatch')
        }
        for (const row of context) {
            chars += row.content.length
            if (chars>MAX_CONTEXT_CHARS) {
                throw new DiaryReadError('source_context_character_limit_exceeded')
            }
        }
        results.push(...context)
    }
    return uniqueRows(results)
}

function assembleEvidence(sourceRows,additionalRows) {
    const rows=uniqueRows([...(sourceRows||[]),...(additionalRows||[])])
    const hash=crypto.createHash('sha256')
    const refs=[]
    for (const row of rows) {
        const reference={id:row.id,session_id:row.sessionId,
            at:row.createdAt,channel:row.channel}
        refs.push(reference)
        const value=JSON.stringify([reference,row.content])
        hash.update(`${Buffer.byteLength(value)}:${value}`)
    }
    return {rows,sourceRefs:refs,includedCount:refs.length,
        sourceHash:hash.digest('hex')}
}

module.exports={searchDiaryMessages,openDiaryContext,assembleEvidence,
    filterStarRows,safeTerm,escapeLike,MAX_SEARCH_TERMS,MAX_HITS_PER_TERM}
