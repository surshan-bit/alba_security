const fs=require('fs'),path=require('path');
const {load}=require('../../tests/lib/load.js');
const TECH=load('src/engine/technical.js');
const dir=process.env.PRICE_DIR || '../alba_security_data/db/priceHistory';
const names=fs.readdirSync(dir).filter(f=>f.endsWith('_1W.json')).map(f=>f.replace('_1W.json',''));
const rows=[];let used=0;
for(const n of names){
  let w,m;try{w=JSON.parse(fs.readFileSync(`${dir}/${n}_1W.json`)).bars;m=JSON.parse(fs.readFileSync(`${dir}/${n}_1M.json`)).bars;}catch(e){continue}
  w=w.slice(0,-1); // drop forming bar
  if(w.length<120)continue; used++;
  for(let i=40;i<w.length-26;i++){
    const t=w[i][0];
    const wb=w.slice(0,i+1);
    // completed monthly bars: bar j is complete if next bar's open <= t
    let k=0;while(k+1<m.length&&m[k+1][0]<=t)k++;
    const mb=m.slice(0,k); // bars 0..k-1 are complete
    const r=TECH.computeTechnical(wb,mb,null,'x');
    if(!r||r.score==null)continue;
    const c=w[i][4];
    rows.push([n,t,r.score,w[i+4][4]/c-1,w[i+13][4]/c-1,w[i+26][4]/c-1,c/w[i-13][4]-1,mb.length>=35?1:0]);
  }
}
fs.writeFileSync(__dirname+'/rows.json',JSON.stringify(rows));
console.log('stocks',used,'rows',rows.length);
