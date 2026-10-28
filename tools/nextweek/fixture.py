import json,glob,numpy as np,pandas as pd,random
M=json.load(open('model.json'));F=M['features']
def feats(a):
    df=pd.DataFrame(a,columns=['t','o','h','l','c','v']); c=df.c; r=np.log(c).diff()
    f={}
    for n in (1,2,4,8,13,26,52): f[f'r{n}']=np.log(c/c.shift(n))
    f['vol8']=r.rolling(8).std(); f['vol26']=r.rolling(26).std()
    f['dhi52']=c/df.h.rolling(52,min_periods=26).max()-1
    f['dlo52']=c/df.l.rolling(52,min_periods=26).min()-1
    f['rngpos']=(c-df.l)/(df.h-df.l).replace(0,np.nan)
    d_=c.diff(); up=d_.clip(lower=0).rolling(14).mean(); dn=(-d_.clip(upper=0)).rolling(14).mean()
    f['rsi']=100-100/(1+up/dn.replace(0,np.nan))
    e12=c.ewm(span=12).mean(); e26=c.ewm(span=26).mean(); mac=e12-e26
    f['macdh']=(mac-mac.ewm(span=9).mean())/c
    f['volr']=np.log((df.v.rolling(4).mean()+1)/(df.v.rolling(26).mean()+1))
    f['sma10d']=c/c.rolling(10).mean()-1; f['sma40d']=c/c.rolling(40).mean()-1
    f['turn']=(df.v*c).rolling(8).mean()
    return {k:float(v.iloc[-1]) for k,v in f.items()}
def pred(row):
    s=M['base']
    for t in M['trees']:
        i=0
        while True:
            nd=t[i]
            if nd[5]: s+=nd[4]; break
            v=row[nd[0]]
            if v!=v: i=nd[2] if nd[6] else nd[3]
            else: i=nd[2] if v<=nd[1] else nd[3]
    return 1/(1+np.exp(-s))
random.seed(7);out=[]
fs=sorted(glob.glob('/tmp/dbph/priceHistory/*_1W.json'));random.shuffle(fs)
for f in fs:
    d=json.load(open(f)); b=[x for x in d['bars'] if x[4]>0]
    if len(b)<200: continue
    end=random.randint(150,len(b)); seg=b[end-150:end]
    ft=feats(seg)
    if any(ft[k]!=ft[k] for k in F): continue
    out.append({'bars':seg,'features':{k:ft[k] for k in F+['turn']},'p':pred([ft[k] for k in F])})
    if len(out)==5: break
json.dump(out,open('fixture.json','w'),separators=(',',':'))
import os;print(len(out),os.path.getsize('fixture.json'),[round(o['p'],4) for o in out])
# model js
js='// Generated from the 5-year walk-forward next-week model (v1.289). Do not edit by hand: see tools/ notes in the Knowledge Base.\nexport const NEXTWEEK_MODEL = '+json.dumps(M,separators=(',',':'))+';\n'
open('nextweek-model.js','w').write(js)
