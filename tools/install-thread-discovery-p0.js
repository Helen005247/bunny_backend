'use strict'

// Explicit local-only patch installer for the exact Phase4A-not-applied baseline.
// Never contacts an API. --check is read-only; --apply backs up before modifying.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')

const BASE_SHA256='174ed372dc493130d421bd9bc68d60735c7c72b692d72fb6255437b4449474f9'
const cwd=process.cwd()
const target=path.resolve(cwd,'services/cognition/cognitionService.js')
const service=path.resolve(cwd,'services/cognition/thoughtThreadDiscoveryP0.js')
const replacement=path.resolve(cwd,'replacement/cognitionService.js')

function sha(bytes){return crypto.createHash('sha256').update(bytes).digest('hex')}
function fail(message){console.error('P0 INSTALL STOPPED: '+message);process.exitCode=1}
function main(){
 const args=process.argv.slice(2)
 if(args.length!==1 || !['--check','--apply'].includes(args[0]))
    return fail('use --check or --apply')
 for(const p of [target,service,replacement])
    if(!fs.existsSync(p))return fail('required file not found: '+path.relative(cwd,p))
 const original=fs.readFileSync(target)
 const actual=sha(original)
 if(actual!==BASE_SHA256){
    return fail('baseline SHA mismatch. No changes made. Do not overwrite your current work.')
 }
 const patchedText=fs.readFileSync(replacement,'utf8')
 if(!patchedText.includes("require('./thoughtThreadDiscoveryP0')"))
    return fail('replacement missing discovery import')
 const usesCRLF=original.includes(Buffer.from('\r\n'))
 const compiled=Buffer.from(usesCRLF
    ? patchedText.replace(/\r?\n/g,'\r\n')
    : patchedText.replace(/\r\n/g,'\n'),'utf8')
 if(args[0]==='--check'){
    console.log('BASELINE_MATCH; ready for explicit --apply; database and models not accessed.')
    return
 }
 const backup=target+'.before-thread-discovery-p0.bak'
 if(fs.existsSync(backup))return fail('backup already exists; refusing to overwrite it')
 const temp=target+'.thread-discovery-p0.tmp'
 if(fs.existsSync(temp))return fail('temporary file exists; refusing to overwrite it')
 fs.writeFileSync(backup,original,{flag:'wx',mode:0o600})
 try {
    fs.writeFileSync(temp,compiled,{flag:'wx',mode:0o600})
    fs.renameSync(temp,target)
 }catch(e){
    try{if(fs.existsSync(temp))fs.unlinkSync(temp)}catch(_){}
    return fail('unable to replace safely; original backup kept')
 }
 console.log('LOCAL PATCH INSTALLED; original file backed up as cognitionService.js.before-thread-discovery-p0.bak.')
 console.log('Default THREAD_DISCOVERY_MODE=off. No model or database calls performed by installer.')
}
main()
