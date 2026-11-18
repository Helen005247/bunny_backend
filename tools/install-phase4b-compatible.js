'use strict'

// Phase 4B installer: no Supabase requests, no model calls, no deployment.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const {execFileSync}=require('node:child_process')
const base=process.cwd()
const bundle=path.resolve(base,'phase4b_bundle')
const file=path.resolve(bundle,'MANIFEST.json')
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const pathFor=rel=>path.resolve(base,rel)
function stop(msg){console.error('PHASE4B STOP: '+msg);process.exitCode=1}
function validPath(rel){
  if(!/^[a-zA-Z0-9._/-]+$/.test(rel) || rel.includes('..') || path.isAbsolute(rel))return false
  const dest=pathFor(rel)
  return dest.startsWith(base+path.sep)
}
function main(){
  const mode=process.argv[2]
  if(process.argv.length!==3 || !['--check','--apply','--verify-installed'].includes(mode))
    return stop('USE --check, --apply OR --verify-installed')
  let m
  try{m=JSON.parse(fs.readFileSync(file,'utf8'))}
  catch(_){return stop('MANIFEST_NOT_FOUND_OR_INVALID')}
  if(m.version!=='Hermit-Phase4B-2026-11-18-v1')return stop('MANIFEST_VERSION')
  const updates=Object.keys(m.baselines||{})
  const additions=Object.keys(m.outputs||{}).filter(x=>!Object.hasOwn(m.baselines,x))
  const protectedPaths=Object.keys(m.protected||{})
  if(updates.length!==2 || additions.length!==6 || protectedPaths.length!==5)
    return stop('MANIFEST_SHAPE')
  for(const rel of [...updates,...additions,...protectedPaths]){
    if(!validPath(rel))return stop('INVALID_PATH')
    if(m.protected[rel]){
      if(!fs.existsSync(pathFor(rel)) || sha(fs.readFileSync(pathFor(rel)))!==m.protected[rel])
        return stop('PROTECTED_SOURCE_MISMATCH:'+rel)
      continue
    }
    const candidate=path.resolve(bundle,rel)
    if(!candidate.startsWith(bundle+path.sep) || !fs.existsSync(candidate) ||
       sha(fs.readFileSync(candidate))!==m.outputs[rel])return stop('CANDIDATE_CORRUPTED:'+rel)
    if(rel.endsWith('.js')){
      try{execFileSync(process.execPath,['--check',candidate],{stdio:'ignore'})}
      catch(_){return stop('SYNTAX_ERROR:'+rel)}
    }
    const target=pathFor(rel)
    if(mode==='--verify-installed'){
      if(!fs.existsSync(target) || sha(fs.readFileSync(target))!==m.outputs[rel])
        return stop('INSTALLED_MISMATCH:'+rel)
    }else if(Object.hasOwn(m.baselines,rel)){
      if(!fs.existsSync(target) || sha(fs.readFileSync(target))!==m.baselines[rel])
        return stop('BASELINE_MISMATCH:'+rel)
    }else if(fs.existsSync(target)) return stop('NEW_FILE_EXISTS:'+rel)
  }
  if(mode==='--verify-installed')return console.log('INSTALLED MATCH: all Phase4B files & protected source match. No writes.')
  if(mode==='--check')return console.log('READY: exact source baseline matched. No files changed.')
  const backup=path.resolve(base,'..','Hermit_Phase4B_Backup_'+new Date().toISOString().replace(/[:.]/g,'-'))
  if(fs.existsSync(backup))return stop('BACKUP_ALREADY_EXISTS')
  const written=[]
  try{
    fs.mkdirSync(backup)
    for(const rel of updates){
      const dst=path.resolve(backup,rel)
      fs.mkdirSync(path.dirname(dst),{recursive:true})
      fs.copyFileSync(pathFor(rel),dst,fs.constants.COPYFILE_EXCL)
    }
    fs.writeFileSync(path.resolve(backup,'manifest.json'),
      JSON.stringify({version:m.version,originalHashes:m.baselines},null,2),{flag:'wx'})
    for(const rel of [...additions,...updates]){
      const dst=pathFor(rel)
      fs.mkdirSync(path.dirname(dst),{recursive:true})
      fs.copyFileSync(path.resolve(bundle,rel),dst,
        additions.includes(rel)?fs.constants.COPYFILE_EXCL:0)
      written.push(rel)
    }
    console.log('INSTALLED. Phase4B is OFF until operator enables Render and GitHub flags.')
    console.log('Backups: '+backup)
    console.log('SQL not applied. No model calls or DB writes.')
  }catch(_){
    for(const rel of written.reverse())try{
      if(updates.includes(rel))fs.copyFileSync(path.resolve(backup,rel),pathFor(rel))
      else fs.unlinkSync(pathFor(rel))
    }catch(__){}
    return stop('INSTALL_FAILED; review backup and git diff')
  }
}
main()
