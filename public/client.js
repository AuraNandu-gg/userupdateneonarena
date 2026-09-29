const socket=io();
const $=s=>document.querySelector(s);
const login=$("#login"), app=$("#app"), canvas=$("#game"), ctx=canvas.getContext("2d");
let me=null, room=null, keys={}, mouse={x:600,y:340,down:false}, raf=0, latest=null;

const saved=localStorage.getItem("neonArenaUsername");
const savedUserId=localStorage.getItem("neonArenaUserId");
const savedAuthToken=localStorage.getItem("neonArenaAuthToken");
if(saved) $("#username").value=saved;

function loginWithSavedAccount(){
  if(saved && savedUserId && savedAuthToken){
    socket.emit("profile:login",{username:saved,userId:savedUserId,authToken:savedAuthToken});
  }
}

function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}
function showModal(id){$("#"+id).classList.remove("hidden")}
function hideModal(id){$("#"+id).classList.add("hidden")}
function formatTime(ms){const s=Math.max(0,Math.ceil(ms/1000));return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")}
function chatLine(data,target){const el=$(target);const d=document.createElement("div");d.className="chat-line";d.innerHTML=`<b>${escapeHtml(data.username)}</b> ${escapeHtml(data.message)}`;el.appendChild(d);el.scrollTop=el.scrollHeight}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

$("#loginBtn").onclick=()=>{
  const n=$("#username").value.trim();
  localStorage.setItem("neonArenaUsername",n);
  socket.emit("profile:login",{username:n,userId:localStorage.getItem("neonArenaUserId"),authToken:localStorage.getItem("neonArenaAuthToken")});
};
$("#username").addEventListener("keydown",e=>{if(e.key==="Enter")$("#loginBtn").click()});
socket.on("profile:error",msg=>{
  toast(msg);
  if(savedUserId && savedAuthToken){
    localStorage.removeItem("neonArenaUserId");
    localStorage.removeItem("neonArenaAuthToken");
  }
});

// Automatically reconnect the account saved in this browser.
if(saved && savedUserId && savedAuthToken) loginWithSavedAccount();
socket.on("profile:ok",u=>{
  me=u;
  localStorage.setItem("neonArenaUsername",u.username);
  localStorage.setItem("neonArenaUserId",u.id);
  localStorage.setItem("neonArenaAuthToken",u.authToken);
  login.classList.add("hidden");app.classList.remove("hidden");$("#meName").textContent=u.username;
  loadLeaderboard(); socket.emit("room:create");
});
socket.on("toast",toast);

$("#createRoom").onclick=()=>socket.emit("room:create");
$("#joinRoom").onclick=()=>socket.emit("room:join",{code:$("#roomInput").value});
$("#roomInput").addEventListener("keydown",e=>{if(e.key==="Enter")$("#joinRoom").click()});
$("#leaveRoom").onclick=()=>socket.emit("room:leave");
$("#startMatch").onclick=()=>socket.emit("room:start");
$("#backToLobby").onclick=()=>$("#resultOverlay").classList.add("hidden");

socket.on("room:update",r=>{
  room=r; $("#roomCode").textContent=r.id||"—";$("#hudRoom").textContent=r.id||"—";
  $("#playerCount").textContent=`${r.players.length}/${r.maxPlayers}`;
  $("#players").innerHTML=r.players.map(p=>`<div class="player"><i class="dot" style="color:${p.color};background:${p.color}"></i><span>${escapeHtml(p.username)}</span>${p.id===r.hostId?'<span class="host">HOST</span>':''}</div>`).join("");
  $("#startMatch").style.display=(r.hostId===me?.id&&r.state==="lobby")?"inline-block":"none";
  $("#lobbyOverlay").classList.toggle("hidden",r.state!=="lobby");
});

socket.on("room:invite",({code,from})=>{
  if(confirm(`${from} invited you to room ${code}. Join?`)){socket.emit("room:join",{code})}
});

$("#roomChatForm").onsubmit=e=>{e.preventDefault();const v=$("#roomMessage").value.trim();if(v){socket.emit("chat:send",{scope:"room",message:v});$("#roomMessage").value=""}};
$("#globalChatForm").onsubmit=e=>{e.preventDefault();const v=$("#globalMessage").value.trim();if(v){socket.emit("chat:send",{scope:"global",message:v});$("#globalMessage").value=""}};
socket.on("chat:message",d=>chatLine(d,d.scope==="room"?"#roomChat":"#globalChat"));

socket.on("friends:data",data=>{
  $("#requestCount").textContent=data.requests.length;
  $("#friendRequests").innerHTML=data.requests.length?`<div class="section-title" style="margin-top:16px">REQUESTS</div>`+data.requests.map(r=>`
    <div class="request"><span>${escapeHtml(r.username)}</span><div class="friend-actions">
    <button class="accept" onclick="respondFriend('${r.id}',true)">ACCEPT</button>
    <button onclick="respondFriend('${r.id}',false)">DECLINE</button></div></div>`).join(""):"";
  $("#friendsList").innerHTML=data.friends.length?`<div class="section-title" style="margin-top:16px">YOUR FRIENDS</div>`+data.friends.map(f=>`
    <div class="friend-item"><span>${escapeHtml(f.username)} ${onlineHint(f.id)}</span><div class="friend-actions">
    <button onclick="inviteFriend('${f.id}')">INVITE</button><button onclick="removeFriend('${f.id}')">REMOVE</button></div></div>`).join(""):"<p class='muted'>No friends yet. Add someone by username.</p>";
});
function respondFriend(id,accept){socket.emit("friends:respond",{requestId:id,accept})}
function inviteFriend(id){socket.emit("room:invite",{friendId:id})}
function removeFriend(id){socket.emit("friends:remove",{friendId:id})}
function onlineHint(){return ""}

$("#friendsBtn").onclick=()=>showModal("friendsModal");
$("#leaderBtn").onclick=()=>{loadLeaderboard();showModal("leaderModal")};
document.querySelectorAll(".close").forEach(b=>b.onclick=()=>hideModal(b.dataset.close));
$("#friendForm").onsubmit=e=>{e.preventDefault();const n=$("#friendUsername").value.trim();if(n){socket.emit("friends:request",{username:n});$("#friendUsername").value=""}};

async function loadLeaderboard(){
  try{
    const data=await fetch("/api/leaderboard").then(r=>r.json());
    $("#leaderboard").innerHTML=`<div class="leader-row leader-head"><span>#</span><span>PLAYER</span><span>SCORE</span><span>WINS</span></div>`+
    data.map(x=>`<div class="leader-row"><b>${x.rank}</b><span>${escapeHtml(x.username)}</span><b>${x.score}</b><span>${x.wins}</span></div>`).join("");
  }catch{}
}

window.addEventListener("keydown",e=>{
  if(["INPUT","TEXTAREA"].includes(document.activeElement.tagName))return;
  keys[e.key.toLowerCase()]=true;if(e.code==="Space")e.preventDefault();
});
window.addEventListener("keyup",e=>keys[e.key.toLowerCase()]=false);
canvas.addEventListener("mousemove",e=>{const r=canvas.getBoundingClientRect();mouse.x=(e.clientX-r.left)*canvas.width/r.width;mouse.y=(e.clientY-r.top)*canvas.height/r.height});
canvas.addEventListener("mousedown",()=>mouse.down=true);
window.addEventListener("mouseup",()=>mouse.down=false);

setInterval(()=>{
  if(!me||!room||room.state!=="playing")return;
  const p=latest?.players?.find(x=>x.id===me.id);
  if(!p)return;
  const angle=Math.atan2(mouse.y-p.y,mouse.x-p.x);
  socket.emit("input",{up:keys.w||keys.arrowup,down:keys.s||keys.arrowdown,left:keys.a||keys.arrowleft,right:keys.d||keys.arrowright,angle,shoot:mouse.down,dash:keys[" "]||keys.space});
},33);

socket.on("game:state",s=>{latest=s;const p=s.players.find(x=>x.id===me?.id);if(p)$("#myScore").textContent=p.score});
socket.on("game:feed",d=>toast(d.text));
socket.on("match:results",results=>{
  $("#resultOverlay").classList.remove("hidden");
  $("#results").innerHTML=results.map(r=>`<div class="result-row"><b>${r.rank}</b><span>${escapeHtml(r.username)}</span><b>${r.score}</b><span>⚔ ${r.kills}</span></div>`).join("");
  loadLeaderboard();
});
function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const g=ctx.createLinearGradient(0,0,canvas.width,canvas.height);g.addColorStop(0,"#080c21");g.addColorStop(1,"#03050e");ctx.fillStyle=g;ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle="rgba(103,232,249,.055)";ctx.lineWidth=1;
  for(let x=0;x<canvas.width;x+=60){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke()}
  for(let y=0;y<canvas.height;y+=60){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke()}
  if(latest){
    for(const b of latest.bullets){ctx.fillStyle="#fff";ctx.shadowBlur=16;ctx.shadowColor="#67e8f9";ctx.beginPath();ctx.arc(b.x,b.y,4,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0}
    for(const p of latest.players){
      ctx.save();ctx.translate(p.x,p.y);
      ctx.shadowBlur=22;ctx.shadowColor=p.color;ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      ctx.fillStyle="#080b18";ctx.beginPath();ctx.arc(0,0,9,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle="#fff";ctx.globalAlpha=.8;ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,21,-Math.PI/2,-Math.PI/2+Math.PI*2*(p.hp/100));ctx.stroke();ctx.globalAlpha=1;
      ctx.fillStyle="#fff";ctx.font="600 11px Inter";ctx.textAlign="center";ctx.fillText(p.username,0,-30);
      if(p.id===me?.id){ctx.strokeStyle="#fff";ctx.setLineDash([4,4]);ctx.beginPath();ctx.arc(0,0,28,0,Math.PI*2);ctx.stroke();ctx.setLineDash([])}
      ctx.restore();
    }
  }
  if(latest) $("#timer").textContent=formatTime(latest.endsAt-Date.now()); else $("#timer").textContent="02:00";
  raf=requestAnimationFrame(draw);
}
draw();
