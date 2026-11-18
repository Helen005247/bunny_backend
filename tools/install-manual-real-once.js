'use strict'
// Exact-SHA local installer. Does not call the model or Supabase.
// Supports old P0 and subsequent production Shadow-only module.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const root=process.cwd()
const target=path.resolve(root,'services/cognition/thoughtThreadDiscoveryP0.js')
const integrated=path.resolve(root,'services/cognition/cognitionService.js')
const newModule=path.resolve(root,'manual_bundle/thoughtThreadDiscoveryP0.js')
const testTarget=path.resolve(root,'tests/cognitionThreadDiscoveryP0.test.js')
const newTest=path.resolve(root,'manual_bundle/cognitionThreadDiscoveryP0.test.js')
const accepted=['118b9a24e2059bf7d49675b6a974a32a8a601c11ec49bf7d552747f2ab63db7a','39281e16230516b099b9c84e8e584c91411777e2821d10e0a870b01d6c5b7961']
const expected='13f4e8b515464962a6fc33ae7aff20f5a6b0fc8f574db049fe116b4bf564b785'
const backupSuffix='.before-manual-real-once.bak'
function sha(b){return crypto.createHash('sha256').update(b).digest('hex')}
function stop(code){console.error('STOP: '+code);process.exitCode=1}
function main(){
 const args=process.argv.slice(2)
 if(args.length!==1 || !['--check','--apply'].includes(args[0]))
   return stop('EXPECTED_--check_OR_--apply')
 for(const f of [target,integrated,newModule,newTest])
   if(!fs.existsSync(f))return stop('MISSING_'+path.relative(root,f))
 const cur=fs.readFileSync(target)
 const curSha=sha(cur)
 if(curSha===expected){
   console.log('ALREADY_INSTALLED: manual real-once module matches.');return
 }
 if(!accepted.includes(curSha))return stop('BASELINE_SHA_MISMATCH')
 if(sha(fs.readFileSync(newModule))!==expected)return stop('BUNDLE_HASH_FAILED')
 const service=fs.readFileSync(integrated,'utf8')
 if(!service.includes("require('./thoughtThreadDiscoveryP0')") ||
     !service.includes('evaluateOpportunity') ||
     !service.includes('persistOpportunity'))
    return stop('P0_INTEGRATION_MISSING')
 if(fs.existsSync(target+backupSuffix) ||
    fs.existsSync(testTarget+backupSuffix))return stop('BACKUP_EXISTS')
 if(args[0]==='--check'){
   console.log('READY: baseline and integration verified; no files changed.');return
 }
 const tmp1=target+'.manual-real-once.tmp',tmp2=testTarget+'.manual-real-once.tmp'
 if(fs.existsSync(tmp1)||fs.existsSync(tmp2))return stop('TEMP_EXISTS')
 try{
   fs.writeFileSync(target+backupSuffix,cur,{flag:'wx'})
   if(fs.existsSync(testTarget))
     fs.writeFileSync(testTarget+backupSuffix,fs.readFileSync(testTarget),{flag:'wx'})
   fs.writeFileSync(tmp1,fs.readFileSync(newModule),{flag:'wx'})
   fs.writeFileSync(tmp2,fs.readFileSync(newTest),{flag:'wx'})
   fs.renameSync(tmp1,target)
   fs.renameSync(tmp2,testTarget)
   console.log('INSTALLED manual-real-once module + tests (backups created).')
   console.log('Feature remains OFF until explicit Render environment flags are set.')
 }catch(_){
   for(const f of [tmp1,tmp2]){try{if(fs.existsSync(f))fs.unlinkSync(f)}catch(_){}}
   stop('INSTALL_FAILED_CHECK_FILES_AND_BACKUPS')
 }
}
main()
