'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const Module=require('node:module')
const orig=Module._load
Module._load=function(name,...args){if(name==='express') return {Router:()=>({
  handlers:new Map(), get(route,handler){this.handlers.set(route,handler)}
})};return orig.call(this,name,...args)}
let routerFactory
try{routerFactory=require('../routes/diary').createUserDiaryRouter}finally{Module._load=orig}
const ME='11111111-1111-4111-8111-111111111111'
const OTHER='22222222-2222-4222-8222-222222222222'
const ID='33333333-3333-4333-8333-333333333333'
const rows=[{diary_id:ID,user_id:ME,agent_id:'star',version:1,kind:'initial',body:'没有再被覆盖的旧正文',title:'第一版',topics:['生日'],created_at:'2026-10-16'},
 {diary_id:ID,user_id:ME,agent_id:'star',version:2,kind:'append',body:'没有再被覆盖的旧正文\n新加的一段',title:'第二版',topics:['生日'],created_at:'2026-10-17'}]
class Q{
 constructor(){this.filters=[];this.fields='*'}
 select(fields='*'){this.fields=fields;return this}
 project(row){if(!row)return null;return this.fields==='*'?row:Object.fromEntries(this.fields.split(',').map(s=>s.trim()).filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]))}
 eq(k,v){this.filters.push(r=>String(r[k])===String(v));return this}
 order(){return this}
 limit(){return this}
 then(resolve,reject){return Promise.resolve({data:rows.filter(r=>this.filters.every(f=>f(r))).map(r=>this.project(r)),error:null}).then(resolve,reject)}
 maybeSingle(){return Promise.resolve({data:this.project(rows.find(r=>this.filters.every(f=>f(r)))),error:null})}
}
const supabase={from(t){assert.equal(t,'diary_revisions');return new Q()}}
function response(){return {statusCode:200,body:null,
 status(s){this.statusCode=s;return this},set(){return this},json(v){this.body=v;return this}}}
test('revision metadata and body available only to same authenticated diary owner',async()=>{
 const router=routerFactory({supabase})
 const list=router.handlers.get('/:id/revisions')
 const body=router.handlers.get('/:id/revisions/:version')
 const a=response();await list({userId:ME,params:{id:ID}},a)
 assert.equal(a.body.revisions.length,2)
 assert.ok(!('body' in a.body.revisions[0]))
 const b=response();await body({userId:ME,params:{id:ID,version:'1'}},b)
 assert.equal(b.body.revision.body,'没有再被覆盖的旧正文')
 const c=response();await body({userId:OTHER,params:{id:ID,version:'1'}},c)
 assert.equal(c.statusCode,404)
 assert.ok(!JSON.stringify(c.body).includes('旧正文'))
 const d=response();await list({userId:null,params:{id:ID}},d)
 assert.equal(d.statusCode,503)
})
