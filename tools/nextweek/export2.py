import pandas as pd,numpy as np,json,warnings
warnings.filterwarnings('ignore')
from sklearn.ensemble import HistGradientBoostingClassifier
D=pd.read_pickle('D.pkl').sort_values(['k','t']).reset_index(drop=True)
g=D.groupby('k'); D['t1']=g.t.shift(-1); D['y1']=g.y.shift(-1); D['y2']=D.y+D.y1
D=D[(D.t1-D.t).between(5*86400,9*86400)&D.y2.notna()]
F=[c for c in D.columns if c not in('k','t','y','turn','rev1','t1','y1','y2')]
D['ex2']=D.y2-D.groupby('t').y2.transform('median'); D['lab']=(D.ex2>0).astype(int)
L=D.dropna(subset=F)
m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=150,min_samples_leaf=400,l2_regularization=5,random_state=0).fit(L[F],L.lab)
trees=[[[int(x['feature_idx']),float(x['num_threshold']),int(x['left']),int(x['right']),float(x['value']),bool(x['is_leaf']),bool(x['missing_go_to_left'])] for x in it[0].nodes] for it in m._predictors]
base=float(np.ravel(m._baseline_prediction)[0]); print(F,len(trees),len(L))
o=pd.read_pickle('oos2.pkl')[('full','labx')]
o['cs']=o.groupby('t').p.rank(pct=True,method='first'); o['bin']=np.floor(o.cs*20-1e-9).clip(upper=19).astype(int)
tab=o.groupby('bin').agg(up=('labu','mean'),beat=('labx','mean')).round(4); print(tab.T.to_string())
json.dump({'features':F,'base':base,'trees':trees,'up':list(tab.up),'beat':list(tab.beat),'horizonWeeks':2,'trainedThrough':int(L.t.max()),'rows':int(len(L))},open('model.json','w'),separators=(',',':'))
