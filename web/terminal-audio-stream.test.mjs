import assert from "node:assert/strict";
import test from "node:test";
import { TerminalAudioPlayer } from "./terminal-audio.mjs";
import { streamFrames } from "./terminal-audio-stream.mjs";

const flush = async () => { for (let i=0;i<4;i++) await new Promise(resolve => setImmediate(resolve)); };
const base = { type:"terminal-audio", epoch:"shell", id:"music", token:"generation" };
const start = (extra={}) => ({ ...base, action:"stream-start", format:"opus", channels:2, bufferMs:500, preSkip:0, ...extra });
const data = (sequence, count=5, extra={}) => ({ ...base, action:"stream-data", sequence, data:Buffer.from(Array.from({length:count},()=>[2,0,0xfc,0]).flat()).toString("base64"), ...extra });
const end = sequence => ({ ...base, action:"stream-end", sequence });

function fixture({ deferred=false }={}) {
  const nodes=[], statuses=[], pending=[], setups=[], decoders=[];
  const context = { currentTime:10, state:"running", destination:{}, resume:async()=>{}, close:async()=>{},
    createGain:()=>({gain:{value:1},connect(){},disconnect(){}}),
    createBuffer:(channels,length,rate)=>({duration:length/rate,copyToChannel(){}}),
    createBufferSource(){ const node={buffer:null,connect(){},disconnect(){},start(time){this.time=time;this.started=true;},stop(){this.stopped=true;}}; nodes.push(node); return node; },
  };
  const player = new TerminalAudioPlayer({createContext:()=>context, createStreamDecoder:async options=>{
    setups.push(options);
    const decoder={freed:false,free:async()=>{decoder.freed=true;},decodeFrames:frames=>{
      const result={samplesDecoded:frames.length*960,sampleRate:48000,channelData:Array.from({length:options.channels},()=>new Float32Array(frames.length*960)),errors:[]};
      if(deferred) return new Promise((resolve,reject)=>pending.push({resolve,reject,result})); return Promise.resolve(result);
    }}; decoders.push(decoder); return decoder;
  }});
  player.attach("a",{onStatus:status=>statuses.push(status)});
  return {player,context,nodes,statuses,pending,setups,decoders};
}

test("stream buffering is carried by the protocol and EOF drains short tracks",async()=>{
  for(const target of [100,500,2000]) {
    const f=fixture(); await f.player.enable(); f.player.receive("a",start({bufferMs:target}));
    for(let seq=0;seq<target/100-1;seq++) { f.player.receive("a",data(seq)); await flush(); assert.equal(f.nodes.length,0); }
    f.player.receive("a",data(target/100-1)); await flush(); assert.ok(f.nodes.length>0);
    assert.ok(f.nodes[0].time>=f.context.currentTime);
    f.player.dispose(); assert.equal(f.player.decodedBytes,0);
  }
  const f=fixture(); await f.player.enable(); f.player.receive("a",start()); f.player.receive("a",data(0,1)); await flush();
  assert.equal(f.nodes.length,0); f.player.receive("a",end(1)); await flush(); assert.equal(f.nodes.length,1);
  f.nodes[0].onended(); assert.equal(f.player.playing.length,0); assert.equal(f.player.decodedBytes,0); assert.equal(f.decoders[0].freed,true);
});

test("disabled and muted streams retain only setup and join future packets",async()=>{
  const f=fixture(); f.player.receive("a",start({bufferMs:100,preSkip:312}));
  f.player.receive("a",data(0)); assert.equal(f.player.context,null); assert.equal(f.setups.length,0);
  await f.player.enable(); f.player.receive("a",data(1)); await flush();
  assert.equal(f.setups[0].preSkip,0); assert.equal(f.nodes.length,1);
  f.player.setMuted("a",true); assert.ok(f.nodes[0].stopped);
  f.player.receive("a",data(2)); assert.equal(f.player.playing.length,0);
  f.player.setMuted("a",false); assert.equal(f.player.playing.length,0);
  f.player.receive("a",data(3)); await flush(); assert.equal(f.nodes.length,2);
  f.player.disable(); f.player.receive("a",data(4)); await f.player.enable();
  f.player.receive("a",data(5)); await flush(); assert.equal(f.nodes.length,3); f.player.dispose();
});

