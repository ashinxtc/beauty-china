"""Conservative question identity and answer matching; never copy option letters."""
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
import re
import unicodedata

PDF_BANKS = ('小学组样题库', '中学组样题库', '历年真题汇编')
BANK_NAMES = (*PDF_BANKS, '2025大赛题库')
BANK_KEYS = dict(zip(BANK_NAMES, ('elem', 'middle', 'history', 'contest25')))
PENDING_REASONS = {
    'missing': '原文件未提供答案，尚无可核验的同题答案',
    'source_conflict': '原始资料对同题给出不同答案，需要核验',
    'missing_diagram': '题目依赖配图，但原文件没有对应配图',
    'invalid_options': '题目选项不完整或标号异常，需要核验',
    'review_pending': '共享核对记录仍保留待核或拟答，暂不用于刷题',
}


def normalize(text):
    text = unicodedata.normalize('NFKC', text)
    text = re.sub(r'\((?:单选题|多选题)\)', '', text)
    text = re.sub(r'\(\s*\)', '', text)
    text = re.sub(r'[\s，,。！？!?“”]', '', text)
    # Keep decimals and meaningful parentheses, e.g. years and time zones.
    return re.sub(r'(?<!\d)\.|\.(?!\d)', '', text)


def options(question):
    result = {}
    for option in question['options']:
        match = re.match(r'^([A-F])[.、．\s]*(.*)', option, re.S)
        if not match or match[1] in result or not match[2].strip():
            return None
        result[match[1]] = normalize(match[2])
    if len(result) < 2 or len(set(result.values())) != len(result):
        return None
    return result


def needs_diagram(question):
    return bool(re.search(r'下图|右图|左图|上图|如图|图示|照片|轮廓|(?<!地)图中', question['title']))


def image_identity(question, root):
    if needs_diagram(question) and not question.get('images'):
        # Missing pictures cannot prove that two otherwise identical stems are the same question.
        return ('missing:' + question['id'],)
    return tuple(sorted(hashlib.sha256((root / filename).read_bytes()).hexdigest()
                        for filename in question.get('images', [])))


def question_identity(question, root, ordered=False):
    choices = options(question)
    return (normalize(question['title']),
            (tuple(choices.values()) if ordered else tuple(sorted(choices.values()))) if choices else ('invalid:' + question['id'],),
            image_identity(question, root))


def selected_contents(question):
    choices = options(question)
    if not choices or not question.get('answer') or any(c not in choices for c in question['answer']):
        return None
    return tuple(sorted(choices[c] for c in question['answer']))


def remap_answer(source, target):
    selected = selected_contents(source)
    choices = options(target)
    if not selected or not choices:
        return ''
    reverse = {content: letter for letter, content in choices.items()}
    if any(content not in reverse for content in selected):
        return ''
    return ''.join(sorted(reverse[content] for content in selected))


def suspend(question, status):
    question['answer'] = ''
    question['answer_status'] = status
    question['scorable'] = False
    question['pending_reason'] = PENDING_REASONS[status]


