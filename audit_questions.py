"""Rebuild the shipped bank from source-checked records and write an audit trail."""
import argparse
import bisect
from collections import defaultdict
from copy import deepcopy
import csv
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re

import fitz

from question_bank import (BANK_KEYS, BANK_NAMES, PDF_BANKS, normalize, options,
                           reconcile, remap_answer)

ROOT = Path(__file__).resolve().parent
FILES = dict(zip(BANK_NAMES, ('1.版图知识竞赛题库.pdf', '2.国家版图知识竞赛题库.pdf',
                              '历年真题模拟汇编.pdf', '25年版图大赛题库.docx')))


def elementary_key(document):
    words = document[44].get_text('words')
    numbers = [w for w in words if w[4].isdigit() and 1 <= int(w[4]) <= 268]
    letters = [w for w in words if re.fullmatch('[A-D]+', w[4])]
    answers = {}
    for word in numbers:
        number = int(word[4])
        x, y = (word[0] + word[2]) / 2, (word[1] + word[3]) / 2
        candidates = [(a[1] - word[1], a[4]) for a in letters
                      if abs((a[0] + a[2]) / 2 - x) < 12 and 0 < a[1] - word[1] < 25]
        if not candidates and number > 260:
            candidates = [(abs((a[0] + a[2]) / 2 - x), a[4]) for a in document[45].get_text('words')
                          if re.fullmatch('[A-D]+', a[4]) and abs((a[0] + a[2]) / 2 - x) < 12]
        if candidates:
            answers[number] = min(candidates)[1]
    if len(answers) != 268:
        raise ValueError('Elementary answer table layout changed; review it before importing.')
    return answers


def historical_key(document):
    text = '\n'.join(page.get_text() for page in document)
    starts = list(re.finditer(r'(?m)^\s*(\d+)[、.．]\s*', text))
    answers = {}
    for index, start in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        answer = re.search(r'试题答案[：:]\s*([A-D]+)', text[start.end():end])
        if answer:
            answers[int(start[1])] = answer[1]
    if len(answers) != 632:
        raise ValueError('History answer format changed; review it before importing.')
    return answers


def locations(document, questions, page_limit):
    found = {}
    by_number = {q['num']: q for q in questions}
    for index, page in enumerate(document):
        if index >= page_limit:
            break
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                text = ''.join(span['text'] for span in line['spans']).strip()
                match = re.match(r'^(\d+)[.、．，,]?\s*(.*)', text)
                if not match or int(match[1]) not in by_number:
                    continue
                prefix = normalize(match[2]).rstrip('(')
                if len(prefix) < 3:
                    q = by_number[int(match[1])]
                    matches = [q] if match[2].strip() == '(' and q['title'].lstrip().startswith('(') else []
                else:
                    matches = [q for q in questions if q['id'] not in found and
                               (not q.get('page') or q['page'] == index + 1) and
                               normalize(q['title']).startswith(prefix)]
                    if len(matches) > 1:
                        numbered = [q for q in matches if q['num'] == int(match[1])]
                        if numbered:
                            matches = numbered
                if len(matches) == 1 and matches[0]['id'] not in found:
                    found[matches[0]['id']] = {'page': index + 1, 'top': line['bbox'][1]}
    return found


def source_figures(document, found, page_limit, root):
    ordered = sorted((p['page'] * 10000 + p['top'], qid) for qid, p in found.items())
    boundaries = [entry[0] for entry in ordered]
    groups = defaultdict(list)
    for index, page in enumerate(document):
        if index >= page_limit:
            break
        for image in page.get_image_info():
            rect = fitz.Rect(image['bbox'])
            if rect.width < 2 or rect.height < 2:
                continue
            position = (index + 1) * 10000 + (rect.y0 + rect.y1) / 2
            owner = bisect.bisect_right(boundaries, position) - 1
            if owner >= 0 and index + 1 - found[ordered[owner][1]]['page'] <= 1:
                groups[(ordered[owner][1], index)].append(rect)
    result = defaultdict(list)
    directory = root / 'assets' / 'verified'
    directory.mkdir(parents=True, exist_ok=True)
    for (qid, index), rectangles in groups.items():
        region = rectangles[0]
        for rect in rectangles[1:]:
            region |= rect
        region = fitz.Rect(region.x0 - 3, region.y0 - 3, region.x1 + 3, region.y1 + 3)
        region &= document[index].rect
        filename = f'assets/verified/{qid}_p{index+1}.png'
        document[index].get_pixmap(dpi=150, clip=region).save(root / filename)
        result[qid].append(filename)
    return result


