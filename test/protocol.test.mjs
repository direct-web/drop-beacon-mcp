import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
test('MCP starts and negotiates with no database credentials; unknown tools fail closed',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{PATH:process.env.PATH},stderr:'pipe'});
 const client=new Client({name:'security-regression',version:'1.0.0'});
 try {await client.connect(transport);const result=await client.listTools();assert.equal(result.tools.length,4);
 for(const t of result.tools)assert.equal(t.annotations.readOnlyHint,true);
 const denied=await client.callTool({name:'get_market_trends',arguments:{}});assert.equal(denied.isError,true);
 } finally {await client.close();}
});
test('HTTP rejects browser origins, oversized bodies, batch requests and non-POST methods',async()=>{
 const reserv=createServer();await new Promise(r=>reserv.listen(0,'127.0.0.1',r));const port=reserv.address().port;await new Promise(r=>reserv.close(r));
 const child=spawn(process.execPath,['dist/index.js'],{env:{PATH:process.env.PATH,PORT:String(port)},stdio:['ignore','ignore','pipe']});
 const url=`http://127.0.0.1:${port}`;
 try {
  let ready=false;for(let n=0;n<80;n++){try{const r=await fetch(url+'/health');if(r.ok){ready=true;assert.equal((await r.json()).dataSource,'public-api');break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready);
  assert.equal((await fetch(url+'/mcp')).status,405);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{'content-type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'[]'})).status,400);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'a'.repeat(65537)})).status,413);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
