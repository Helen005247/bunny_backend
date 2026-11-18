'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
// Minimal Express router stub: the uploaded source bundle intentionally
// does not contain node_modules; production uses its normal Express package.
const Module=require('node:module')
const originalLoad=Module._load
let createCognitionRouter
try {
  Module._load=function(name,parent,isMain) {
    if(name==='express') return {
      Router:()=>({
        stack:[],
        post(path,handler){
          this.stack.push({route:{path,stack:[{handle:handler}]}})
        }
      })
    }
    return originalLoad.call(this,name,parent,isMain)
  }
  createCognitionRouter=require('../routes/cognition')
} finally {
  Module._load=originalLoad
}
const USER='11111111-1111-4111-8111-111111111111'
const OTHER='22222222-2222-4222-8222-222222222222'
const SECRET='this-is-a-very-long-private-test-secret'
const ENV='COGNITION_PHASE4_EVENTS_ENABLED'

function routeHandler(router,path) {
    const item=router.stack.find(x=>x.route?.path===path)
    return item?.route?.stack?.[0]?.handle
}
function mockResponse() {
    return {
        statusCode:200,body:null,
        status(n){this.statusCode=n;return this},
        json(body){this.body=body;return this}
    }
}
function req(userId=USER,validSecret=SECRET) {
    return {
        body:{userId,agentId:'star',eventType:'external_event',eventKey:'test-1'},
        get:()=>validSecret
    }
}
async function enabled(fn) {
    const old=process.env[ENV];process.env[ENV]='true'
    try{return await fn()}finally {
        if(old===undefined)delete process.env[ENV];else process.env[ENV]=old
    }
}
function makeRouter(calls) {
    return createCognitionRouter({
      supabase:{rpc:async()=>{throw Error('unexpected DB call')}},
      callModel:async()=>({output_text:'{}'}),expectedUserId:USER,
      expectedSecret:SECRET,
      runTick:async()=>{calls.run++},
      enqueueEvent:async()=>{calls.enqueue++;return {id:'demo-id',status:'pending'}},
      dispatchEvent:async()=>{calls.dispatch++;return {status:'empty',executed:false}}
    })
}

test('default state registers only the original private /tick route',()=>{
 const original=process.env[ENV]
 delete process.env[ENV]
 try{
   const router=makeRouter({enqueue:0,dispatch:0,run:0})
   assert(routeHandler(router,'/tick'))
   assert.equal(routeHandler(router,'/events/enqueue'),undefined)
   assert.equal(routeHandler(router,'/events/dispatch'),undefined)
 }finally{if(original!==undefined)process.env[ENV]=original}
})
test('enabled private event endpoints reject bad token and other user',async()=>{
 await enabled(async()=>{
   const c={enqueue:0,dispatch:0,run:0}
   const router=makeRouter(c)
   const handler=routeHandler(router,'/events/enqueue')
   assert.equal(typeof handler,'function')
   let res=mockResponse()
   await handler(req(USER,'bad-secret'),res)
   assert.equal(res.statusCode,401)
   res=mockResponse()
   await handler(req(OTHER,SECRET),res)
   assert.equal(res.statusCode,403)
   assert.equal(c.enqueue,0)
 })
})
test('enabled queue accepts only user-scoped authenticated call',async()=>{
 await enabled(async()=>{
   const c={enqueue:0,dispatch:0,run:0}
   const router=makeRouter(c)
   let res=mockResponse()
   await routeHandler(router,'/events/enqueue')(req(),res)
   assert.equal(res.statusCode,200)
   assert.equal(res.body.status,'pending')
   assert.equal(c.enqueue,1)
   res=mockResponse()
   await routeHandler(router,'/events/dispatch')(req(),res)
   assert.equal(res.statusCode,200)
   assert.equal(res.body.status,'empty')
   assert.equal(c.dispatch,1)
 })
})
test('feature can be disabled after registration without invoking service',async()=>{
 await enabled(async()=>{
   const c={enqueue:0,dispatch:0,run:0}
   const router=makeRouter(c)
   delete process.env[ENV]
   const res=mockResponse()
   await routeHandler(router,'/events/dispatch')(req(),res)
   assert.equal(res.statusCode,503)
   assert.equal(c.dispatch,0)
 })
})