def check_sources(banks, root):
    checked = deepcopy(banks)
    middle = json.loads((root / 'source_answer_keys.json').read_text())
    if hashlib.sha256((root / middle['file']).read_bytes()).hexdigest() != middle['sha256']:
        raise ValueError('Middle PDF changed; its manually verified answer table must be checked again.')
    verification = {}
    for name, page_limit in zip(PDF_BANKS, (44, 17, 105)):
        with fitz.open(root / FILES[name]) as document:
            key = (elementary_key(document) if name == PDF_BANKS[0] else
                   {int(n): answer for n, answer in middle['answers'].items()} if name == PDF_BANKS[1] else
                   historical_key(document))
            found = locations(document, checked[name], page_limit)
            figures = source_figures(document, found, page_limit, root)
            for q in checked[name]:
                q.setdefault('legacy_answer', q.get('answer', ''))
                q['source_answer'] = key[q['num']]
                q['source_reference'] = {'file': FILES[name], 'question_number': q['num']}
                if q['id'] in found:
                    q['page'] = found[q['id']]['page']
                    q['source_reference']['page'] = q['page']
                if name in PDF_BANKS[:2]:
                    q['source_reference']['answer_page'] = (45 if q['num'] <= 260 else 46) if name == PDF_BANKS[0] else 18
                q['images'] = figures.get(q['id'], [])
                if q['id'] == 'middle_234':
                    q.setdefault('legacy_options', q['options'])
                    q['options'] = ['A. A 地', 'B. B 地', 'C. C 地', 'D. D 地']
            verification[name] = {'file': FILES[name], 'answer_key_entries': len(key),
                                  'imported_questions': len(checked[name]), 'located_questions': len(found),
                                  'missing_question_numbers': sorted(set(key) - {q['num'] for q in checked[name]})}
    for q in checked['2025大赛题库']:
        q.setdefault('legacy_answer', q.get('answer', ''))
        q['source_reference'] = {'file': FILES['2025大赛题库'], 'question_number': q['num']}
    return checked, verification


def review_candidates(banks):
    by_options = defaultdict(list)
    for name in PDF_BANKS:
        for q in banks[name]:
            if q['scorable'] and not q['images']:
                by_options[tuple(sorted(options(q).values()))].append(q)
    suggestions = {}
    for q in banks['2025大赛题库']:
        if q['scorable'] or q['answer_status'] != 'missing' or q['images'] or not options(q):
            continue
        candidates = []
        for reference in by_options[tuple(sorted(options(q).values()))]:
            similarity = SequenceMatcher(None, normalize(q['title']), normalize(reference['title'])).ratio()
            if similarity >= 0.80:
                candidates.append({'reference_id': reference['id'], 'suggested_answer': remap_answer(reference, q),
                                   'similarity': round(similarity, 3), 'reference': reference['source_reference'],
                                   'reference_question': reference['title']})
        if candidates:
            suggestions[q['id']] = sorted(candidates, key=lambda c: -c['similarity'])[:3]
    return suggestions


