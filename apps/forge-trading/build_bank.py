import re, json, sys
terms_md = open('content/agentic-trading-term-bank-and-lessons.md').read().split('## Part 2')[0]
scen_md = open('content/agentic-trading-scenarios.md').read()

# ---- terms ----
terms = []
section = None
for line in terms_md.split('\n'):
    m = re.match(r'^### ([A-G])\. (.+?) \(\d+\)', line)
    if m:
        section = {'key': m.group(1), 'name': m.group(2)}
        continue
    m = re.match(r'^(\d+)\. \*\*(.+?)\*\* — (.+)$', line)
    if m and section:
        terms.append({'id': f"T{int(m.group(1)):03d}", 'section': section['key'],
                      'sectionName': section['name'], 'term': m.group(2), 'def': m.group(3)})

# ---- scenarios ----
scen = []
blocks = re.split(r'\n(?=\*\*[A-G]\d+\.\*\*)', scen_md)
sec_names = {}
for m in re.finditer(r'^## ([A-G])\. (.+?) \(\d+\)', scen_md, re.M):
    sec_names[m.group(1)] = m.group(2)
for b in blocks:
    m = re.match(r'\*\*([A-G])(\d+)\.\*\* (.+?)\n(A\. .+?)\n\*\*Answer: ([A-D])\.\*\*\s*(.*)', b, re.S)
    if not m: continue
    sec, num, stem, opts, ans, rat = m.groups()
    opts_list = re.findall(r'([A-D])\. (.*?)(?= [B-D]\. |$)', opts.strip())
    rat = rat.split('\n---')[0].split('\n\n')[0].strip()
    scen.append({'id': f"{sec}{num}", 'section': sec, 'sectionName': sec_names[sec],
                 'stem': stem.strip(), 'options': [o[1].strip() for o in opts_list],
                 'answer': 'ABCD'.index(ans), 'rationale': rat})
    assert len(opts_list) == 4, (sec, num, opts)

print(len(terms), 'terms', len(scen), 'scenarios', file=sys.stderr)
sections = [{'key': k, 'name': v} for k, v in sec_names.items()]
json.dump({'vertical': 'Agentic Trading', 'reviewed': '2026-09-07', 'sections': sections,
           'terms': terms, 'scenarios': scen}, open('bank.json', 'w'), indent=1)
