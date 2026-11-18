'use strict'

// LOCAL FILE INSTALLER ONLY: never starts Cognition or contacts production DB.
// Requires the existing P0 integration and the original P0 module SHA.
// --check reads files; --apply backs up module and tests before replacement.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const root=process.cwd()
const expectedSha='118b9a24e2059bf7d49675b6a974a32a8a601c11ec49bf7d552747f2ab63db7a'
const replacementSha='39281e16230516b099b9c84e8e584c91411777e2821d10e0a870b01d6c5b7961'
const target=path.join(root,'services','cognition','thoughtThreadDiscoveryP0.js')
const source=path.join(root,'shadow_bundle','thoughtThreadDiscoveryP0.js')
const service=path.join(root,'services','cognition','cognitionService.js')
const testTarget=path.join(root,'tests','cognitionThreadDiscoveryP0.test.js')
const testSource=path.join(root,'shadow_bundle','cognitionThreadDiscoveryP0.test.js')
const suffix='.before-production-shadow-only.bak'

function sha(b){return crypto.createHash('sha256').update(b).digest('hex')}
function fail(code){console.error('STOP: '+code);process.exitCode=1}
function main(){
 const args=process.argv.slice(2)
 if(args.length!==1 || !['--check','--apply'].includes(args[0]))return fail('INVALID_OPTION')
 for(const f of [target,source,service,testSource]){
   if(!fs.existsSync(f))return fail('FILE_MISSING: '+path.relative(root,f))
 }
 const current=fs.readFileSync(target)
 const currentSha=sha(current)
 if(currentSha===replacementSha){
   console.log('ALREADY_INSTALLED: production Shadow-only module matches.')
   return
 }
 if(currentSha!==expectedSha)return fail('P0_BASELINE_MISMATCH: no files changed')
 if(sha(fs.readFileSync(source))!==replacementSha)return fail('BUNDLE_SHA_MISMATCH')
 const cognition=fs.readFileSync(service,'utf8')
 if(!cognition.includes("require('./thoughtThreadDiscoveryP0')") ||
   !cognition.includes('evaluateOpportunity') ||
   !cognition.includes('persistOpportunity')){
   return fail('P0_INTEGRATION_NOT_PRESENT')
 }
 const moduleBackup=target+suffix
 const testBackup=testTarget+suffix
 if(fs.existsSync(moduleBackup) || fs.existsSync(testBackup))
   return fail('BACKUP_ALREADY_EXISTS: resolve manually before apply')
 if(args[0]==='--check'){
   console.log('READY: matching P0 module and integration; no files changed.')
   return
 }
 const moduleTemp=target+'.shadow-only.tmp'
 const testTemp=testTarget+'.shadow-only.tmp'
 if(fs.existsSync(moduleTemp) || fs.existsSync(testTemp))
   return fail('TEMP_FILE_ALREADY_EXISTS')
 try{
   fs.writeFileSync(moduleBackup,current,{flag:'wx'})
   if(fs.existsSync(testTarget)){
     fs.writeFileSync(testBackup,fs.readFileSync(testTarget),{flag:'wx'})
   }
   fs.writeFileSync(moduleTemp,fs.readFileSync(source),{flag:'wx'})
   fs.writeFileSync(testTemp,fs.readFileSync(testSource),{flag:'wx'})
   // Install new implementation first, then its updated test suite.
   fs.renameSync(moduleTemp,target)
   fs.renameSync(testTemp,testTarget)
   console.log('INSTALLED_SHADOW_ONLY: module and tests updated with backups.')
   console.log('No models or databases called. Set mode only on chosen backend process.')
 }catch(_){
   for(const f of [moduleTemp,testTemp]){
     try { if(fs.existsSync(f))fs.unlinkSync(f) }catch(_){}
   }
   return fail('INSTALL_FAILED: inspect backups and files before rerunning')
 }
}
main()
