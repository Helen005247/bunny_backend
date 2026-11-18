'use strict'

// No model calls. No database calls. Install only if the user's backend files
// exactly match the uploaded, reviewed 2026-11-18 source.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const os=require('node:os')
const {execFileSync}=require('node:child_process')
const base=process.cwd()
const bundle=path.resolve(base,'phase4a_bundle')
const manifestFile=path.join(bundle,'MANIFEST.json')
function sha(x){return crypto.createHash('sha256').update(x).digest('hex')}
function stop(code){console.error('PHASE4A STOP: '+code);process.exitCode=1}
function filePath(rel) {return path.resolve(base,rel)}
function main(){
  const option=process.argv[2]
  if(process.argv.length!==3 || !['--check','--apply'].includes(option))
    return stop('EXPECTED --check OR --apply')
  if(!fs.existsSync(manifestFile))return stop('MANIFEST_MISSING')
  let m
  try{m=JSON.parse(fs.readFileSync(manifestFile,'utf8'))}
  catch(_){return stop('MANIFEST_INVALID')}
  if(m.version!=='Phase4A-current-2026-11-18-v1')return stop('MANIFEST_VERSION')
  const existing=Object.keys(m.original_base||{})
  const adds=Object.keys(m.new_hashes||{}).filter(x=>!Object.hasOwn(m.original_base,x))
  const protectedFiles=Object.keys(m.protected_sha||{})
  if(protectedFiles.length!==2)return stop('PROTECTED_MANIFEST_INVALID')
  for(const rel of protectedFiles){
    const file=filePath(rel)
    if(!fs.existsSync(file) || sha(fs.readFileSync(file))!==m.protected_sha[rel]){
      return stop('PROTECTED_SOURCE_CHANGED:'+rel)
    }
  }
  if(existing.length!==4 || adds.length!==4)return stop('MANIFEST_SHAPE_INVALID')
  for(const rel of [...existing,...adds]){
    const target=filePath(rel),candidate=path.resolve(bundle,rel)
    if(!candidate.startsWith(bundle+path.sep))return stop('BAD_PATH')
    if(!fs.existsSync(candidate) || sha(fs.readFileSync(candidate))!==m.new_hashes[rel])
       return stop('PATCH_FILE_CORRUPTED:'+rel)
    if(rel.endsWith('.js')){
      try{execFileSync(process.execPath,['--check',candidate],{stdio:'ignore'})}
      catch(_){return stop('PATCH_SYNTAX_ERROR:'+rel)}
    }
    if(existing.includes(rel)){
      if(!fs.existsSync(target) || sha(fs.readFileSync(target))!==m.original_base[rel]){
        return stop('BASELINE_MISMATCH:'+rel)
      }
    }else if(fs.existsSync(target)){
      return stop('NEW_FILE_ALREADY_EXISTS:'+rel)
    }
  }
  if(option==='--check'){
    console.log('READY: all four production baselines match. No files changed.')
    console.log('This check did NOT modify Supabase or start Cognition.')
    return
  }
  const backup=path.resolve(base,'..',
     'Hermit_Phase4A_Backup_'+new Date().toISOString().replace(/[:.]/g,'-'))
  if(fs.existsSync(backup))return stop('BACKUP_ALREADY_EXISTS')
  const written=[]
  try{
    fs.mkdirSync(backup,{recursive:false})
    for(const rel of existing){
      const dest=path.resolve(backup,rel)
      fs.mkdirSync(path.dirname(dest),{recursive:true})
      fs.copyFileSync(filePath(rel),dest,fs.constants.COPYFILE_EXCL)
    }
    fs.writeFileSync(path.join(backup,'manifest.json'),
      JSON.stringify({source_sha:m.original_base,version:m.version},null,2),
      {flag:'wx'})
    for(const rel of [...adds,...existing]){
      const dest=filePath(rel)
      fs.mkdirSync(path.dirname(dest),{recursive:true})
      fs.copyFileSync(path.resolve(bundle,rel),dest,
        adds.includes(rel)?fs.constants.COPYFILE_EXCL:0)
      written.push(rel)
    }
    console.log('INSTALLED Phase 4A code (not activated).')
    console.log('Original files backed up to '+backup)
    console.log('SQL migration must be reviewed/applied separately.')
    console.log('Event endpoints remain OFF until COGNITION_PHASE4_EVENTS_ENABLED=true.')
  }catch(_){
    // If an intermediate file copy failed, restore original content and
    // remove newly added files. Keep the external backup for investigation.
    for(const rel of written.reverse()){
      try{
        if(existing.includes(rel)){
          fs.copyFileSync(path.resolve(backup,rel),filePath(rel))
        }else{fs.unlinkSync(filePath(rel))}
      }catch(_){}
    }
    return stop('INSTALL_FAILED; review backup and git diff')
  }
}
main()
