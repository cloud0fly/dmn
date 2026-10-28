import {nativeRequest} from './native-client.ts';
import {nativeOwnership} from './native-instance.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseNodes, parsePolicy, readYaml } from './contracts.ts';
import { DmnError, fail } from './errors.ts';
import { DmnStore } from './store.ts';
import { z } from 'zod';
import { checkedMemory } from './memory-contracts.ts';

const [command, ...args] = process.argv.slice(2);
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
try {
  switch (command) {
    case 'client':{
      if(args.length<2||args.length>3)fail('VALIDATION','client <database> <method> [request.json]');
      emit(await nativeRequest(args[0]!,args[1]!,args[2]?JSON.parse(readFileSync(args[2],'utf8')):{}));break;
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write('DMN P5 — bounded independent roots and controlled recovery\n\n' +
        '  validate <nodes.yaml> <policy.yaml>   Validate configuration; no runtime is started\n' +
        '  init <database.sqlite>               Create/migrate a dedicated DMN database\n' +
        '  status <database.sqlite>             Read queue counts without modifying the database\n' +
        '  run <nodes.yaml> <topic.json> <db>    Start one bounded topic using DEEPSEEK_API_KEY\n' +
        '  topic <db> <id> <status|pause|resume|close>  Local topic controls\n' +
        '  pump <db>                           Process authorized work and finite retry timers\n' +
        '  inspect <db> <turn-id>              Read completion proof; no effects or inference\n' +
        '  recover <db>                       Quarantine expired leases, never replay them\n' +
        '  reconcile <db> <turn-id> [drop <approval.json>]  Apply proof or explicitly abandon\n' +
        '  metrics <db> [topic-id]             Read operational and token accounting\n' +
        '  backup <db> <new-directory>         Stopped database + Runtime backup\n' +
        '  backup-verify <directory>           Verify complete backup and compatibility\n' +
        '  restore <directory> <original-db>   Restore to an empty original location\n' +
        '  queue <db>                          Read attempt/unknown/dead-letter metadata\n' +
        '  memory <db> <node> <action> [json]  Local owner-bound memory management; see P1 report\n');
      break;
    case 'backup':
    case 'backup-verify':
    case 'restore':{
      if(args.length!==(command==='backup-verify'?1:2))fail('VALIDATION','Invalid backup operation arguments.');
      const {createBackup,verifyBackup,restoreBackup}=await import('./backup.ts');
      if(command==='backup')emit(await createBackup(args[0]!,args[1]!));
      else if(command==='restore')emit(await restoreBackup(args[0]!,args[1]!));
      else{const {manifest,...summary}=await verifyBackup(args[0]!);emit({...summary,verified:true});}
      break;
    }
    case 'topic':
    case 'queue':
    case 'pump':
    case 'inspect':
    case 'recover':
    case 'metrics':
    case 'reconcile': {
      const expected=command==='topic'?3:['reconcile','inspect'].includes(command)?2:1;
      if(args.length<expected||args.length>(command==='reconcile'?4:command==='metrics'?2:expected))fail('VALIDATION','Invalid local control arguments.');
      const path=resolve(args[0]!);if(!existsSync(path))fail('NOT_FOUND','Database does not exist.');
      if(nativeOwnership(path)){
        if(command==='reconcile'&&args.length!==2)fail('FORBIDDEN','Use the owning Desktop maintenance route, or stop it before offline drop.');
        const method=command==='topic'?(args[2]==='status'?'topicState':args[2]!):({inspect:'proof'} as Record<string,string>)[command]??command;
        const params=command==='topic'?{topicId:args[1]}:command==='inspect'||command==='reconcile'?{turnId:args[1]}:command==='metrics'&&args[1]?{topicId:args[1]}:{};
        emit(await nativeRequest(path,method,params));break;
      }
      const store=new DmnStore(path,{readOnly:command==='inspect'||command==='metrics'||command==='queue'||(command==='topic'&&args[2]==='status')});
      try{
        const {TopicManager}=await import('./topic-manager.ts');const manager=new TopicManager(store);
        if(command==='metrics'){const {readMetrics}=await import('./operations.ts');emit(readMetrics(store,args[1]?{topicId:args[1]}:{}));}
        else if(command==='topic'){
          const id=args[1]!;
          switch(args[2]){case 'status':break;case 'pause':manager.pause(id);break;case 'resume':manager.resume(id);break;case 'close':manager.close(id);break;default:fail('VALIDATION','Unknown topic operation.');}
          emit(manager.get(id));
        }else if(command==='queue'){
          emit({nodes:store.all('SELECT node_id,status FROM model_nodes ORDER BY node_id'),deliveries:store.all('SELECT status,count(*) AS count FROM deliveries GROUP BY status'),
            unknown:store.all("SELECT turn_id,node_id,topic_id,sdk_receipt_id,attempt_number FROM model_turns WHERE status='unknown' ORDER BY rowid LIMIT 100"),
            deadLetters:store.all('SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT 100')});
        }else{
          const {DshRootRuntime}=await import('./dsh-runtime.ts');const {TopicRunner}=await import('./runner.ts');const {DmnGateway}=await import('./gateway.ts');
          const runtime=new DshRootRuntime({root:store.runtimeRoot,workspace:process.cwd()});
          const runner=new TopicRunner(store,new DmnGateway(store),runtime);
          if(command==='pump'){await runner.runUntilIdle();emit({processed:true});}
          else{
            const {RecoveryManager}=await import('./operations.ts');const recovery=new RecoveryManager(store,runtime);
            if(command==='recover')emit(recovery.quarantineExpired());
            else if(command==='inspect')emit(await recovery.inspect({turnId:args[1]}));
            else if(args.length===2)emit(await recovery.reconcile({turnId:args[1]}));
            else if(args.length===4&&args[2]==='drop'){
              let approval:unknown;try{approval=JSON.parse(readFileSync(args[3]!,'utf8'));}catch{fail('VALIDATION','A readable explicit drop approval JSON is required.');}
              const checked=z.strictObject({confirmTurnId:z.string(),reason:z.string()}).safeParse(approval);if(!checked.success)fail('VALIDATION','Drop approval requires confirmation and reason only.');
              emit(await recovery.drop({turnId:args[1],...checked.data}));
            }else fail('VALIDATION','Reconcile accepts a turn ID, or drop with explicit approval JSON.');
          }
        }
      }finally{store.close();}
      break;
    }
    case 'memory': {
      if (args.length < 3 || args.length > 4) fail('VALIDATION', 'Expected database, node, memory action and optional request JSON path.');
      const [database, owner, action, requestPath] = args;
      if (!existsSync(database!)) fail('NOT_FOUND', 'Database does not exist.');
      let request: unknown = {};
      if (requestPath) {
        try { request = JSON.parse(readFileSync(requestPath, 'utf8')); }
        catch { fail('VALIDATION', 'Memory request must be readable JSON.'); }
      }
      const { MemoryManager } = await import('./memory.ts');
      const store = new DmnStore(resolve(database!));
      try {
        const manager = new MemoryManager(store);
        const api = manager.bindNode(owner!);
        const memoryId = () => checkedMemory(z.strictObject({ memoryId: z.string().min(1).max(128) }), request).memoryId;
        switch (action) {
          case 'list': emit(api.list(request)); break;
          case 'search': emit(api.search(request)); break;
          case 'get': emit(api.get(memoryId())); break;
          case 'sources': emit(api.sources(memoryId())); break;
          case 'history': emit(api.history(memoryId())); break;
          case 'propose': emit(api.propose(request)); break;
          case 'revise': emit(api.revise(request)); break;
          case 'delete': emit(api.delete(request)); break;
          case 'archive': emit(api.archive(request)); break;
          case 'candidates': emit(api.listCandidates(request)); break;
          case 'resolve': emit(api.resolveConflict(request)); break;
          case 'identity': emit(manager.setIdentity(owner!, request)); break;
          case 'identity-delete': emit(manager.deleteIdentity(owner!, request)); break;
          default: fail('VALIDATION', 'Unknown memory action.');
        }
      } finally { store.close(); }
      break;
    }
    case 'run': {
      if (args.length !== 3) fail('VALIDATION', 'Expected nodes, bounded topic request and dedicated database paths.');
      const nodeConfig = readYaml(args[0]!);
      let request: unknown;
      try { request = JSON.parse(readFileSync(args[1]!, 'utf8')); }
      catch { fail('VALIDATION', 'Topic request must be readable JSON.'); }
      if (!process.env.DEEPSEEK_API_KEY) fail('FORBIDDEN', 'DEEPSEEK_API_KEY must be supplied in the environment.');
      const path = resolve(args[2]!);
      mkdirSync(dirname(path), { recursive: true });
      const { DshRootRuntime } = await import('./dsh-runtime.ts');
      const { startDiscussion } = await import('./discussion.ts');
      const store = new DmnStore(path);
      try {
        const result = await startDiscussion(store, nodeConfig, request, new DshRootRuntime({ root: store.runtimeRoot, workspace: process.cwd() }));
        emit(result);
        if (result.unknownTurns || result.failedTurns) process.exitCode = 1;
      } finally { store.close(); }
      break;
    }
    case 'validate': {
      if (args.length !== 2) fail('VALIDATION', 'Expected nodes and policy configuration paths.');
      const nodes = parseNodes(readYaml(args[0]!));
      parsePolicy(readYaml(args[1]!));
      emit({ valid: true, nodeCount: nodes.length, executionEnabled: false });
      break;
    }
    case 'init': {
      if (args.length !== 1) fail('VALIDATION', 'Expected a dedicated database path.');
      const path = resolve(args[0]!);
      mkdirSync(dirname(path), { recursive: true });
      const store = new DmnStore(path);
      try { emit({ initialized: true, schemaVersion: store.one<{ user_version: number }>('PRAGMA user_version')!.user_version }); }
      finally { store.close(); }
      break;
    }
    case 'status': {
      if (args.length !== 1) fail('VALIDATION', 'Expected a database path.');
      const path = resolve(args[0]!);
      if (!existsSync(path)) fail('NOT_FOUND', 'Database does not exist.');
      const db = new DmnStore(path, { readOnly: true });
      try {
        const schemaVersion = db.one<{user_version:number}>('PRAGMA user_version')!.user_version;
        if (schemaVersion !== 8) fail('STORAGE', 'Database requires an explicit supported migration.');
        const count = (sql: string) => db.one<{n:number}>(sql)!.n;
        emit({ schemaVersion, runtimeActive: count("SELECT count(*) AS n FROM model_nodes WHERE status='running'") > 0, counts: {
          nodes: count('SELECT count(*) AS n FROM model_nodes'), topics: count('SELECT count(*) AS n FROM topics'),
          messages: count('SELECT count(*) AS n FROM messages'), queuedDeliveries: count("SELECT count(*) AS n FROM deliveries WHERE status IN ('queued','retry')"),
        } });
      } finally { db.close(); }
      break;
    }
    default: fail('VALIDATION', 'Unknown command; use help.');
  }
} catch (error) {
  const safe = error instanceof DmnError ? error : new DmnError('STORAGE', 'Operation failed; details suppressed.');
  process.stderr.write(JSON.stringify({ code: safe.code, message: safe.message }) + '\n');
  process.exitCode = 1;
}