test("new subscribers join at an arbitrary live sequence and old generations are ignored",async()=>{
  const f=fixture(); await f.player.enable();
  f.player.receive("a",start({sequence:42,bufferMs:100})); f.player.receive("a",data(42)); await flush();
  assert.equal(f.nodes.length,1); f.player.receive("a",start({token:"new",bufferMs:100}));
  f.player.receive("a",{...base,action:"stream-abort"}); assert.equal(f.player.terminals.get("a").streamHeads.size,1);
  f.player.receive("a",data(0,5,{token:"new"})); await flush(); assert.equal(f.nodes.length,2); f.player.dispose();
});

test("stop/mute/reset/disconnect/disposal prevent late stream decoding",async()=>{
  for(const cancel of [p=>p.stop("a"),p=>p.setMuted("a",true),p=>p.receive("a",{type:"terminal-audio",epoch:"shell",action:"reset"}),p=>p.disconnect("a"),p=>p.dispose()]) {
    const f=fixture({deferred:true}); await f.player.enable(); f.player.receive("a",start({bufferMs:100})); f.player.receive("a",data(0)); await flush();
    cancel(f.player); f.pending[0].resolve(f.pending[0].result); await flush();
    assert.equal(f.nodes.length,0); assert.equal(f.player.decodedBytes,0); assert.equal(f.player.decoding,0); f.player.dispose();
  }
  const f=fixture(); await f.player.enable(); f.player.receive("a",start({bufferMs:100})); f.player.receive("a",data(0));
  f.player.dispose(); await flush(); assert.equal(f.setups.length,0); assert.equal(f.player.decoding,0);
});

test("stream decoding shares two slots with bounded queues and isolates malformed packets",async()=>{
  const f=fixture({deferred:true}); await f.player.enable();
  for(let pane=0;pane<3;pane++) { const key=String(pane); f.player.attach(key); f.player.receive(key,start({bufferMs:100})); f.player.receive(key,data(0)); }
  await flush(); assert.equal(f.pending.length,2); assert.equal(f.player.decoding,2);
  f.pending[0].resolve(f.pending[0].result); await flush(); assert.equal(f.pending.length,3);
  for(const job of f.pending.slice(1)) job.resolve(job.result); await flush();
  f.player.receive("0",data(2)); assert.equal(f.player.terminals.get("0").clips.size,0);
  f.player.receive("1",data(1,5,{data:"!!!"})); assert.equal(f.player.terminals.get("1").clips.size,0);
  assert.equal(f.player.terminals.get("2").clips.size,1); f.player.dispose();
  assert.throws(()=>streamFrames("")); assert.throws(()=>streamFrames(Buffer.from([2,0,0,0]).toString("base64")));
});

test("stream queues and scheduled PCM cannot grow with file length",async()=>{
  const f=fixture({deferred:true}); await f.player.enable(); f.player.receive("a",start());
  for(let seq=0;seq<45;seq++) f.player.receive("a",data(seq)); await flush();
  assert.equal(f.player.playing.length,0); assert.equal(f.player.streams.waitingBytes,0);
  for(const job of f.pending) job.resolve(job.result); await flush(); assert.equal(f.player.decoding,0); f.player.dispose();
  const fast=fixture(); await fast.player.enable(); fast.player.receive("a",start({bufferMs:100}));
  for(let seq=0;seq<45;seq++) { fast.player.receive("a",data(seq)); await flush(); }
  assert.equal(fast.player.playing.length,0); assert.equal(fast.player.decodedBytes,0); fast.player.dispose();
});

test("stream voices share clip limits and eviction prevents future restart",async()=>{
  const f=fixture(); await f.player.enable();
  for(let i=0;i<5;i++) { f.player.attach(String(i)); for(let voice=0;voice<4;voice++) {
    f.player.receive(String(i),start({id:String(voice),bufferMs:100})); f.player.receive(String(i),data(0,5,{id:String(voice)}));
  } await flush(); }
  assert.equal(f.player.playing.length,16);
  assert.equal(f.player.terminals.get("0").streamHeads.size,0);
  f.player.receive("0",data(1,5,{id:"0"})); await flush(); assert.equal(f.player.playing.length,16); f.player.dispose();
});
