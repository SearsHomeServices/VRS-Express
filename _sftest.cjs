const fs = require('fs');
const OUT = 'sf_out.txt';
const lines = [];
const w = (s) => { lines.push(Date.now()%100000 + ' ' + s); try{fs.writeFileSync(OUT, lines.join('\n'));}catch(e){} };
w('A: top of script');
const snowflake = require('snowflake-sdk');
w('B: required sdk');
snowflake.configure({ logLevel: 'ERROR' });
function normalizeKey(key){let n=key.trim().replace(/\\n/g,'\n');const h=n.match(/-----BEGIN (RSA )?PRIVATE KEY-----/);const f=n.match(/-----END (RSA )?PRIVATE KEY-----/);if(h&&f){const body=n.replace(h[0],'').replace(f[0],'').replace(/[\s\r\n]+/g,'');const ls=body.match(/.{1,64}/g)||[];return h[0]+'\n'+ls.join('\n')+'\n'+f[0]+'\n';}return n;}
const t=Date.now();
let conn;
try { conn=snowflake.createConnection({account:process.env.SNOWFLAKE_ACCOUNT,username:process.env.SNOWFLAKE_USERNAME,authenticator:'SNOWFLAKE_JWT',privateKey:normalizeKey(process.env.SNOWFLAKE_PRIVATE_KEY),warehouse:process.env.SNOWFLAKE_WAREHOUSE,database:'PRD_TPMS',schema:'HSTECH'}); w('C: created connection obj'); }
catch(e){ w('C-ERR createConnection: '+e.message); process.exit(1); }
const hard=setTimeout(()=>{w('HARD TIMEOUT 70s');process.exit(2);},70000);
conn.connect((e,c)=>{ if(e){w('CONNECT ERR '+(Date.now()-t)+'ms: '+e.message);clearTimeout(hard);process.exit(1);} w('D: CONNECTED '+(Date.now()-t)+'ms'); conn.execute({sqlText:'SELECT CURRENT_USER() U, CURRENT_ROLE() R, CURRENT_WAREHOUSE() W',complete:(err,st,rows)=>{if(err)w('QERR '+err.message);else w('E: ROWS '+JSON.stringify(rows));clearTimeout(hard);conn.destroy(()=>process.exit(0));}});});
