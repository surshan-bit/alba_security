import pandas as pd,numpy as np,json,warnings
warnings.filterwarnings('ignore')
D=pd.read_pickle('D.pkl').sort_values(['k','t']).reset_index(drop=True)
T=pd.read_pickle('T.pkl')
g=D.groupby('k'); D['t1']=g.t.shift(-1); D['y1']=g.y.shift(-1); D['y2']=D.y+D.y1
D=D[(D.t1-D.t).between(5*86400,9*86400)&D.y2.notna()]
D=D.merge(T[['k','t','wx','mx']],on=['k','t'],how='left').dropna(subset=['wx','mx'])
D['trend']=np.where((D.wx==1)&(D.mx==1),'up',np.where((D.wx==0)&(D.mx==0),'down','mixed'))
o=pd.read_pickle('oos2.pkl')[('full','labx')].merge(D[['k','t','trend']],on=['k','t'],how='left').dropna(subset=['trend'])
o['yr']=pd.to_datetime(o.t+19800,unit='s').dt.year
seg={}; doc={}
for s in ('up','down','mixed'):
    x=o[o.trend==s].copy()
    x['cs']=x.groupby('t').p.rank(pct=True,method='first'); x['bin']=np.floor(x.cs*20-1e-9).clip(upper=19).astype(int)
    tab=x.groupby('bin').agg(up=('labu','mean'),beat=('labx','mean')).round(4)
    seg[s]={'up':list(tab.up),'beat':list(tab.beat),'base':round(float(x.labu.mean())*100,1)}
    x['r']=x.groupby('t').p.rank(ascending=False,method='first')
    t5=x[x.r<=5]; dec=x[x.cs>0.9]
    doc[s]=dict(base=round(x.labu.mean()*100,1),top5=round(t5.labu.mean()*100,1),top5ret=round(t5.y2.mean()*100,2),allret=round(x.y2.mean()*100,2),top10pct=round(dec.labu.mean()*100,1),beat5=round(t5.labx.mean()*100,1),n=int(x.groupby('t').size().mean()))
    print(s,doc[s]); print(pd.DataFrame({'all':x.groupby('yr').labu.mean(),'top5':t5.groupby('yr').labu.mean(),'top5ret':t5.groupby('yr').y2.mean()*100}).round(3).T.to_string())
M=json.load(open('model.json'))
M.pop('up',None);M.pop('beat',None);M['seg']=seg
json.dump(M,open('model.json','w'),separators=(',',':'))
js='// Generated from the 5-year walk-forward two-week model (v1.289). Do not edit by hand: see tools/nextweek/README.md.\nexport const NEXTWEEK_MODEL = '+json.dumps(M,separators=(',',':'))+';\n'
open('nextweek-model.js','w').write(js)
json.dump(doc,open('segdoc.json','w'))
