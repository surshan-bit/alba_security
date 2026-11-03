#!/usr/bin/env python3
"""Write code.json ({"py": <agent.py>}) for upload to the agent db doc agent/code.json.
Usage: python3 make_code_doc.py [out.json]   (default: ./code.json, git-ignored)"""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'code.json')
json.dump({'py': open(os.path.join(here, 'agent.py')).read()}, open(out, 'w'))
print('wrote', out)
