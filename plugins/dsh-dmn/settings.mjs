import{z}from'zod';import{join,isAbsolute}from'node:path';import{homedir}from'node:os';import{existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,unlinkSync,lstatSync}from'node:fs';import{randomUUID}from'node:crypto';
const path=z.string().min(1).max(2048).refine(x=>isAbsolute(x)&&!x.startsWith('\\\\')&&!x.includes('\0'));
const schema=z.strictObject({schema:z.literal(1),revision:z.number().int().positive(),database:path,logDirectory:path,credentialRef:z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),sharedRoutes:z.tuple([z.strictObject({provider:z.string().trim().min(1).max(256),model:z.string().trim().min(1).max(256)}),z.strictObject({provider:z.string().trim().min(1).max(256),model:z.string().trim().min(1).max(256)})]).optional(),models:z.tuple([z.enum(['deepseek-flash','deepseek-v4-pro']),z.enum(['deepseek-flash','deepseek-v4-pro'])])});
export class NativeSettings{
 constructor(directory=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'dmn')){this.directory=directory;this.path=join(directory,'settings.json');this.initial={schema:1,revision:1,database:join(directory,'instances/default/queue.sqlite'),logDirectory:join(directory,'logs'),credentialRef:'DMN_DEEPSEEK_API_KEY',models:['deepseek-flash','deepseek-v4-pro']};this.read();}
 validate(value){const result=schema.safeParse(value);if(!result.success)throw Error('VALIDATION');return result.data;}
 read(){if(!existsSync(this.path))return structuredClone(this.initial);const s=lstatSync(this.path);if(s.isSymbolicLink()||s.nlink>1)throw Error('FORBIDDEN');try{return this.validate(JSON.parse(readFileSync(this.path,'utf8')));}catch{throw Error('INVALID_SAVED_SETTINGS');}}
 save(input){const next=this.validate(input);mkdirSync(this.directory,{recursive:true});if(lstatSync(this.directory).isSymbolicLink())throw Error('FORBIDDEN');let fd;try{fd=openSync(this.path+'.lock','wx',0o600);}catch{throw Error('CONFLICT');}
  try{const current=this.read();if(current.revision!==next.revision)throw Error('CONFLICT');if(next.revision>=Number.MAX_SAFE_INTEGER)throw Error('VALIDATION');next.revision++;
   if(existsSync(this.path+'.previous')&&lstatSync(this.path+'.previous').isSymbolicLink())throw Error('FORBIDDEN');writeFileSync(this.path+'.previous',JSON.stringify(current,null,2),{mode:0o600});const temporary=this.path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,this.path);return next;
  }finally{closeSync(fd);unlinkSync(this.path+'.lock');}
 }
}
