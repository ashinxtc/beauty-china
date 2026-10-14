"""Answer matching rules and invariants for the exact data shipped to the browser."""
import json
from pathlib import Path
import tempfile
import unittest

from question_bank import (BANK_NAMES, BANK_KEYS, normalize, options, question_identity,
                           reconcile, remap_answer)

ROOT = Path(__file__).resolve().parent


def question(qid, title='测试题（）', choices=None, answer='A', images=None):
    return {'id': qid, 'num': 1, 'source': BANK_NAMES[0], 'title': title,
            'options': choices or ['A. 甲', 'B. 乙'], 'answer': answer, 'source_answer': answer,
            'source_reference': {'file': 'source.pdf', 'question_number': 1},
            'images': images or [], 'type': 'single'}


class MatchingRules(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_option_permutation_maps_content_instead_of_letters(self):
        source = question('source', choices=['A. 八', 'B. 六'])
        target = question('target', choices=['A. 六', 'B. 八'], answer='')
        self.assertEqual(remap_answer(source, target), 'B')

    def test_multiple_answers_are_remapped_and_sorted(self):
        source = question('source', choices=['A. 甲', 'B. 乙', 'C. 丙'], answer='AB')
        target = question('target', choices=['A. 乙', 'B. 丙', 'C. 甲'], answer='')
        self.assertEqual(remap_answer(source, target), 'AC')

    def test_meaningful_parentheses_and_decimal_values_are_preserved(self):
        self.assertNotEqual(normalize('时差（东八区）'), normalize('时差（东九区）'))
        self.assertNotEqual(normalize('海拔8844.43米'), normalize('海拔884443米'))
        self.assertEqual(normalize('测试题（ ）。（单选题）'), normalize('测试题()'))

    def test_different_options_and_different_images_are_different_questions(self):
        source = question('a')
        target = question('b', choices=['A. 甲', 'B. 丙'])
        self.assertNotEqual(question_identity(source, self.root), question_identity(target, self.root))
        (self.root / 'one.png').write_bytes(b'one')
        (self.root / 'two.png').write_bytes(b'two')
        source['images'], target['images'] = ['one.png'], ['two.png']
        target['options'] = source['options']
        self.assertNotEqual(question_identity(source, self.root), question_identity(target, self.root))

    def test_unseen_picture_questions_cannot_be_merged(self):
        source = question('a', title='下图是哪里？')
        target = question('b', title='下图是哪里？')
        self.assertNotEqual(question_identity(source, self.root), question_identity(target, self.root))

    def test_conflicting_source_answers_are_withheld(self):
        banks = {name: [] for name in BANK_NAMES}
        banks[BANK_NAMES[0]] = [question('a', answer='A')]
        banks[BANK_NAMES[1]] = [question('b', answer='B')]
        revised, unified, _, conflicts = reconcile(banks, [], self.root, {})
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(unified[0]['answer'], '')
        self.assertFalse(revised[BANK_NAMES[0]][0]['scorable'])

    def test_matching_uses_complete_options_and_ignores_legacy_copied_letters(self):
        banks = {name: [] for name in BANK_NAMES}
        banks[BANK_NAMES[0]] = [question('a')]
        banks[BANK_NAMES[3]] = [question('b', choices=['A. 乙', 'B. 甲'], answer='A'),
                              question('c', choices=['A. 丙', 'B. 甲'], answer='A')]
        revised, _, _, _ = reconcile(banks, [], self.root, {})
        self.assertEqual(revised[BANK_NAMES[3]][0]['answer'], 'B')
        self.assertEqual(revised[BANK_NAMES[3]][1]['answer'], '')

    def test_reordered_variants_keep_separate_uids_and_old_letter_meanings(self):
        banks = {name: [] for name in BANK_NAMES}
        banks[BANK_NAMES[0]] = [question('a')]
        banks[BANK_NAMES[3]] = [question('b', choices=['A. 乙', 'B. 甲'], answer='')]
        previous = [{'uid': 'Q_0001', 'original_id': 'a', 'question': '测试题'}]
        _, unified, summary, _ = reconcile(banks, previous, self.root, {})
        self.assertEqual(len(unified), 2)
        self.assertEqual(unified[0]['uid'], 'Q_0001')
        self.assertEqual(unified[0]['answer'], 'A')
        self.assertEqual(unified[1]['answer'], 'B')
        self.assertEqual(summary['legacy_uid_map']['Q_0001'], 'Q_0001')


class ShippedBank(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.banks = json.loads((ROOT / 'raw_banks.json').read_text())
        cls.unified = json.loads((ROOT / 'unified_questions.json').read_text())
        cls.summary = json.loads((ROOT / 'deduplication_summary.json').read_text())
        cls.raw = {q['id']: q for bank in cls.banks.values() for q in bank}

    def test_browser_data_exactly_matches_the_audited_json(self):
        text = (ROOT / 'questions_data.js').read_text()
        data = json.loads(text.removeprefix('window.BEAUTIFUL_CHINA_DATA = ').strip().removesuffix(';'))
        self.assertEqual(data['unified'], [q for q in self.unified if q['scorable']])
        self.assertEqual(data['summary'], self.summary)
        for name, key in BANK_KEYS.items():
            self.assertEqual(data['banks'][key], [q for q in self.banks[name] if q['scorable']])
        pending = json.loads((ROOT / 'pending_questions.json').read_text())
        self.assertEqual(pending, [q for q in self.unified if not q['scorable']])
        self.assertFalse({q['uid'] for q in data['unified']} & {q['uid'] for q in pending})

    def test_every_scorable_answer_has_valid_options_type_and_evidence(self):
        for q in [*self.raw.values(), *self.unified]:
            if not q['scorable']:
                self.assertEqual(q['answer'], '')
                self.assertTrue(q['pending_reason'])
                continue
            with self.subTest(id=q.get('id', q.get('uid'))):
                choices = options(q)
                self.assertIsNotNone(choices)
                self.assertTrue(all(letter in choices for letter in q['answer']))
                self.assertEqual(q['type'], 'multi' if len(q['answer']) > 1 else 'single')
                self.assertTrue(q['answer_evidence'])

    def test_confirmed_corrections_and_new_answers(self):
        for qid, answer in [('middle_117', 'C'), ('contest25_0326', 'B'),
                            ('contest25_0587', 'D'), ('contest25_1029', 'B'),
                            ('contest25_0526', 'C'), ('contest25_0125', 'D')]:
            self.assertEqual(self.raw[qid]['answer'], answer)
        self.assertEqual(len(self.raw['middle_234']['options']), 4)
        self.assertEqual(self.raw['contest25_1112']['answer'], 'D')
        for number, answer in [(11, 'ABCDE'), (19, 'D'), (425, 'D'), (787, 'A'), (159, 'A'), (697, 'A')]:
            self.assertEqual(self.raw[f'contest25_{number:04d}']['answer'], answer)
        for number in [14,379,391,523,524,608,611,696,888,902,1051]:
            self.assertFalse(self.raw[f'contest25_{number:04d}']['scorable'])
        self.assertEqual(len(self.raw['contest25_0403']['options']), 6)

    def test_all_records_are_present_once_and_all_legacy_uids_are_reachable(self):
        members = [qid for q in self.unified for qid in q['source_ids']]
        self.assertEqual(len(members), len(set(members)))
        self.assertEqual(set(members), set(self.raw))
        reachable = {uid for q in self.unified for uid in [q['uid'], *q['legacy_uids']]}
        previous = json.loads((ROOT / 'legacy_question_index.json').read_text())
        self.assertTrue({q['uid'] for q in previous}.issubset(reachable))

    def test_matched_answers_trace_to_scorable_source_options(self):
        overrides = json.loads((ROOT / 'answer_overrides.json').read_text())
        reviewed = json.loads((ROOT / 'reviewed_answers_2025.json').read_text())
        for q in self.banks['2025大赛题库']:
            if not q['scorable']:
                continue
            evidence = q['answer_evidence'][0]
            if q['answer_status'] == 'reviewed':
                decision = reviewed['questions'][q['id']]
                self.assertTrue(decision['accepted'])
                self.assertEqual(q['answer'], decision['answer'])
                self.assertEqual(q['options'], decision['expected_options'])
                self.assertEqual(evidence['url'], reviewed['source_url'])
                continue
            reference = self.raw[evidence['id']]
            self.assertTrue(reference['scorable'])
            mapped = remap_answer(reference, q)
            if mapped:
                self.assertEqual(mapped, q['answer'])
            else:
                self.assertTrue(overrides[q['id']]['reviewed_content_variation'])

    def test_every_diagram_path_exists_and_source_conflicts_are_not_scored(self):
        for q in self.raw.values():
            for filename in q['images']:
                self.assertTrue((ROOT / filename).is_file(), filename)
            if q['answer_status'] in ['missing_diagram', 'source_conflict', 'invalid_options']:
                self.assertFalse(q['scorable'])
        for qid in ['elem_159', 'history_492', 'history_111']:
            self.assertFalse(self.raw[qid]['scorable'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
