'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {enrichCandidates} = require('../services/diary/diaryAutonomyWriter')

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

// Mimic the crucial PostgREST contract: a JSONB-array filter operand must
// arrive as JSON *text*, not as the SQL-array literal Supabase would construct
// from a bare JavaScript array.
function mockSupabase(rows) {
    const observed=[]
    return {
        observed,
        from(table) {
            const predicates=[]
            return {
                select(){return this},
                eq(k,v){predicates.push(row=>String(row[k])===String(v));return this},
                ilike(k,p){const needle=p.replace(/\\([%_\\])/g,'$1').replace(/%/g,'').toLowerCase();
                    predicates.push(row=>String(row[k]||'').toLowerCase().includes(needle));return this},
                contains(k,v){
                    assert.equal(k,'topics')
                    assert.equal(typeof v,'string','PostgREST JSONB value must be JSON text')
                    const decoded=JSON.parse(v)
                    assert.ok(Array.isArray(decoded))
                    observed.push({value:v,decoded})
                    predicates.push(row=>decoded.every(tag=>Array.isArray(row[k])&&row[k].includes(tag)))
                    return this
                },
                order(){return this},
                limit(){return this},
                then(resolve,reject){
                    return Promise.resolve({data:(rows[table]||[]).filter(r=>predicates.every(fn=>fn(r))),error:null})
                        .then(resolve,reject)
                },
            }
        },
    }
}

for(const word of ['生日','星星,礼物','他说“晚安”','星星\\礼物','两颗⭐']) {
    test(`JSONB topic matching round-trips safely: ${word}`, async()=>{
        const diary={id:'diary-'+word,user_id:USER,agent_id:'star',title:'没有命中标题',topics:[word]}
        const foreign={id:'foreign',user_id:OTHER,agent_id:'star',title:'无关',topics:[word]}
        const db=mockSupabase({agent_diary:[diary,foreign],diary_topics:[]})
        const result=await enrichCandidates({supabase:db,userId:USER,agentId:'star',terms:[word],entries:[],topics:[]})
        assert.equal(result.entries.length,1)
        assert.equal(result.entries[0].id,diary.id)
        assert.deepEqual(db.observed.map(v=>v.decoded),[[word]])
    })
}
