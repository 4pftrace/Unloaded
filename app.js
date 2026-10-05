import Peer from "https://esm.sh/peerjs@1.5.4?bundle";

const CLEAN_GOAL=40, RUINED_GOAL=20, ROUND_MS=90000, SAB_COOLDOWN=5000;
let peer, hostConn, isHost=false, myId="", myName="", roomCode="", joined=false, roleSeen=false, demoMode=false, botTimer=null;
let connections=new Map(), state=null, tickTimer=null, spawnTimer=null;

const $=id=>document.getElementById(id);
const screens=[...document.querySelectorAll(".screen")];
const show=id=>{screens.forEach(s=>s.classList.remove("active"));$(id).classList.add("active")};
const msg=(id,t)=>$(id).textContent=t||"";
const roomPeer=c=>"laundry-sabotage-"+c.toLowerCase();
const makeCode=()=>{
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="";
  for(let i=0;i<5;i++)out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
};
const cleanName=()=>$("nameInput").value.trim().slice(0,16);
const me=()=>state?.players?.find(p=>p.id===myId);
const esc=s=>String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));

function makePeer(id){
  return new Promise((resolve,reject)=>{
    peer=new Peer(id,{debug:2});
    const timeout=setTimeout(()=>reject(new Error("Peer server timeout")),12000);
    let opened=false;
    peer.on("open",()=>{
      opened=true;
      clearTimeout(timeout);
      resolve();
    });
    peer.on("disconnected",()=>{
      if(!peer.destroyed){
        try{peer.reconnect()}catch{}
      }
    });
    peer.on("error",err=>{
      console.error("Peer error:",err);
      if(err?.type==="peer-unavailable"){
        msg("homeStatus","Room not found. Make sure the host still has the room open and check the 5-character code.");
      }else if(err?.type==="unavailable-id"){
        msg("homeStatus","That room code is already active. Create a new room.");
      }else if(err?.type==="network"||err?.type==="server-error"||err?.type==="socket-error"){
        msg("homeStatus","Could not reach the multiplayer service. Try Wi-Fi/cellular again.");
      }else if(err?.type==="webrtc"){
        msg("homeStatus","This network blocked the direct game connection. Try another Wi-Fi or cellular connection.");
      }
      if(!opened)reject(err);
    });
  });
}
const sendHost=d=>hostConn?.open&&hostConn.send(d);
function emitState(){if(!isHost)return;connections.forEach(c=>c.open&&c.send({type:"state",state}));renderState()}

