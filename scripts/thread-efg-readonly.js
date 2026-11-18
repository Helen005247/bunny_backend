'use strict'
// EXACT-review E/F/G v3. No imports of thread-real-review-once.js or its commit().
require('dotenv').config()
const path=require('node:path')
const fs=require('node:fs')
const crypto=require('node:crypto')
const OpenAI=require('openai')
const {createClient}=require('@supabase/supabase-js')
const {listThoughtThreads}=require('../services/cognition/thoughtThreadService')
const {classifyThoughts}=require('./thread-efg-original-review-adapter')
const {sha,selectOnlyDb,inspectCounts,validateBaseline,prompts,run}=require('./thread-efg-core')

const EXPECTED_SOURCE_SHA256='838df0bfc475355001c31083ae01f782f6c18f8d149353f0fb55a020b2a08c5d'
const USER_DEFAULT='00edc61c-092e-44e4-be88-048b366d3bcf'
const REVIEW_SCRIPT=path.resolve(process.cwd(),'scripts/thread-real-review-once.js')

function getOption(name,def=null) {
    const prefix='--'+name+'='
    const entry=process.argv.slice(2).find(x=>x.startsWith(prefix))
    return entry ? entry.slice(prefix.length) : def
}
function checkOptions(){
    const permitted=['--inspect','--compare','--user-id=','--private-output=','--repeat=']
    for(const x of process.argv.slice(2))
        if(!permitted.some(p=>p.endsWith('=')?x.startsWith(p):x===p))
            throw Error('INVALID_ARGUMENT')
    if(process.argv.includes('--inspect')===process.argv.includes('--compare'))
        throw Error('CHOOSE_INSPECT_OR_COMPARE')
    if(getOption('repeat','4')!=='4') throw Error('REPEAT_MUST_EQUAL_4')
}
function verifySource() {
    if(!fs.existsSync(REVIEW_SCRIPT)) throw Error('ORIGINAL_REVIEW_SCRIPT_MISSING')
    const actual=sha(fs.readFileSync(REVIEW_SCRIPT))
    if(actual!==EXPECTED_SOURCE_SHA256)
        throw Error('ORIGINAL_REVIEW_SCRIPT_CHANGED')
    return actual.slice(0,12)
}
async function snapshot(db,userId,now) {
    // Exact original query: 50 max, newest-first, all retained Thoughts.
    const {data,error}=await db.from('agent_thoughts')
        .select('id, user_id, agent_id, content, created_at, expires_at')
        .eq('user_id',userId).eq('agent_id','star')
        .order('created_at',{ascending:false}).limit(50)
    if(error || !Array.isArray(data)) throw Error('THOUGHT_READ_FAILED')
    if(data.length>=50) throw Error('THOUGHT_QUERY_TRUNCATED')
    const threads=await listThoughtThreads({
        supabase:db,userId,agentId:'star',status:'all',limit:50
    })
    return {now:now.toISOString(),thoughts:data,threads}
}
function logRow(row){
    console.log(JSON.stringify(row))
}
async function main(){
    checkOptions()
    const uuid=getOption('user-id',USER_DEFAULT)
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid))
        throw Error('INVALID_UUID')
    const sourceHash=verifySource()
    for(const env of ['SUPABASE_URL','SUPABASE_SECRET_KEY'])
        if(!process.env[env]) throw Error('MISSING_'+env)
    const rawDb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{
        auth:{persistSession:false,autoRefreshToken:false}
    })
    const db=selectOnlyDb(rawDb)
    const frozen=await snapshot(db,uuid,new Date())
    const counts=inspectCounts(frozen)
    let readiness
    if (counts.total===0) readiness='NO_THOUGHTS'
    else if (counts.active===0) readiness='NO_ACTIVE_THOUGHTS'
    else if (counts.threads>0) readiness='THREAD_ALREADY_EXISTS'
    else if (counts.total>=50) readiness='HISTORY_LIMIT_REACHED'
    else if (new Set(frozen.thoughts.map(t=>String(t.id))).size!==counts.total) readiness='DUPLICATED_THOUGHT_ID'
    else readiness='READY_FOR_READ_ONLY_COMPARE'
    const originalWindow=(counts.total===12 && counts.active===8 && counts.expired===4)
        ? 'MATCHES_OLD_12_8_4' : 'CURRENT_COUNTS_DIFFER_FROM_OLD_SNAPSHOT'
    const p=readiness==='READY_FOR_READ_ONLY_COMPARE' && process.argv.includes('--compare')?prompts(frozen):null
    console.log(JSON.stringify({
        experiment:'Hermit Thread EFG diagnostic v4',
        mode:process.argv.includes('--compare')?'compare':'inspect',
        original_review_sha_prefix:sourceHash,
        frozen_at:frozen.now,
        snapshot_hash:sha(JSON.stringify(frozen)).slice(0,12),
        groups:counts,
        earlier_12_8_4:originalWindow,
        readiness,
        prompt_chars:p?Object.fromEntries(['E','F','G'].map(g=>[g,p[g].length])):null,
        database:'SELECT_ONLY'
    }))
    if(process.argv.includes('--inspect')){
        console.log('Inspect completed; zero model calls and zero database writes. The displayed counts are the real database counts at this moment.')
        return
    }
    validateBaseline(frozen)
    for(const env of ['AI_BASE_URL','AI_API_KEY'])
        if(!process.env[env]) throw Error('MISSING_'+env)
    const client=new OpenAI({
        apiKey:process.env.AI_API_KEY,baseURL:process.env.AI_BASE_URL,
        maxRetries:0,timeout:45000,
    })
    console.log('Starting 12 model calls using one frozen snapshot; no database writes.')
    const rows=await run({snapshot:frozen,client,onRow:logRow})
    for(const group of ['E','F','G']){
        const these=rows.filter(r=>r.group===group)
        console.log(`${group}: create=${these.filter(r=>r.decision==='create').length}/4; `+
            `none=${these.filter(r=>r.decision==='none').length}; `+
            `errors=${these.filter(r=>r.decision==='error').length}`)
    }
    const privatePath=getOption('private-output')
    if(privatePath){
        const file=path.resolve(privatePath)
        fs.mkdirSync(path.dirname(file),{recursive:true})
        fs.writeFileSync(file, JSON.stringify({
            frozen_at:frozen.now, snapshot_hash:sha(JSON.stringify(frozen)).slice(0,12),
            results:rows
        },null,2),{flag:'wx',mode:0o600,encoding:'utf8'})
        console.log('Saved private candidate report to local path. Do not share unredacted.')
    }
    console.log('END: no Thought/Thread/Runtime/Diary writes.')
}
main().catch(err=>{
    const known=new Set(['INVALID_ARGUMENT','CHOOSE_INSPECT_OR_COMPARE','REPEAT_MUST_EQUAL_4',
        'ORIGINAL_REVIEW_SCRIPT_MISSING','ORIGINAL_REVIEW_SCRIPT_CHANGED','INVALID_UUID',
        'MISSING_SUPABASE_URL','MISSING_SUPABASE_SECRET_KEY','MISSING_AI_BASE_URL','MISSING_AI_API_KEY',
        'THOUGHT_READ_FAILED','THOUGHT_QUERY_TRUNCATED','DATASET_CHANGED','THREAD_ALREADY_EXISTS',
        'DUPLICATED_THOUGHT_ID','NO_THOUGHTS','NO_ACTIVE_THOUGHTS',
        'HISTORY_LIMIT_REACHED','PROMPT_OVER_40000_CHARS','INVALID_SNAPSHOT'])
    const msg=String(err?.message||'')
    const category=msg.startsWith('DATASET_CHANGED')?'DATASET_CHANGED':
        known.has(msg)?msg:'READ_OR_CONFIG_ERROR'
    console.error(`EFG stopped: ${category}`)
    process.exitCode=1
})