def reconcile(banks, previous_unified, root, overrides, reviewed=None):
    """Return verified/matched records, conflict details and stable canonical questions."""
    banks = deepcopy(banks)
    all_questions = [q for name in BANK_NAMES for q in banks[name]]
    by_id = {q['id']: q for q in all_questions}
    conflicts = []
    for name in BANK_NAMES:
        for q in banks[name]:
            q.pop('answer_source', None)
            q.pop('answer_evidence', None)
            q.pop('pending_reason', None)
            q.pop('conflicting_answers', None)
            q.pop('answer_explanation', None)
            q.pop('answer_mode', None)
            if name == '2025大赛题库':
                # The DOCX has no answer key; discard legacy stem-only propagation.
                q['answer'] = ''
                q['answer_status'] = 'missing'
            else:
                q['answer'] = q['source_answer']
                q['answer_status'] = 'source'
                q['answer_evidence'] = [{**q['source_reference'], 'id': q['id'],
                                        'answer': q['answer'], 'method': '原文件答案'}]
            q['scorable'] = bool(q['answer'])
            if not options(q) or (q['answer'] and selected_contents(q) is None):
                suspend(q, 'invalid_options')
            elif needs_diagram(q) and not q.get('images'):
                suspend(q, 'missing_diagram')

    source_groups = defaultdict(list)
    for name in PDF_BANKS:
        for q in banks[name]:
            if q['scorable']:
                source_groups[question_identity(q, root)].append(q)
    for records in source_groups.values():
        if len({selected_contents(q) for q in records}) > 1:
            evidence = [{'id': q['id'], 'reference': q['source_reference'],
                         'answer': q['source_answer'], 'options': q['options']} for q in records]
            conflicts.append({'question': records[0]['title'], 'evidence': evidence})
            for q in records:
                suspend(q, 'source_conflict')
                q['conflicting_answers'] = evidence

    reliable = defaultdict(list)
    for name in PDF_BANKS:
        for q in banks[name]:
            if q['scorable']:
                reliable[question_identity(q, root)].append(q)
    for target in banks['2025大赛题库']:
        if target['answer_status'] != 'missing':
            continue
        references = reliable.get(question_identity(target, root), [])
        if references:
            target['answer'] = remap_answer(references[0], target)
            target['answer_status'] = 'matched'
            target['answer_evidence'] = [dict(q['answer_evidence'][0], method='同题且选项内容一致，按内容映射')
                                         for q in references]
        elif target['id'] in overrides:
            override = overrides[target['id']]
            if target['title'] != override['expected_question'] or target['options'] != override['expected_options']:
                raise ValueError(f"Reviewed question changed: {target['id']}")
            reference = by_id[override['reference_id']]
            if not reference['scorable']:
                raise ValueError(f"Reference is no longer reliable: {reference['id']}")
            answer = override['answer']
            target_choices = options(target)
            if any(letter not in target_choices for letter in answer):
                raise ValueError(f"Invalid reviewed answer: {target['id']}")
            mapped = remap_answer(reference, target)
            if mapped != answer and not override.get('reviewed_content_variation'):
                raise ValueError(f"Reviewed answer does not match reference option content: {target['id']}")
            target['answer'] = answer
            target['answer_status'] = 'matched'
            target['answer_evidence'] = [dict(reference['answer_evidence'][0],
                                            method=override['reason'])]
        target['scorable'] = bool(target['answer'])

    # User-provided review decisions override old guesses and same-question propagation.
    # Bind every decision to its exact stem, options and picture bytes.
    for q in banks['2025大赛题库']:
        decision = (reviewed or {}).get('questions', {}).get(q['id'])
        if not decision:
            continue
        hashes = [hashlib.sha256((root / filename).read_bytes()).hexdigest() for filename in q['images']]
        if (q['title'] != decision['expected_question'] or q['options'] != decision['expected_options']
                or hashes != decision['expected_image_hashes']):
            raise ValueError(f"Shared-review question changed: {q['id']}")
        q['answer_explanation'] = decision['reason']
        if not decision['accepted']:
            if q['answer_status'] not in ['invalid_options', 'missing_diagram']:
                suspend(q, 'review_pending')
                q['pending_reason'] = decision['reason'] or PENDING_REASONS['review_pending']
            continue
        if q['answer_status'] in ['invalid_options', 'missing_diagram']:
            continue
        answer = decision['answer']
        if not answer or any(letter not in options(q) for letter in answer):
            raise ValueError(f"Invalid shared-review answer: {q['id']}")
        q['answer'] = answer
        q['answer_status'] = 'reviewed'
        q['scorable'] = True
        q['answer_mode'] = decision.get('answer_mode', 'set')
        q['answer_evidence'] = [{**q['source_reference'], 'id': q['id'], 'answer': answer,
                                 'method': '用户提供的三版答案核对记录', 'url': reviewed['source_url'],
                                 'review_state': decision['review_state'], 'reason': decision['reason']}]

    # Reuse reviewed DOCX answers for exact duplicates, including option permutations.
    matched_docx = defaultdict(list)
    for q in banks['2025大赛题库']:
        if q['scorable']:
            matched_docx[question_identity(q, root)].append(q)
    for q in banks['2025大赛题库']:
        references = matched_docx.get(question_identity(q, root), [])
        if q['answer_status'] == 'missing' and references:
            q['answer'] = remap_answer(references[0], q)
            q['answer_status'] = 'matched'
            q['answer_evidence'] = deepcopy(references[0]['answer_evidence'])
            q['scorable'] = True
        if not q['scorable']:
            q['pending_reason'] = q.get('pending_reason') or PENDING_REASONS[q['answer_status']]
        # A missing answer does not establish that a question is single-choice.
        q['type'] = ('multi' if len(q['answer']) > 1 else 'single') if q['answer'] else (
            'multi' if re.search('多选题|下列哪些', q['title']) else 'unknown')

    for name in PDF_BANKS:
        for q in banks[name]:
            q['type'] = 'multi' if len(q['source_answer']) > 1 else 'single'

    groups = defaultdict(list)
    for q in all_questions:
        # Keep reordered option variants separate so existing answers retain their letter meanings.
        groups[question_identity(q, root, ordered=True)].append(q)
    previous_anchors = defaultdict(list)
    previous_order = {}
    for index, q in enumerate(previous_unified):
        for uid in [q['uid'], *q.get('legacy_uids', [])]:
            previous_anchors[q['original_id']].append(uid)
            previous_order[uid] = index

    unified = []
    legacy_map = {}
    for records in groups.values():
        anchors = sorted({uid for q in records for uid in previous_anchors[q['id']]},
                         key=lambda uid: (previous_order[uid], uid))
        uid = anchors[0] if anchors else 'Q_SRC_' + records[0]['id']
        # Preserve the original options behind the retained UID.
        original = next((q['original_id'] for q in previous_unified if q['uid'] == uid), records[0]['id'])
        base = next(q for q in records if q['id'] == original)
        answer = next((remap_answer(q, base) for q in records if q['scorable']), '')
        item = {key: deepcopy(base[key]) for key in
                ('options', 'type', 'images', 'answer_status', 'scorable')}
        item.update(uid=uid, question=base['title'], answer=answer,
                    sources=list(dict.fromkeys(q['source'] for q in records)),
                    original_id=base['id'], source_ids=[q['id'] for q in records],
                    source_reference=base['source_reference'], legacy_uids=anchors[1:])
        if answer:
            item['scorable'] = True
            item['answer_status'] = ('source' if any(q['answer_status'] == 'source' for q in records) else
                                     'reviewed' if any(q['answer_status'] == 'reviewed' for q in records) else 'matched')
            item['answer_evidence'] = [entry for q in records for entry in q.get('answer_evidence', [])]
            reviewed_record = next((q for q in records if q['scorable'] and q.get('answer_mode') == 'ordered'), None)
            if reviewed_record:
                item['answer'] = reviewed_record['answer']
                item['answer_mode'] = 'ordered'
            explanation = next((q.get('answer_explanation') for q in records if q.get('answer_explanation')), '')
            if explanation:
                item['answer_explanation'] = explanation
        else:
            item['pending_reason'] = base.get('pending_reason', PENDING_REASONS['missing'])
            if base.get('answer_explanation'):
                item['answer_explanation'] = base['answer_explanation']
        if base.get('conflicting_answers'):
            item['conflicting_answers'] = base['conflicting_answers']
        unified.append(item)
        legacy_map[uid] = uid
        for alias in anchors:
            legacy_map[alias] = uid
    unified.sort(key=lambda q: min((previous_order[uid] for uid in [q['uid'], *q['legacy_uids']]
                                   if uid in previous_order), default=len(previous_order)))
    summary = {
        'total_raw': len(all_questions), 'counts_by_bank': {name: len(banks[name]) for name in BANK_NAMES},
        'total_unique': len(unified), 'duplicates_removed': len(all_questions) - len(unified),
        'duplicate_rate': f'{(len(all_questions)-len(unified))/len(all_questions)*100:.1f}%',
        'multi_source_high_frequency': sum(len(q['sources']) > 1 for q in unified),
        'questions_with_images': sum(bool(q['images']) for q in unified),
        'scorable_questions': sum(q['scorable'] for q in unified),
        'pending_questions': sum(not q['scorable'] for q in unified),
        'answer_status_counts': dict(Counter(q['answer_status'] for q in unified)),
        'docx_propagated_answers': sum(q['scorable'] for q in banks['2025大赛题库']),
        'legacy_uid_map': legacy_map,
    }
    summary['bank_revision'] = hashlib.sha256(json.dumps(unified, ensure_ascii=False, sort_keys=True)
                                              .encode()).hexdigest()[:16]
    return banks, unified, summary, conflicts