async function createRoom(){
  myName=cleanName();
  if(!myName)return msg("homeStatus","Enter the name or nickname you want other players to see.");
  roomCode=makeCode();myId=roomPeer(roomCode);isHost=true;msg("homeStatus","Opening room...");
  try{
    await makePeer(myId);
    state={status:"lobby",code:roomCode,hostId:myId,players:[{id:myId,name:myName,ready:true}],clean:0,ruined:0,ruinedItems:[],winner:null,saboteurId:null,roundStart:null,item:null,sabReadyAt:0,itemSeq:0,soapUsed:false,soapUsedBy:null,notice:"",noticeUntil:0};
    peer.on("connection",acceptConnection);joined=true;enterLobby();
  }catch(e){msg("homeStatus","Couldn't create room. Try again.")}
}
function acceptConnection(conn){
  const sendHello=()=>{
    if(state.players.length>=6){
      conn.send({type:"reject",reason:"Room is full."});
      setTimeout(()=>conn.close(),250);
      return;
    }
    conn.send({type:"hello",hostId:myId,code:roomCode});
  };
  connections.set(conn.peer,conn);
  conn.on("data",d=>handleHostMessage(conn,d));
  conn.on("close",()=>{connections.delete(conn.peer);state.players=state.players.filter(p=>p.id!==conn.peer);emitState()});
  conn.on("error",err=>console.error("Incoming connection error:",err));
  if(conn.open)sendHello();else conn.on("open",sendHello);
}
function handleHostMessage(conn,d){
  if(!d||typeof d!=="object")return;
  if(d.type==="join"){
    if(state.status!=="lobby")return conn.send({type:"reject",reason:"Round already started."});
    if(!state.players.some(p=>p.id===conn.peer))state.players.push({id:conn.peer,name:String(d.name||"Player").slice(0,16),ready:false});
    emitState();
  }else if(d.type==="ready"){
    const p=state.players.find(p=>p.id===conn.peer);if(p){p.ready=!!d.ready;emitState()}
  }else if(d.type==="sort")hostSort(conn.peer,d.bin);
  else if(d.type==="pull")hostPull(conn.peer);
  else if(d.type==="sabotage")hostSabotage(conn.peer,d.kind);
  else if(d.type==="soap")hostSoap(conn.peer);
}
async function joinRoom(){
  myName=cleanName();roomCode=$("roomInput").value.trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(!myName)return msg("homeStatus","Enter the name or nickname you want other players to see.");
  if(roomCode.length<5)return msg("homeStatus","Enter the 5-character room code from the host.");
  myId="player-"+crypto.randomUUID();isHost=false;msg("homeStatus","Joining...");
  try{
    await makePeer(myId);
    hostConn=peer.connect(roomPeer(roomCode),{reliable:true,serialization:"json"});
    hostConn.on("data",handleClientMessage);
    hostConn.on("open",()=>{
      msg("homeStatus","Connected — joining room...");
      hostConn.send({type:"join",name:myName});
    });
    hostConn.on("error",err=>{
      console.error("Host connection error:",err);
      msg("homeStatus","Could not connect to that room. Make sure the host is still on the lobby screen.");
    });
    hostConn.on("close",()=>{
      if(joined)msg("gameStatus","Disconnected from host.");
      else msg("homeStatus","Connection closed before joining.");
    });
    setTimeout(()=>{
      if(!joined){
        msg("homeStatus","Could not join. Re-check the room code and keep the host's tab open.");
        try{hostConn.close()}catch{}
      }
    },10000);
  }catch(e){msg("homeStatus","Connection failed. Try again.")}
}
function handleClientMessage(d){
  if(!d||typeof d!=="object")return;
  if(d.type==="hello"){
    joined=true;roomCode=d.code||roomCode;enterLobby();
  }else if(d.type==="reject"){
    msg("homeStatus",d.reason||"Couldn't join.");show("home");
  }else if(d.type==="state"){
    state=d.state;
    if(!joined){joined=true;roomCode=state.code||roomCode;enterLobby()}
    renderState();
  }
}
function enterLobby(){$("lobbyCode").textContent=roomCode;$("gameCode").textContent=roomCode;show("lobby");renderState()}
function renderState(){
  if(!state)return;
  $("lobbyCode").textContent=state.code;$("gameCode").textContent=state.code;renderPlayers();
  if(state.status==="lobby"){
    roleSeen=false;show("lobby");
  }else if(state.status==="playing"&&!roleSeen)showRole();
  else if(state.status==="playing"&&roleSeen){show("game");renderGame()}
  else if(state.status==="ended")renderEnd();
}
function renderPlayers(){
  $("lobbyPlayers").innerHTML=state.players.map(p=>'<div class="player-row '+(p.ready?'ready':'')+'"><span>'+esc(p.name)+(p.id===state.hostId?' 👑':'')+'</span><strong>'+(p.ready?'READY':'WAITING')+'</strong></div>').join("");
  $("startBtn").classList.toggle("hidden",!isHost);
  const p=me();if(p)$("readyBtn").textContent=p.ready?"NOT READY":"I'M READY";
}
function toggleReady(){
  const p=me();if(!p)return;
  if(isHost){p.ready=!p.ready;emitState()}else sendHost({type:"ready",ready:!p.ready});
}
function startRound(){
  if(!isHost)return;
  if(state.players.length<2)return msg("lobbyStatus","You need at least 2 players.");
  if(state.players.some(p=>!p.ready))return msg("lobbyStatus","Everyone must be ready.");
  const sab=state.players[Math.floor(Math.random()*state.players.length)];
  state.players.forEach(p=>p.role=p.id===sab.id?"saboteur":"crew");
  Object.assign(state,{saboteurId:sab.id,clean:0,ruined:0,ruinedItems:[],winner:null,roundStart:Date.now(),sabReadyAt:Date.now()+3000,status:"playing",item:null,itemSeq:0,soapUsed:false,soapUsedBy:null,notice:"",noticeUntil:0});
  roleSeen=false;emitState();startHostLoops();
}
function startHostLoops(){
  clearInterval(tickTimer);clearInterval(spawnTimer);clearInterval(botTimer);
  spawnItem();
  tickTimer=setInterval(hostTick,250);
  spawnTimer=setInterval(()=>{if(state.status==="playing"&&!state.item)spawnItem()},650);
  if(demoMode)startBotLoop();
}
function randomItem(){
  const groups={whites:["White Sock 🧦","White Shirt 👕","White Towel","White Sheet"],darks:["Black Sock 🧦","Dark Hoodie","Black Shirt 👕","Dark Jeans 👖"],colors:["Red Sock 🧦","Blue Shirt 👕","Green Towel","Yellow Shorts"]};
  const types=Object.keys(groups),type=types[Math.floor(Math.random()*types.length)],arr=groups[type];
  return{id:++state.itemSeq,type,label:arr[Math.floor(Math.random()*arr.length)],baseLabel:null,contaminated:false,sabotageLabel:"",spawnedAt:Date.now(),expiresAt:Date.now()+12000};
}
function spawnItem(){if(!isHost||state.status!=="playing"||state.item)return;state.item=randomItem();emitState()}
function hostTick(){
  if(state.status!=="playing")return;
  if(Date.now()-state.roundStart>=ROUND_MS)return finishByTimer();
  if(state.item&&Date.now()>=state.item.expiresAt){
    if(state.item.contaminated){
      state.ruined++;
      state.ruinedItems=state.ruinedItems||[];
      state.ruinedItems.push(state.item.sabotageLabel||state.item.label||"Ruined item");
    }
    state.item=null;checkWin();emitState();
  }
}
function hostSort(playerId,bin){
  if(state.status!=="playing"||!state.item)return;
  const p=state.players.find(x=>x.id===playerId);if(!p||p.role!=="crew")return;
  if(state.item.contaminated){
    state.ruined++;
    state.ruinedItems=state.ruinedItems||[];
    state.ruinedItems.push(state.item.sabotageLabel||state.item.label||"Ruined item");
  }else if(bin===state.item.type)state.clean++;else state.clean=Math.max(0,state.clean-1);
  state.item=null;checkWin();emitState();
}
function hostPull(playerId){
  if(state.status!=="playing"||!state.item)return;
  const p=state.players.find(x=>x.id===playerId);if(!p||p.role!=="crew")return;
  if(!state.item.contaminated)state.clean=Math.max(0,state.clean-1);
  state.item=null;emitState();
}
function hostSabotage(playerId,kind){
  if(state.status!=="playing"||!state.item||state.item.contaminated||Date.now()<state.sabReadyAt)return;
  const p=state.players.find(x=>x.id===playerId);if(!p||p.role!=="saboteur")return;
  const labels={"red-in-whites":"Red sock hidden in WHITES","white-in-darks":"White sock hidden in DARKS","color-in-whites":"Colored shirt hidden in WHITES"};
  state.item.baseLabel=state.item.baseLabel||state.item.label;
  state.item.contaminated=true;
  state.item.sabotageLabel=labels[kind]||"Mismatched clothing";
  if(kind==="red-in-whites")state.item.label=state.item.baseLabel+" + RED SOCK 🧦";
  else if(kind==="white-in-darks")state.item.label=state.item.baseLabel+" + WHITE SOCK 🧦";
  else if(kind==="color-in-whites")state.item.label=state.item.baseLabel+" + COLOR SHIRT 👕";
  state.sabReadyAt=Date.now()+SAB_COOLDOWN;
  emitState();
}
function hostSoap(playerId){
  if(state.status!=="playing"||!state.item||!state.item.contaminated||state.soapUsed)return;
  const p=state.players.find(x=>x.id===playerId);if(!p||p.role!=="crew")return;
  state.soapUsed=true;
  state.soapUsedBy=p.name;
  state.clean++;
  state.notice="🫧 "+p.name+" used the Soap Save — contaminated load cleaned!";
  state.noticeUntil=Date.now()+3000;
  state.item=null;
  checkWin();
  emitState();
}
function checkWin(){if(state.clean>=CLEAN_GOAL)endGame("crew");else if(state.ruined>=RUINED_GOAL)endGame("saboteur")}
function finishByTimer(){const a=state.clean/CLEAN_GOAL,b=state.ruined/RUINED_GOAL;endGame(a>b?"crew":b>a?"saboteur":"draw")}
function endGame(w){
  state.status="ended";state.winner=w;state.item=null;
  clearInterval(tickTimer);clearInterval(spawnTimer);clearInterval(botTimer);
  emitState();
}
function showRole(){
  const p=me();if(!p)return;const sab=p.role==="saboteur";
  $("roleCard").classList.toggle("sab",sab);$("roleIcon").textContent=sab?"🕵️":"🧺";
  $("roleTitle").textContent=sab?"YOU ARE THE SABOTEUR":"YOU ARE LAUNDRY CREW";
  $("roleText").textContent=sab?"Secretly contaminate loads. Ruin 20 items before the Crew finishes 40. Your sabotage has a short cooldown, so choose your moment.":"Sort each item correctly. Pull suspicious items before they reach the washer. Your whole Crew also shares ONE Soap Save that can instantly clean a contaminated item.";
  show("role");
}
function enterGame(){roleSeen=true;show("game");renderGame()}
function renderGame(){
  $("cleanCount").textContent=state.clean;$("ruinedCount").textContent=state.ruined;
  $("timer").textContent=Math.max(0,Math.ceil((ROUND_MS-(Date.now()-state.roundStart))/1000));
  const item=state.item,g=$("garment");
  if(item){
    g.textContent=item.label;g.classList.remove("empty");g.classList.toggle("suspicious",item.contaminated);$("suspicionBanner").classList.toggle("hidden",!item.contaminated);
  }else{
    g.textContent="NEXT LOAD...";g.className="garment empty";$("suspicionBanner").classList.add("hidden");
  }
  const sab=me()?.role==="saboteur";
  $("crewPanel").classList.toggle("hidden",sab);$("saboteurPanel").classList.toggle("hidden",!sab);
  const cd=Math.max(0,Math.ceil((state.sabReadyAt-Date.now())/1000));
  $("cooldownText").textContent=cd?"Sabotage cooling down: "+cd+"s":"Sabotage ready.";

  const soapBtn=$("soapBtn");
  if(sab){
    soapBtn.disabled=true;
    soapBtn.innerHTML='SOAP<br><small>CREW ONLY</small>';
  }else if(state.soapUsed){
    soapBtn.disabled=true;
    soapBtn.innerHTML='SOAP USED<br><small>BY '+esc(state.soapUsedBy||"CREW")+'</small>';
  }else if(item?.contaminated){
    soapBtn.disabled=false;
    soapBtn.innerHTML='🫧 SOAP SAVE<br><small>USE NOW</small>';
  }else{
    soapBtn.disabled=true;
    soapBtn.innerHTML='SOAP SAVE<br><small>1 USE LEFT</small>';
  }

  $("avatars").innerHTML=state.players.map(p=>'<div class="avatar">🧑‍🔧<span>'+esc(p.name)+'</span></div>').join("");
  $("gamePlayers").innerHTML=state.players.map(p=>'<span class="mini-chip">'+esc(p.name)+(p.id===state.hostId?' 👑':'')+'</span>').join("");
  const ruinedItems=state.ruinedItems||[];
  $("ruinedListCount").textContent=ruinedItems.length+" item"+(ruinedItems.length===1?"":"s");
  $("ruinedList").innerHTML=ruinedItems.length?ruinedItems.slice(-12).map(x=>'<span class="ruined-chip">'+esc(x)+'</span>').join(""):'<span class="ruined-empty">Nothing ruined yet.</span>';
  msg("gameStatus",state.noticeUntil>Date.now()?state.notice:"");
}
const doSort=bin=>isHost?hostSort(myId,bin):sendHost({type:"sort",bin});
const doPull=()=>isHost?hostPull(myId):sendHost({type:"pull"});
const doSab=kind=>isHost?hostSabotage(myId,kind):sendHost({type:"sabotage",kind});
const doSoap=()=>isHost?hostSoap(myId):sendHost({type:"soap"});
function renderEnd(){
  const sab=state.players.find(p=>p.id===state.saboteurId);
  $("winnerTitle").textContent=state.winner==="crew"?"THE CREW SAVED THE LAUNDRY!":state.winner==="saboteur"?"THE SABOTEUR RUINED THE LOAD!":"IT'S A DRAW!";
  $("endScore").textContent="Clean "+state.clean+"/40 • Ruined "+state.ruined+"/20";
  $("saboteurName").textContent=sab?.name||"Unknown";
  $("againBtn").textContent="PLAY AGAIN — SAME ROOM";
  $("againBtn").classList.toggle("hidden",!isHost);
  show("end");
}
function playAgain(){
  if(!isHost)return;
  if(demoMode){startDemo();return}
  state.status="lobby";
  state.players.forEach(p=>{p.ready=p.id===state.hostId;p.role=null});
  Object.assign(state,{clean:0,ruined:0,ruinedItems:[],winner:null,saboteurId:null,roundStart:null,item:null,sabReadyAt:0,itemSeq:0,soapUsed:false,soapUsedBy:null,notice:"",noticeUntil:0});
  roleSeen=false;
  msg("lobbyStatus","Round reset — ready up for the rematch!");
  emitState();
}
function leave(){try{peer?.destroy()}catch{}location.reload()}

