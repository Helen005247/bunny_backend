'use strict'

// Controlled verification intentionally does not ask Star to choose an action.
// It checks real search + neighbor retrieval + full recall + version snapshots,
// and invokes the *real* transactional diary write functions in rollback-only
// SQL probes. No synthetic messages are ever persisted into user data.
const { runAcceptanceProbe } = require('./diaryAcceptance')
const { searchDiaryMessages,openDiaryContext,safeTerm } = require('./diarySearch')
const { buildDiaryChatContext } = require('./diaryRecall')

async function runDiaryV2Verification({supabase,userId,agentId='star',keyword,
    search=searchDiaryMessages,openContext=openDiaryContext,
    recall=buildDiaryChatContext,probe=runAcceptanceProbe}={}) {
    if (!supabase?.from || !supabase?.rpc || !userId || agentId!=='star' ||
        typeof keyword!=='string' || !safeTerm(keyword) || keyword.length>48)
        throw new Error('invalid_diary_input')
    const verified=await probe({supabase,userId,agentId})
    if(verified.status!=='verified'||verified.rolledBack!==1)
        return {status:'failed',processed:0,errorCode:'acceptance_probe_failed',
            dbVerified:0,modelVerified:0,liveWriteVerified:0}
    const extra=await supabase.rpc('diary_v2_two_create_probe',{
        p_user_id:userId,p_agent_id:agentId,
    })
    if(extra.error || extra.data?.ok!==true || extra.data?.rolled_back!==true ||
       extra.data?.twoCreate!==true)
        return {status:'failed',processed:0,errorCode:'acceptance_probe_failed',
            dbVerified:0,modelVerified:0,liveWriteVerified:0}
    const hits=await search({supabase,userId,agentId,terms:[keyword]})
    if(!Array.isArray(hits)||hits.length===0)
        return {status:'failed',processed:0,errorCode:'verify_search_no_hits',
            dbVerified:1,twoCreateVerified:1,searchVerified:0,
            modelVerified:0,liveWriteVerified:0}
    const context=await openContext({supabase,userId,agentId,hits})
    const present=new Set(context.map(row=>row.id))
    if(!hits.some(h=>present.has(h.id)))
        return {status:'failed',processed:0,errorCode:'verify_context_missing',
            dbVerified:1,twoCreateVerified:1,searchVerified:0,
            modelVerified:0,liveWriteVerified:0}
    const entries=await supabase.from('agent_diary')
        .select('id,current_version,title,body,topics').eq('user_id',userId)
        .eq('agent_id',agentId).order('created_at',{ascending:false}).limit(20)
    if(entries?.error||!Array.isArray(entries?.data))
        throw new Error('diary_database_failure')
    for(const entry of entries.data) {
        const last=await supabase.from('diary_revisions')
            .select('version,title,body,topics').eq('user_id',userId)
            .eq('agent_id',agentId).eq('diary_id',entry.id)
            .eq('version',entry.current_version).maybeSingle()
        const initial=await supabase.from('diary_revisions')
            .select('version,title,body').eq('user_id',userId)
            .eq('agent_id',agentId).eq('diary_id',entry.id).eq('version',1).maybeSingle()
        if(last?.error||!last?.data || last.data.version!==entry.current_version ||
            last.data.body!==entry.body || last.data.title!==entry.title ||
            JSON.stringify(last.data.topics)!==JSON.stringify(entry.topics) ||
            initial?.error||initial?.data?.version!==1 ||
            typeof initial?.data?.body!=='string' || !initial.data.body)
            return {status:'failed',processed:0,errorCode:'verify_revision_mismatch',
                dbVerified:1,twoCreateVerified:1,searchVerified:1,
                modelVerified:0,liveWriteVerified:0}
    }
    const latest=await recall({supabase,userId,agentId,
        message:'星星，请把你最新写的日记全文读给我',channel:'text'})
    if(entries.data.length>0 && (latest.mode!=='full'||latest.matched<1 || latest.fullChars<1))
        return {status:'failed',processed:0,errorCode:'verify_recall_unavailable',
            dbVerified:1,twoCreateVerified:1,searchVerified:1,
            modelVerified:0,liveWriteVerified:0}
    return {status:'verified',processed:1,dbVerified:1,twoCreateVerified:1,
        searchVerified:1,contextVerified:1,versionVerified:1,
        recallVerified:entries.data.length>0?1:0,
        searchCount:hits.length,contextCount:context.length,
        revisionsChecked:entries.data.length,modelVerified:0,
        liveWriteVerified:0,rolledBack:1}
}
module.exports={runDiaryV2Verification}
