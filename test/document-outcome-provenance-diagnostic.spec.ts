import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import type { Env } from '../src/env';
import { ManagedDocumentChangeJobStore } from '../src/documents/change-job-store';

// Characterization only: a retained summary must not be interpreted as new completion.
it('pre-coordinator deadline keeps prior four completions while exact pending job remains pending', async () => {
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName('PRJ-9257');
  const observed = await runInDurableObject(guard, async (instance, state) => {
    const store = new ManagedDocumentChangeJobStore(state.storage);
    const ids = [
      'CHGJOB-111111111111111111111111', 'CHGJOB-222222222222222222222222',
      'CHGJOB-333333333333333333333333', 'CHGJOB-444444444444444444444444',
      'CHGJOB-555555555555555555555555'
    ];
    store.registerPage({ expected_cursor: store.cursor(), next_cursor: 'diagnostic-origin-cursor',
      jobs: ids.map((job_id,index) => ({job_id,change:{kind:'deleted' as const,
        name:`fixture-${index}.md`,path:`/inputs/fixture-${index}.md`},detection_source:'incremental' as const,priority:10})) });
    for (const id of ids.slice(0,4)) store.markCompleted(id);
    const cohort=store.beginSelectionCohort(Date.now());
    const selected=store.selectNextPending(cohort,Date.now());
    if(selected?.job_id!==ids[4]) throw new Error('Expected exact pending fixture identity');
    const readSelected=()=>state.storage.sql.exec<{job_id:string,status:string,attempts:number}>(
      `SELECT j.job_id,j.status,j.attempts FROM managed_document_change_selection_control c
       JOIN managed_document_change_jobs j ON j.ordinal=c.last_ordinal
       WHERE c.singleton=1 AND j.priority=c.last_priority LIMIT 1`).toArray();
    const origin = store.beginContinuationSlice(true, Date.now());
    store.finishContinuationSlice({pending:true,next_wake_at:Date.now()+1000,
      documents_priority_next:false,feed_retry_at:null,outcome:{jobs_completed:4,jobs_registered:0,
        semantic_progress:4,executable_jobs:1,budget_yield:true,verification_completed:false,safe_errors:[]}});
    const before = {pending:store.pendingCount(),continuation:store.continuation()};
    const target = instance as unknown as {resumeManagedDocumentContinuation(at:number):Promise<void>};
    await target.resumeManagedDocumentContinuation(Date.now()-18001);
    const selectedAfterYield=readSelected();
    const after={pending:store.pendingCount(),continuation:store.continuation()};
    const rows=state.storage.sql.exec<{job_id:string,status:string}>(
      'SELECT job_id,status FROM managed_document_change_jobs ORDER BY ordinal').toArray();
    store.markCompleted(selected.job_id);
    return {origin:origin.slice_ordinal,before,after:{pending:store.pendingCount(),continuation:store.continuation()},
      afterYield:after,rows,selectedAfterYield,selectedAfterTerminal:readSelected(),pendingAfterTerminal:store.pendingCount()};
  });
  expect(observed.before.pending).toBe(1);
  expect(observed.afterYield.pending).toBe(1);
  expect(observed.afterYield.continuation.last_outcome?.jobs_completed).toBe(4);
  expect(observed.afterYield.continuation.slice_ordinal).toBe(observed.origin);
  expect(observed.afterYield.continuation.documents_priority_next).toBe(true);
  expect(observed.selectedAfterYield).toEqual([{job_id:'CHGJOB-555555555555555555555555',status:'pending',attempts:0}]);
  expect(observed.selectedAfterTerminal).toEqual([{job_id:'CHGJOB-555555555555555555555555',status:'completed',attempts:1}]);
  expect(observed.pendingAfterTerminal).toBe(0);
  expect(observed.rows).toEqual([
    {job_id:'CHGJOB-111111111111111111111111',status:'completed'},
    {job_id:'CHGJOB-222222222222222222222222',status:'completed'},
    {job_id:'CHGJOB-333333333333333333333333',status:'completed'},
    {job_id:'CHGJOB-444444444444444444444444',status:'completed'},
    {job_id:'CHGJOB-555555555555555555555555',status:'pending'}
  ]);
});

for(const scenario of ['job_changed_failure_absent','job_unchanged_failure_reset'] as const)
it(`completion count belongs to the first UPDATE: ${scenario}`,async()=>{
  const guard=(env as unknown as Env).PROJECT_GUARD.getByName('PRJ-9258');
  const result=await runInDurableObject(guard,(_instance,state)=>{
    const store=new ManagedDocumentChangeJobStore(state.storage),id='CHGJOB-666666666666666666666666';
    store.registerPage({expected_cursor:store.cursor(),next_cursor:'completion-count',jobs:[{
      job_id:id,change:{kind:'deleted',name:'fixture.md',path:'/inputs/fixture.md'},detection_source:'incremental',priority:10}]});
    if(scenario==='job_unchanged_failure_reset') {
      store.markCompleted(id);
      state.storage.sql.exec(`INSERT INTO managed_document_change_job_failure_state
        (job_id,failure_fingerprint,progress_fingerprint,classification,consecutive_failures,next_attempt_at,stopped)
        VALUES (?,?,?,'internal',1,1000,0)`,id,'a'.repeat(64),'b'.repeat(64));
    }
    const affected=store.markCompleted(id);
    const trailing=state.storage.sql.exec<{count:number}>('SELECT changes() AS count').one().count;
    return{affected,trailing};
  });
  expect(result.affected).toBe(scenario==='job_changed_failure_absent'?1:0);
  expect(result.trailing).toBe(scenario==='job_changed_failure_absent'?0:1);
});

