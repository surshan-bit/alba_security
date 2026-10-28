import pandas as pd,numpy as np,json,warnings
warnings.filterwarnings('ignore')
from sklearn.ensemble import HistGradientBoostingClassifier
D=pd.read_pickle('D.pkl')
F=[c for c in D.columns if c not in('k','t','y','turn','rev1')]
D['ex']=D.y-D.groupby('t').y.transform('median'); D['lab']=(D.ex>0).astype(int)
L=D.dropna(subset=F+['y'])
print(F,len(L))
m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=150,min_samples_leaf=400,l2_regularization=5,random_state=0).fit(L[F],L.lab)
pr=m._predictors; print(len(pr),len(pr[0]),m._baseline_prediction)
n=pr[0][0].nodes; print(n.dtype.names); print(n[:3])
trees=[]
for it in pr:
    t=it[0].nodes
    trees.append([[int(x['feature_idx']),float(x['num_threshold']),int(x['left']),int(x['right']),float(x['value']),bool(x['is_leaf']),bool(x['missing_go_to_left'])] for x in t])
base=float(np.ravel(m._baseline_prediction)[0])
# check manual predict
def pred(row):
    s=base
    for t in trees:
        i=0
        while True:
            nd=t[i]
            if nd[5]: s+=nd[4]; break
            v=row[nd[0]]
            if np.isnan(v): i=nd[2] if nd[6] else nd[3]
            else: i=nd[2] if v<=nd[1] else nd[3]
    return 1/(1+np.exp(-s))
X=L[F].values[::997][:300]
mine=np.array([pred(r) for r in X]); sk=m.predict_proba(L[F].iloc[::997][:300])[:,1]
print('max diff',np.abs(mine-sk).max())
o=pd.read_pickle('oos_raw.pkl'); o['up']=(o.y>0).astype(int)
# calibrate on where a stock ranked among all stocks THAT WEEK (the market's overall level moves the raw score, the ranking does not)
o['cs']=o.groupby('t').p.rank(pct=True,method='first')
o['bin']=np.floor(o.cs*20-1e-9).clip(upper=19).astype(int)
tab=o.groupby('bin').agg(up=('up','mean'),beat=('lab','mean')).round(4)
json.dump({'features':F,'base':base,'trees':trees,'up':list(tab.up),'beat':list(tab.beat),'trainedThrough':int(L.t.max()),'rows':int(len(L))},open('model.json','w'),separators=(',',':'))
import os;print(os.path.getsize('model.json')); print(tab.T.to_string())
L[['k','t']+F].iloc[::997][:300].assign(p=sk).to_pickle('parity.pkl')
