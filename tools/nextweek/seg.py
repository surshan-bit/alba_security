import pandas as pd,numpy as np,warnings
warnings.filterwarnings('ignore')
from sklearn.ensemble import HistGradientBoostingClassifier
D=pd.read_pickle('D.pkl').sort_values(['k','t']).reset_index(drop=True)
T=pd.read_pickle('T.pkl')
g=D.groupby('k'); D['t1']=g.t.shift(-1); D['y1']=g.y.shift(-1); D['y2']=D.y+D.y1
D=D[(D.t1-D.t).between(5*86400,9*86400)&D.y2.notna()]
D=D.merge(T[['k','t','wx','mx']],on=['k','t'],how='left')
F=[c for c in D.columns if c not in('k','t','y','turn','rev1','t1','y1','y2','wx','mx')]
D['ex2']=D.y2-D.groupby('t').y2.transform('median'); D['labx']=(D.ex2>0).astype(int); D['labu']=(D.y2>0).astype(int)
L=D.dropna(subset=F+['wx','mx']).copy()
print(len(L))
for name,mask in (('weekly only',None),('both',None)):
    pass
L['defW']=np.where(L.wx==1,'up','down')
L['defB']=np.where((L.wx==1)&(L.mx==1),'up',np.where((L.wx==0)&(L.mx==0),'down','mixed'))
print(L.defB.value_counts(normalize=True).round(3).to_dict())
print('P(2w up) by segment base:',L.groupby('defW').labu.mean().round(3).to_dict(),L.groupby('defB').labu.mean().round(3).to_dict())
oos=pd.read_pickle('oos2.pkl')[('full','labx')]
oos=oos.merge(L[['k','t','defW','defB']],on=['k','t'],how='left')
def rep(o,col,tag):
    for seg in sorted(o[col].dropna().unique()):
        s=o[o[col]==seg]
        s=s.assign(r=s.groupby('t').p.rank(ascending=False,method='first'))
        t5=s[s.r<=5]; t10=s[s.r<=10]
        n=s.groupby('t').size()
        print('%-18s %-6s | all up %.3f | top5 up %.3f beat %.3f mean %.2f%% | top10 up %.3f | weeks %d avg stocks/wk %d'%(tag,seg,s.labu.mean(),t5.labu.mean(),t5.labx.mean(),t5.y2.mean()*100,t10.labu.mean(),t5.t.nunique(),n.mean()))
print('--- shared model, rank within trend segment')
rep(oos,'defW','weekly MACD'); rep(oos,'defB','weekly+monthly')
# segment-specific models
ts=sorted(L.t.unique()); start=len(ts)-260; step=26
for col in ('defW','defB'):
    res=[]
    for i in range(start,len(ts),step):
        tr_all=L[L.t<=ts[i-3]]; te_all=L[(L.t>=ts[i])&((L.t<ts[i+step]) if i+step<len(ts) else True)]
        for seg in L[col].unique():
            tr=tr_all[tr_all[col]==seg]; te=te_all[te_all[col]==seg]
            if len(te)==0: continue
            m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=150,min_samples_leaf=400,l2_regularization=5,random_state=0).fit(tr[F],tr.labx)
            res.append(te[['k','t','y2','labu','labx',col]].assign(p=m.predict_proba(te[F])[:,1]))
    o=pd.concat(res); print('--- segment-specific models',col); rep(o,col,'specific '+col)
    o.to_pickle(f'oos_seg_{col}.pkl')
