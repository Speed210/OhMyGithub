import test from 'node:test'
import assert from 'node:assert/strict'
import { createFusionRunnerPolicy, LARGE_FILE_GUIDANCE, FUSION_RUNNER_POLICY } from './index.mjs'

test('runner guidance improves write/edit tooling and is idempotent and Fusion-only', async () => {
  const hooks={}, plugin=createFusionRunnerPolicy({log:()=>{}})
  await plugin.setup({session:{hook:async(name,callback)=>{hooks[name]=callback}}})
  const event={model:{providerID:'copilot-fusion-direct'},system:[],tools:{write:{description:'Write a file.'}}}
  hooks.context(event);hooks.context(event)
  assert.equal(event.system.length,1);assert.equal(event.system[0].text,LARGE_FILE_GUIDANCE)
  assert.match(event.tools.write.description,/12000 characters/)
  const other={model:{providerID:'other'},system:[],tools:{}};hooks.context(other);assert.equal(other.system.length,0)
})
test('compaction retries and shrinking overflow attempts stop visibly at three with a five-minute operation budget', async () => {
  let now=0; const hooks={},logs=[]
  await createFusionRunnerPolicy({now:()=>now,log:message=>logs.push(message)}).setup({session:{hook:async(name,callback)=>{hooks[name]=callback}}})
  const event={sessionID:'session',model:{providerID:'copilot-fusion-direct'},kind:'compaction'}
  hooks.compaction(event)
  for(let i=1;i<=3;i++) {
    const request={...event,request:new Request('http://127.0.0.1/responses',{method:'POST',body:'{}'})};hooks['http.request'](request)
    const response={...event,response:Response.json({error:{code:'context_length_exceeded'}},{status:400})};hooks['http.response'](response)
    assert.equal(response.response.status,i<3?400:422)
    if(i===3) assert.equal((await response.response.json()).error.code,'compaction_retry_exhausted')
  }
  const fourth={...event,request:new Request('http://127.0.0.1/responses')};hooks['http.request'](fourth);assert.equal(fourth.request.signal.aborted,true)
  const retry={...event,decision:{retry:true,delay:100}};hooks.retry(retry);assert.deepEqual(retry.decision,{retry:false})
  hooks.compaction(event);now=FUSION_RUNNER_POLICY.compactionMs
  const late={...event,request:new Request('http://127.0.0.1/responses')};hooks['http.request'](late);assert.equal(late.request.signal.aborted,true)
  const timeout={...event,decision:{retry:true,delay:100}};hooks.retry(timeout);assert.equal(timeout.decision.retry,false)
  assert.ok(logs.some(message=>message.includes('attempt 3/3')));assert.ok(logs.some(message=>message.includes('visible non-retryable')))
})

test('a previous foreground budget cannot suppress normal primary or other-agent retries', async () => {
  const hooks={};await createFusionRunnerPolicy({log:()=>{}}).setup({session:{hook:async(name,callback)=>{hooks[name]=callback}}})
  const event={sessionID:'session',model:{providerID:'copilot-fusion-direct'},kind:'compaction',agent:'compaction'}
  hooks.compaction(event)
  for(let i=0;i<3;i++)hooks['http.request']({...event,request:new Request('http://127.0.0.1/')})
  const title={...event,agent:'title',decision:{retry:true,delay:0}};hooks.retry(title);assert.equal(title.decision.retry,true)
  hooks['http.request']({...event,kind:'primary'})
  const retry={...event,decision:{retry:true,delay:0}};hooks.retry(retry);assert.equal(retry.decision.retry,true)
})

test('shared-only request kinds route titles separately without changing unrelated requests',async()=>{
 const hooks={};await createFusionRunnerPolicy({upstream:'https://proxy.test/api/fusion-pool',log:()=>{}}).setup({session:{hook:async(name,fn)=>{hooks[name]=fn}}})
 for(const kind of ['primary','title','compaction','generate']){
 const event={kind,sessionID:'s',model:{providerID:'copilot-fusion-direct'},request:new Request('https://proxy.test/responses',{method:'POST',body:'{}'})};hooks['http.request'](event);assert.equal(event.request.headers.get('x-fusion-request-kind'),kind)
 }
 const other={kind:'title',model:{providerID:'copilot-fusion-direct'},request:new Request('https://elsewhere.test/responses')};hooks['http.request'](other);assert.equal(other.request.headers.get('x-fusion-request-kind'),null)
})

test('production installs the reviewed immutable denaidark Fusion fork, not a moving main',async()=>{
 const {readFile}=await import('node:fs/promises');const workflow=await readFile(new URL('../../../.github/workflows/opencode-reusable.yml',import.meta.url),'utf8')
 assert.match(workflow,/plugin_repo='https:\/\/github\.com\/denaidark\/opencode-copilot-fusion\.git'/)
 assert.match(workflow,/plugin_commit='16f95e0472ccbde1f3951f00765f1751ba4db80d'/)
 assert.doesNotMatch(workflow,/git ls-remote \"?\$plugin_repo/)
})