def rebuild_question_bank(banks=None, root=ROOT):
    root = Path(root)
    saved = json.loads((root / 'raw_banks.json').read_text())
    if banks is None:
        banks = saved
    else:
        banks = deepcopy(banks)
        saved_by_id = {q['id']: q for bank in saved.values() for q in bank}
        for bank in banks.values():
            for q in bank:
                for field in ['legacy_answer', 'legacy_options']:
                    if field in saved_by_id.get(q['id'], {}):
                        q[field] = deepcopy(saved_by_id[q['id']][field])
    previous = json.loads((root / 'legacy_question_index.json').read_text())
    checked, source_checks = check_sources(banks, root)
    overrides = json.loads((root / 'answer_overrides.json').read_text())
    reviewed_path = root / 'reviewed_answers_2025.json'
    reviewed = json.loads(reviewed_path.read_text()) if reviewed_path.exists() else None
    if reviewed and reviewed['source_sha256'] != hashlib.sha256((root / FILES['2025大赛题库']).read_bytes()).hexdigest():
        raise ValueError('Reviewed DOCX changed; recheck the user-provided answers.')
    banks, unified, summary, conflicts = reconcile(checked, previous, root, overrides, reviewed)
    suggestions = review_candidates(banks)
    all_raw = [q for name in BANK_NAMES for q in banks[name]]
    corrections = [{'id': q['id'], 'question': q['title'], 'old_answer': q['legacy_answer'],
                    'new_answer': q['answer'], 'evidence': q['answer_evidence']}
                   for q in all_raw if q['scorable'] and q['legacy_answer'] and q['legacy_answer'] != q['answer']]
    filled = [q['id'] for q in all_raw if q['scorable'] and not q['legacy_answer']]
    withdrawn = [{'id': q['id'], 'old_answer': q['legacy_answer'], 'reason': q['pending_reason']}
                 for q in all_raw if q['legacy_answer'] and not q['scorable']]
    raw_to_uid = {raw_id: q['uid'] for q in unified for raw_id in q['source_ids']}
    split_groups = []
    for old in previous:
        # Only report proven member splits; stem-only legacy membership is preserved for first-run auditing.
        def old_normalize(text):
            text = re.sub(r'[\s\t\r\n\u3000\xa0]+', '', text)
            text = re.sub(r'[（(][^）)]*[）)]', '', text)
            return re.sub(r'[，。！？；：、“”‘’"\'\?,!:;_\-—…·~～]', '', text).lower()
        members = old.get('source_ids') or [q['id'] for q in all_raw
                                           if old_normalize(q['title']) == old_normalize(old['question'])]
        current_ids = sorted({raw_to_uid[raw_id] for raw_id in members})
        if len(current_ids) > 1 and not any(group['old_uid'] == old['uid'] for group in split_groups):
            split_groups.append({'old_uid': old['uid'], 'source_ids': members, 'current_uids': current_ids})
    summary['handbook_pages_count'] = 39
    active = [q for q in unified if q['scorable']]
    pending = [q for q in unified if not q['scorable']]
    active_banks = {BANK_KEYS[name]: [q for q in banks[name] if q['scorable']] for name in BANK_NAMES}
    summary['active_counts_by_bank'] = {name: len(active_banks[BANK_KEYS[name]]) for name in BANK_NAMES}
    summary['active_images'] = sum(bool(q['images']) for q in active)
    summary['active_high_frequency'] = sum(len(q['sources']) > 1 for q in active)
    # Preserve the previous shipped index order for users upgrading from the unfiltered bank.
    migration_path = root / 'bank_progress_migrations.json'
    migrations = json.loads(migration_path.read_text()) if migration_path.exists() else {}
    browser_path = root / 'questions_data.js'
    if browser_path.exists():
        old_data = json.loads(browser_path.read_text().removeprefix('window.BEAUTIFUL_CHINA_DATA = ').strip().removesuffix(';'))
        old_revision = old_data['summary'].get('bank_revision')
        if old_revision and old_revision != summary['bank_revision'] and old_revision not in migrations:
            migrations[old_revision] = {'unified': [q['uid'] for q in old_data['unified']],
                **{key: [q['id'] for q in bank] for key, bank in old_data['banks'].items()},
                'images': [q['uid'] for q in old_data['unified'] if q['images']],
                'high_freq': [q['uid'] for q in old_data['unified'] if len(q['sources']) > 1]}
    migration_path.write_text(json.dumps(migrations, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    report = {'source_checks': source_checks, 'summary': summary,
              'corrected_answers': corrections, 'filled_answers': filled,
              'withdrawn_answers': withdrawn, 'source_conflicts': conflicts,
              'split_legacy_groups': split_groups, 'review_candidates': suggestions,
              'note': '已有答案仅表示与原文件或已核对的同题一致，不代表独立核验了原资料所有知识性结论。'}
    if reviewed:
        report['shared_review_import'] = {
            'source_url': reviewed['source_url'], 'source_sha256': reviewed['source_sha256'],
            'recovered_questions': len(reviewed['questions']),
            'accepted_review_answers': sum(q['accepted'] for q in reviewed['questions'].values()),
            'review_withheld': sum(not q['accepted'] for q in reviewed['questions'].values()),
            'usable_2025_questions': len(active_banks['contest25']),
            'excluded_2025_questions': len(banks['2025大赛题库']) - len(active_banks['contest25']),
            'policy': reviewed['policy'],
        }
    for filename, value in [('raw_banks.json', banks), ('unified_questions.json', unified),
                            ('deduplication_summary.json', summary), ('question_audit.json', report)]:
        (root / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    (root / 'pending_questions.json').write_text(json.dumps(pending, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    data = {'summary': summary, 'unified': active, 'banks': active_banks,
            'progress_migrations': migrations,
            'original_bank_order': {BANK_KEYS[name]: [q['id'] for q in banks[name]] for name in BANK_NAMES}}
    (root / 'questions_data.js').write_text('window.BEAUTIFUL_CHINA_DATA = ' + json.dumps(data, ensure_ascii=False, sort_keys=True) + ';\n')
    with (root / 'answer_review.csv').open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.writer(file, lineterminator='\n')
        writer.writerow(['统一题号', '来源题号', '待核验原因', '题干', '选项', '候选答案（未经确认）', '候选依据'])
        for q in unified:
            if q['scorable']:
                continue
            candidate = next((suggestions[r][0] for r in q['source_ids'] if r in suggestions), None)
            writer.writerow([q['uid'], ' / '.join(q['source_ids']), q['pending_reason'], q['question'],
                             ' | '.join(q['options']), candidate['suggested_answer'] if candidate else '',
                             json.dumps(candidate, ensure_ascii=False) if candidate else ''])
    with (root / 'confirmed_answers_2025.csv').open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.writer(file, lineterminator='\n')
        writer.writerow(['原题号', '答案', '答案形式', '题干', '选项', '解析', '核对结论', '来源'])
        for q in banks['2025大赛题库']:
            if q['scorable']:
                evidence = q['answer_evidence'][0]
                form = '按顺序填空' if q.get('answer_mode') == 'ordered' else '多选' if len(q['answer']) > 1 else '单选'
                writer.writerow([q['num'], q['answer'], form, q['title'],
                    ' | '.join(q['options']), q.get('answer_explanation', ''), evidence.get('review_state', ''),
                    evidence.get('url', evidence['file'])])
    print(json.dumps({'total': len(unified), 'scorable': summary['scorable_questions'],
                      'pending': summary['pending_questions'], 'corrected': len(corrections),
                      'newly_filled': len(filled), 'conflict_groups': len(conflicts),
                      'split_groups': len(split_groups), 'review_candidates': len(suggestions)}, ensure_ascii=False))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    rebuild_question_bank(root=parser.parse_args().root)