$("createBtn").onclick=createRoom;$("joinBtn").onclick=joinRoom;$("readyBtn").onclick=toggleReady;$("startBtn").onclick=startRound;
$("roleReadyBtn").onclick=enterGame;$("pullBtn").onclick=doPull;$("soapBtn").onclick=doSoap;$("againBtn").onclick=playAgain;$("lobbyHomeBtn").onclick=leave;$("endHomeBtn").onclick=leave;
document.querySelectorAll("[data-sort]").forEach(b=>b.onclick=()=>doSort(b.dataset.sort));
document.querySelectorAll("[data-sab]").forEach(b=>b.onclick=()=>doSab(b.dataset.sab));
const dialog=$("rulesDialog");$("rulesBtn").onclick=()=>dialog.showModal();$("closeRulesBtn").onclick=()=>dialog.close();
setInterval(()=>{if(state?.status==="playing"){renderGame();if(isHost)checkWin()}},250);

const params=new URLSearchParams(location.search);
const inviteRoom=params.get("room");
if(inviteRoom){$("roomInput").value=inviteRoom.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5)}
$("roomInput").addEventListener("input",e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5)});

$("copyInviteBtn").onclick=async()=>{
  if(!state?.code)return;
  const url=new URL(location.href);url.searchParams.set("room",state.code);
  try{
    await navigator.clipboard.writeText(url.toString());
    msg("lobbyStatus","Invite link copied!");
  }catch{
    msg("lobbyStatus","Invite: "+url.toString());
  }
};

