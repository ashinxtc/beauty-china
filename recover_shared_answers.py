"""Recover literal answer tables from the user's shared review, without executing its code.

Usage: python recover_shared_answers.py /path/to/decoded-messages.json
The input is the chronological message list decoded from the shared conversation.
"""
import ast
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import sys

from docx import Document
from question_bank import normalize

ROOT = Path(__file__).resolve().parent
SHARE = 'https://chatgpt.com/share/6ace5f64-980c-83ec-8291-b563c930cefc'


def literal_calls(text, function):
    # Read only literal arguments; never run scripts or expressions from the page.
    for code in re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", text, re.S):
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == function:
                try:
                    yield [ast.literal_eval(arg) for arg in node.args]
                except (ValueError, TypeError):
                    continue


def original_questions(path):
    questions, current = [], None
    doc = Document(path)
    for p in doc.paragraphs:
        text = p.text.strip()
        match = re.match(r'^(\d+)\.\s*(.*)', text, re.S)
        if match:
            if current:
                questions.append(current)
            current = {'num': int(match[1]), 'stem': match[2], 'options': {}, 'images': []}
        elif current:
            choice = re.match(r'^([A-F])\.\s*(.*)', text, re.S)
            if choice:
                current['options'][choice[1]] = choice[2]
            elif text:
                if current['options']:
                    current['options'][list(current['options'])[-1]] += ' ' + text
                else:
                    current['stem'] += ' ' + text
        if current:
            for blip in p._p.xpath('.//a:blip'):
                rid = blip.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
                if rid:
                    current['images'].append(hashlib.md5(doc.part.related_parts[rid].blob).hexdigest())
    questions.append(current)
    assert [q['num'] for q in questions] == list(range(1, 1144))
    groups = defaultdict(list)
    for q in questions:
        compact = lambda s: re.sub(r'\s', '', s)
        key = compact(q['stem']) + '|' + str({k: compact(v) for k, v in q['options'].items()})
        if re.search(r'下图|图中|红框|图示|如图|图里|示意图|图例|图上.*[A-D]|[A-D].*岛为|所示', q['stem']):
            key += '|' + '|'.join(q['images'])
        groups[key].append(q['num'])
        q['canonical'] = groups[key][0]
    return questions


def recover(messages):
    base = {}
    split = next(i for i, m in enumerate(messages) if i and m['role'] == 'user')
    for message in messages[:split]:
        for args in literal_calls(message['text'], 'add'):
            for token in args[0].split():
                n, answer = re.fullmatch(r'(\d+)([A-F]+|\?)', token).groups()
                base.setdefault(int(n), {})['answer'] = answer
        for args in literal_calls(message['text'], 'note'):
            base.setdefault(args[0], {}).update(reason=args[1], state=args[2] if len(args) > 2 else '说明')
    decisions = {}
    review = next(m for m in messages if 'verify_work/adjudicate.py' in m['text'] and 'def put(' in m['text'])
    for args in literal_calls(review['text'], 'put'):
        for n in args[0] if isinstance(args[0], list) else [args[0]]:
            decisions[n] = {'answer': args[1], 'reason': args[2],
                            'state': args[3] if len(args) > 3 else '题面与知识点复核'}
    # Image decisions are a literal table, followed by a loop in the review script.
    code = re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", review['text'], re.S)[0]
    for node in ast.walk(ast.parse(code)):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'image_answers' for t in node.targets):
            for n, (answer, label) in ast.literal_eval(node.value).items():
                decisions[n] = {'answer': answer, 'reason': '复看附件原图，判读为' + label, 'state': '原图判读'}
    # The last user-facing conclusion takes precedence over the intermediate report.
    final = next(m['text'] for m in reversed(messages) if m['role'] == 'assistant' and m['channel'] == 'final')
    assert '**ABCDE**' in final and '**D：砣矶岛**' in final and '**A：裕固族**' in final
    decisions[787] = {'answer': 'A', 'reason': '最终结论更正为裕固族；题干限定聚居地仅分布在甘肃。', 'state': '最终结论更正'}
    decisions[902] = {'answer': None, 'reason': '最终结论保留待核，不能把倾向BCD写成确定答案。', 'state': '待核'}
    final_pending = {14,104,124,379,391,427,524,588,611,763,788,837,867,872,902,975,1073,1096,1108,
                     523,608,696,888,1051}
    source = ROOT / '25年版图大赛题库.docx'
    raw = {q['num']: q for q in json.loads((ROOT / 'raw_banks.json').read_text())['2025大赛题库']}
    recovered = {}
    for q in original_questions(source):
        n = q['num']
        assert q['canonical'] in base, f'No recoverable original answer for {n}'
        entry = dict(base[q['canonical']])
        if n in decisions:
            entry.update(decisions[n])
        answer = entry['answer']
        reason, state = entry.get('reason', ''), entry.get('state', '沿用前版')
        uncertain = n in final_pending or not answer or answer == '?' or not re.fullmatch('[A-F]+', answer)
        uncertain |= bool(re.search(r'需核|待核|拟答|条件不足|歧义|旧题口径|设色口径', state))
        if n not in decisions:
            uncertain |= bool(re.search(r'拟答|待核|需复核|需核|无法唯一|无正确选项|无有效选项|缺图标记', reason + state))
        target = raw[n]
        assert normalize(q['stem']) == normalize(target['title']), f'Stem mismatch: {n}'
        expected = {k: normalize(v) for k, v in q['options'].items()}
        actual = {v[0]: normalize(re.sub(r'^[A-F][.、．\s]*', '', v)) for v in target['options']}
        assert expected == actual, f'Option mismatch: {n}'
        if answer and re.fullmatch('[A-F]+', answer):
            assert set(answer) <= set(expected), f'Invalid answer: {n}'
        recovered[target['id']] = {
            'expected_question': target['title'], 'expected_options': target['options'],
            'expected_image_hashes': [hashlib.sha256((ROOT / image).read_bytes()).hexdigest() for image in target['images']],
            'answer': answer if not uncertain else '', 'proposed_answer': answer,
            'accepted': not uncertain, 'reason': reason, 'review_state': state,
            'question_number': n, 'original_canonical': q['canonical'],
        }
        if not uncertain and n in [4,17,37]:
            recovered[target['id']]['answer_mode'] = 'ordered'
            if n == 17:
                recovered[target['id']]['answer'] = 'CB'
    return {'source_url': SHARE, 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'conversation_sha256': hashlib.sha256(json.dumps(messages, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
            'policy': '按共享记录中最终更正及逐题核对记录整理；未独立获得全部官方标准答案，待核或拟答不进入孩子题库。',
            'questions': recovered}


if __name__ == '__main__':
    result = recover(json.loads(Path(sys.argv[1]).read_text()))
    (ROOT / 'reviewed_answers_2025.json').write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'recovered': len(result['questions']), 'accepted': sum(q['accepted'] for q in result['questions'].values()),
                      'withheld': sum(not q['accepted'] for q in result['questions'].values()),
                      'ordered': [q['question_number'] for q in result['questions'].values() if q.get('answer_mode')]}, ensure_ascii=False))
