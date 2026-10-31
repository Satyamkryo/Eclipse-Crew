import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("account removal preserves mounted views until replacement writes finish", () => {
  const program = String.raw`
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs/promises';
    import path from 'node:path';
    import { tmpdir } from 'node:os';
    import vm from 'node:vm';
    const root = await fs.realpath(tmpdir());
    const directory = await fs.mkdtemp(path.join(root, 'eclipse-account-view-'));
    const record = {ownerId:'11111111-1111-4111-8111-111111111111',agentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',uid:20000,gid:20000,name:'ec_20000',state:'ready'};
    let expected, events, fault;
    const open = async (filename, flags) => {
      assert.ok(['/run/eclipse/passwd','/run/eclipse/group'].includes(filename));
      const kind = path.basename(filename), local = path.join(directory,kind);
      const handle = await fs.open(local,flags);
      return {
        stat:async()=>({...await handle.stat(),isFile:()=>true,uid:0,mode:0o100644}),
        readFile:(...args)=>handle.readFile(...args),
        write:async(text,position,encoding)=>{
          assert.equal(await fs.readFile(local,'utf8'),expected[kind], 'mounted view was emptied before replacement write');
          assert.equal(position,0); events[kind].push('write');
          if(fault==='throw') throw Object.assign(Error('synthetic write failure'),{code:'EIO'});
          if(fault==='short') return {bytesWritten:0};
          return handle.write(text,position,encoding);
        },
        truncate:async(size)=>{events[kind].push('truncate:'+size);return handle.truncate(size);},
        sync:async()=>{events[kind].push('sync');return handle.sync();},
        close:async()=>{events[kind].push('close');return handle.close();},
      };
    };
    try {
      const source = await fs.readFile('docker/desktop/agent-store.mjs','utf8');
      const context = vm.createContext({Buffer,process});
      const module = new vm.SourceTextModule(source+'\nexport { unpublishAccount, accountLines };',{context});
      await module.link(async(specifier)=>{
        assert.ok(specifier.startsWith('node:'));
        const actual = await import(specifier);
        const values = specifier==='node:fs/promises'?{...actual,open}:actual;
        return new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
      });
      await module.evaluate();
      const {unpublishAccount,accountLines}=module.namespace;
      const target=accountLines(record);
      const base={passwd:'root:x:0:0:Røot:/root:/bin/bash\n',group:'root:x:0:\n'};
      const peer={passwd:'ec_20001:x:20001:20001:Péer:/workspace/homes/peer:/bin/bash\n',group:'ec_20001:x:20001:\n'};
      async function fixture(contents,mode){
        expected=contents;fault=mode;events={passwd:[],group:[]};
        for(const kind of ['passwd','group']) await fs.writeFile(path.join(directory,kind),contents[kind]);
      }
      const contents=Object.fromEntries(['passwd','group'].map(kind=>[kind,base[kind]+target[kind]+peer[kind]]));
      await fixture(contents);
      const before=await fs.stat(path.join(directory,'passwd'));
      await unpublishAccount(record);
      for(const kind of ['passwd','group']){
        const remaining=base[kind]+peer[kind];
        assert.equal(await fs.readFile(path.join(directory,kind),'utf8'),remaining);
        assert.deepEqual(events[kind],['write','truncate:'+Buffer.byteLength(remaining),'sync','close']);
      }
      assert.equal((await fs.stat(path.join(directory,'passwd'))).ino,before.ino,'mounted inode preserved');
      await fixture(target); await unpublishAccount(record);
      for(const kind of ['passwd','group']){
        assert.equal(await fs.readFile(path.join(directory,kind),'utf8'),'');
        assert.deepEqual(events[kind],['truncate:0','sync','close']);
      }
      await fixture(base); await unpublishAccount(record);
      for(const kind of ['passwd','group']){
        assert.equal(await fs.readFile(path.join(directory,kind),'utf8'),base[kind]);
        assert.deepEqual(events[kind],['close']);
      }
      for(const mode of ['throw','short']){
        await fixture(contents,mode);
        await assert.rejects(unpublishAccount(record),error=>error.code===(mode==='throw'?'EIO':'account_write_failed'));
        assert.deepEqual(events.passwd,['write','close']);
        assert.deepEqual(events.group,[]);
        for(const kind of ['passwd','group']) assert.equal(await fs.readFile(path.join(directory,kind),'utf8'),contents[kind]);
      }
    } finally {
      const resolved=await fs.realpath(directory);
      assert.equal(path.dirname(resolved),root);assert.ok(path.basename(resolved).startsWith('eclipse-account-view-'));
      await fs.rm(resolved,{recursive:true,force:true});
    }
  `;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", program],
    { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