function startDemo(){
  myName=cleanName()||"You";
  demoMode=true;isHost=true;joined=true;roomCode="DEMO";myId="demo-player";
  const playerRole=Math.random()<0.5?"crew":"saboteur";
  const botRole=playerRole==="crew"?"saboteur":"crew";
  state={
    status:"playing",code:"DEMO",hostId:myId,
    players:[{id:myId,name:myName,ready:true,role:playerRole},{id:"bot-player",name:"Laundry Bot",ready:true,role:botRole}],
    clean:0,ruined:0,ruinedItems:[],winner:null,saboteurId:playerRole==="saboteur"?myId:"bot-player",roundStart:Date.now(),item:null,sabReadyAt:Date.now()+3000,itemSeq:0,soapUsed:false,soapUsedBy:null,notice:"",noticeUntil:0
  };
  roleSeen=false;$("gameCode").textContent="DEMO";showRole();startHostLoops();
}
function startBotLoop(){
  clearInterval(botTimer);
  botTimer=setInterval(()=>{
    if(!demoMode||!state||state.status!=="playing")return;
    const bot=state.players.find(p=>p.id==="bot-player");if(!bot)return;
    if(bot.role==="saboteur"){
      if(state.item&&!state.item.contaminated&&Date.now()>=state.sabReadyAt&&Date.now()-state.item.spawnedAt>3500&&Math.random()<0.28){
        const kinds=["red-in-whites","white-in-darks","color-in-whites"];
        hostSabotage("bot-player",kinds[Math.floor(Math.random()*kinds.length)]);
      }
    }else{
      if(!state.item)return;
      const age=Date.now()-state.item.spawnedAt;if(age<3000)return;
      if(state.item.contaminated){
        if(Math.random()<0.38)hostPull("bot-player");
      }else if(Math.random()<0.55){
        const correct=Math.random()<0.88;
        let bin=state.item.type;
        if(!correct){
          const bins=["whites","darks","colors"].filter(x=>x!==state.item.type);
          bin=bins[Math.floor(Math.random()*bins.length)];
        }
        hostSort("bot-player",bin);
      }
    }
  },1800);
}
$("demoBtn").onclick=startDemo;
