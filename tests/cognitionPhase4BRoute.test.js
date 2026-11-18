'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const Module=require('node:module')
const originalLoad=Module._load
let createCognitionRouter
try {
 Module._load=function(name,parent,isMain){
   if(name==='express')return {Router:()=>({
      stack:[],post(path,handler){this.stack.push({route:{path,stack:[{handle:handler}]}})}
   })}
   return originalLoad.call(this,name,parent,isMain)
 }
 createCognitionRouter=require('../routes/cognition')
}finally{Module._load=originalLoad}
const USER='11111111-1111-4111-8111-111111111111'
const SECRET='test-long-cognition-secret-1234'
const F4A='COGNITION_PHASE4_EVENTS_ENABLED'
const F4B='COGNITION_PHASE4B_ENABLED'
function route(router,name){return router.stack.find(x=>x.route?.path===name)?.route?.stack[0].handle}
function res(){return {code:200,body:null,status(n){this.code=n;return this},json(b){this.body=b;return this}}}
function req(userId=USER,secret=SECRET){return {body:{userId,agentId:'star'},get:()=>secret}}
async function flags(a,b,cb){
 const oldA=process.env[F4A],oldB=process.env[F4B]
 process.env[F4A]=a;process.env[F4B]=b
 try{return await cb()}finally{
  if(oldA===undefined)delete process.env[F4A];else process.env[F4A]=oldA
  if(oldB===undefined)delete process.env[F4B];else process.env[F4B]=oldB
 }
}
function router(scanStatus='queued'){
 const calls={scan:0,dispatch:0}
 const r=createCognitionRouter({
   supabase:{},callModel:async()=>({}),expectedSecret:SECRET,expectedUserId:USER,
   scanConversation:async()=>{calls.scan++;return {status:scanStatus}},
   dispatchEvent:async()=>{calls.dispatch++;return {status:'empty',executed:false}}
 })
 return {r,calls}
}
test('no Phase4B route without both operator flags',async()=>{
 await flags('true','false',()=>{assert.equal(route(router().r,'/phase4b/scan-dispatch'),undefined)})
 await flags('false','true',()=>{assert.equal(route(router().r,'/phase4b/scan-dispatch'),undefined)})
})
test('Phase4B enforces the private token and target Star user',async()=>{
 await flags('true','true',async()=>{
  const {r,calls}=router()
  const handler=route(r,'/phase4b/scan-dispatch')
  let response=res()
  await handler(req(USER,'bad'),response)
  assert.equal(response.code,401)
  response=res()
  await handler(req('22222222-2222-4222-8222-222222222222'),response)
  assert.equal(response.code,403)
  assert.equal(calls.scan,0)
 })
})
test('active voice/chat prevents scan from dispatching',async()=>{
 for(const status of ['voice_active','not_idle']){
  await flags('true','true',async()=>{
   const {r,calls}=router(status),response=res()
   await route(r,'/phase4b/scan-dispatch')(req(),response)
   assert.equal(response.body.dispatch,'skipped_active')
   assert.equal(calls.scan,1);assert.equal(calls.dispatch,0)
  })
 }
})
test('idle scan proceeds to queue dispatch once',async()=>{
 await flags('true','true',async()=>{
  const {r,calls}=router('queued'),response=res()
  await route(r,'/phase4b/scan-dispatch')(req(),response)
  assert.equal(response.code,200)
  assert.deepEqual(response.body,{ok:true,scan:'queued',dispatch:'empty',executed:false})
  assert.equal(calls.scan,1);assert.equal(calls.dispatch,1)
 })
})
