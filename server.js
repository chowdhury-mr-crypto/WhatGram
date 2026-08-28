const express = require("express");
const http = require("http");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_SECRET_BEFORE_PRODUCTION";
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(process.env.DB_PATH || path.join(__dirname, "whatgram.db"));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  )`);
});

function q(sql, params=[]) {
  return new Promise((resolve,reject)=>db.all(sql,params,(e,r)=>e?reject(e):resolve(r)));
}
function run(sql, params=[]) {
  return new Promise((resolve,reject)=>db.run(sql,params,function(e){e?reject(e):resolve(this)}));
}
function tokenFor(user) {
  return jwt.sign({id:user.id, username:user.username}, JWT_SECRET, {expiresIn:"30d"});
}
function auth(req,res,next) {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/,"");
    req.user = jwt.verify(raw, JWT_SECRET);
    next();
  } catch { res.status(401).json({error:"Please log in again."}); }
}

app.get("/api/health", (req,res)=>res.json({ok:true, app:"WhatGram"}));

app.post("/api/register", async (req,res)=>{
  try {
    const username = String(req.body.username||"").trim().toLowerCase();
    const displayName = String(req.body.displayName||"").trim();
    const password = String(req.body.password||"");
    if(!/^[a-z0-9_]{3,24}$/.test(username))
      return res.status(400).json({error:"Username: 3-24 letters, numbers or _ only."});
    if(displayName.length<2 || displayName.length>40)
      return res.status(400).json({error:"Display name must be 2-40 characters."});
    if(password.length<6)
      return res.status(400).json({error:"Password must be at least 6 characters."});
    const exists = await q("SELECT id FROM users WHERE username=?",[username]);
    if(exists.length) return res.status(409).json({error:"Username already exists."});
    const hash = await bcrypt.hash(password,10);
    const r = await run(
      "INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)",
      [username,displayName,hash,new Date().toISOString()]
    );
    const user = {id:r.lastID,username,display_name:displayName};
    res.json({token:tokenFor(user),user});
  } catch(e){ console.error(e); res.status(500).json({error:"Registration failed."}); }
});

app.post("/api/login", async (req,res)=>{
  try {
    const username=String(req.body.username||"").trim().toLowerCase();
    const password=String(req.body.password||"");
    const rows=await q("SELECT * FROM users WHERE username=?",[username]);
    if(!rows.length || !(await bcrypt.compare(password,rows[0].password_hash)))
      return res.status(401).json({error:"Wrong username or password."});
    const u=rows[0];
    res.json({token:tokenFor(u),user:{id:u.id,username:u.username,display_name:u.display_name}});
  } catch(e){res.status(500).json({error:"Login failed."});}
});

app.get("/api/me",auth,async(req,res)=>{
  const rows=await q("SELECT id,username,display_name FROM users WHERE id=?",[req.user.id]);
  if(!rows.length)return res.status(404).json({error:"User not found."});
  res.json({user:rows[0]});
});

app.get("/api/users",auth,async(req,res)=>{
  const rows=await q("SELECT id,username,display_name FROM users WHERE id<>? ORDER BY display_name",[req.user.id]);
  res.json({users:rows});
});

app.get("/api/messages/:otherId",auth,async(req,res)=>{
  const other=Number(req.params.otherId);
  if(!Number.isInteger(other)) return res.status(400).json({error:"Bad user id."});
  const rows=await q(
    `SELECT id,sender_id,receiver_id,body,created_at FROM messages
     WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)
     ORDER BY id ASC LIMIT 200`,
    [req.user.id,other,other,req.user.id]
  );
  res.json({messages:rows});
});

const clients = new Map(); // userId -> Set<WebSocket>

function sendTo(userId, payload) {
  const set=clients.get(Number(userId));
  if(!set)return;
  const text=JSON.stringify(payload);
  for(const ws of set) if(ws.readyState===1) ws.send(text);
}

wss.on("connection",(ws,req)=>{
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const token=u.searchParams.get("token");
    const decoded=jwt.verify(token,JWT_SECRET);
    ws.userId=Number(decoded.id);
    if(!clients.has(ws.userId))clients.set(ws.userId,new Set());
    clients.get(ws.userId).add(ws);
    ws.send(JSON.stringify({type:"ready"}));

    ws.on("message",async raw=>{
      try {
        const data=JSON.parse(raw.toString());
        if(data.type!=="message")return;
        const receiver=Number(data.receiverId);
        const body=String(data.body||"").trim();
        if(!Number.isInteger(receiver)||!body||body.length>2000)return;
        const target=await q("SELECT id FROM users WHERE id=?",[receiver]);
        if(!target.length)return;
        const created=new Date().toISOString();
        const r=await run(
          "INSERT INTO messages(sender_id,receiver_id,body,created_at) VALUES(?,?,?,?)",
          [ws.userId,receiver,body,created]
        );
        const message={id:r.lastID,sender_id:ws.userId,receiver_id:receiver,body,created_at:created};
        sendTo(ws.userId,{type:"message",message});
        sendTo(receiver,{type:"message",message});
      }catch(e){ console.error("WS message error",e); }
    });
    ws.on("close",()=>{
      const set=clients.get(ws.userId);
      if(set){set.delete(ws);if(!set.size)clients.delete(ws.userId);}
    });
  } catch { ws.close(1008,"Unauthorized"); }
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
  res.sendFile(path.join(__dirname,"public","index.html"));
});

server.listen(PORT,()=>console.log(`WhatGram running on port ${PORT}`));