it('selection checkpoint is unknown for legacy, correlates exact fresh attempt, and reads without writes',async()=>{
  const guard=(env as unknown as Env).PROJECT_GUARD.getByName('PRJ-9259');
  const result=await runInDurableObject(guard,async(instance,state)=>{
    const store=new ManagedDocumentChangeJobStore(state.storage),id='CHGJOB-777777777777777777777777';
    store.registerPage({expected_cursor:store.cursor(),next_cursor:'diagnostic-private-cursor',jobs:[{
      job_id:id,change:{kind:'deleted',name:'PRIVATE_NAME.md',path:'/private/PRIVATE_PATH.md'},detection_source:'incremental',priority:10}]});
    const cohort=store.beginSelectionCohort(Date.now()),selected=store.selectNextPending(cohort,Date.now())!;
    const legacy=await store.readCheckpoint(new Date().toISOString());
    const slice=store.beginContinuationSlice(true,Date.now());
    const target=instance as unknown as {documentContinuationOutcome(value:unknown):Record<string,unknown>;resumeManagedDocumentContinuation(at:number):Promise<void>};
    const outcome=target.documentContinuationOutcome({semantic_progress:0,jobs_registered:0,jobs_completed:0,
      unread_feed:false,executable_jobs:1,future_eligible_jobs:0,stopped_unresolved_jobs:0,
      earliest_eligible_at:null,feed_retry_at:null,safe_errors:[],budget_yield:true,verification_completed:false,
      origin_slice_ordinal:slice.slice_ordinal,origin_observed_at_ms:Date.now(),
      last_attempt:{job_id:id,ordinal:selected.ordinal,slice_ordinal:slice.slice_ordinal,result:'budget_yield'}});
    store.finishContinuationSlice({pending:true,next_wake_at:Date.now()+1000,documents_priority_next:false,feed_retry_at:null,outcome});
    const changes=()=>state.storage.sql.exec<{count:number}>('SELECT total_changes() AS count').one().count;
    const before=changes(),fresh=await store.readCheckpoint(new Date().toISOString()),again=await store.readCheckpoint(new Date().toISOString()),after=changes();
    await target.resumeManagedDocumentContinuation(Date.now()-18001);
    const copied=await store.readCheckpoint(new Date().toISOString());
    store.beginSelectionCohort(Date.now());
    const reset=await store.readCheckpoint(new Date().toISOString());
    let oversizedRejected=false;
    try{store.finishContinuationSlice({pending:true,next_wake_at:null,documents_priority_next:false,feed_retry_at:null,
      outcome:{padding:'x'.repeat(16385)}});}catch{oversizedRejected=true;}
    store.finishContinuationSlice({pending:true,next_wake_at:null,documents_priority_next:false,feed_retry_at:null,
      outcome:{origin_slice_ordinal:slice.slice_ordinal,origin_observed_at_ms:Date.now(),
        last_attempt:{job_id:id,ordinal:selected.ordinal,slice_ordinal:slice.slice_ordinal,result:['completed']}}});
    const malformed=await store.readCheckpoint(new Date().toISOString());
    return{legacy,fresh,again,copied,reset,malformed,before,after,slice:slice.slice_ordinal,oversizedRejected};
  });
  expect(result.legacy).toHaveProperty('last_selection_checkpoint.correlation','unknown');
  expect(result.fresh).toHaveProperty('last_selection_checkpoint.job_id','CHGJOB-777777777777777777777777');
  expect(result.fresh).toHaveProperty('last_selection_checkpoint.correlation','same_job_and_slice');
  expect(result.fresh.continuation.last_outcome).toHaveProperty('origin_slice_ordinal',result.slice);
  expect(result.fresh.continuation.last_outcome).toHaveProperty('last_attempt.result','budget_yield');
  expect(result.before).toBe(result.after);
  expect(result.copied.continuation.last_outcome?.origin_observed_at_ms).toBe(result.fresh.continuation.last_outcome?.origin_observed_at_ms);
  expect(result.copied.continuation.last_outcome?.origin_slice_ordinal).toBe(result.slice);
  expect(result.reset).toHaveProperty('last_selection_checkpoint.job_id',null);
  expect(result.reset).toHaveProperty('last_selection_checkpoint.correlation','unknown');
  expect(result.oversizedRejected).toBe(true);
  expect(result.malformed.continuation.last_outcome).not.toHaveProperty('last_attempt');
  expect(result.malformed).toHaveProperty('last_selection_checkpoint.correlation','unknown');
  expect(new TextEncoder().encode(JSON.stringify(result.fresh.last_selection_checkpoint)).byteLength).toBeLessThanOrEqual(2048);
  expect(JSON.stringify(result.fresh)).not.toContain('PRIVATE_PATH');
  expect(JSON.stringify(result.fresh)).not.toContain('PRIVATE_NAME');
  expect(JSON.stringify(result.fresh)).not.toContain('diagnostic-private-cursor');
});
