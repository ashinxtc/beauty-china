# -*- coding: utf-8 -*-
"""
Beautiful China - National Territory Knowledge Competition Question Parser & Deduplication Engine (v2)
Extracts questions across four sources; the audit pipeline verifies answer keys and quarantines unresolved issues:
1. 1.版图知识竞赛题库.pdf (小学组)
2. 2.国家版图知识竞赛题库.pdf (中学组)
3. 历年真题模拟汇编.pdf (历年真题)
4. 25年版图大赛题库.docx (2025新赛题)
"""

import os
import re
import json
import zipfile
import fitz
import docx
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_IMG_DIR = os.path.join(BASE_DIR, "assets", "images")
os.makedirs(ASSETS_IMG_DIR, exist_ok=True)

def normalize_text(text):
    if not text:
        return ""
    t = text.strip()
    t = re.sub(r'^[0-9]+[\.、\uff0e\s]+', '', t)
    t = re.sub(r'[\s\t\r\n\u3000\xa0]+', '', t)
    t = re.sub(r'[（\(][^\)）]*[）\)]', '', t) # remove parenthetical tags
    t = re.sub(r'[，。！？；：、“”‘’""\'\?,!:;_\-—…·~～]', '', t)
    return t.lower()

# ==========================================
# 1. Parse 1.版图知识竞赛题库.pdf (小学组)
# ==========================================
def parse_pdf1():
    print("Parsing 1.版图知识竞赛题库.pdf (小学组)...")
    pdf_path = os.path.join(BASE_DIR, "1.版图知识竞赛题库.pdf")
    doc = fitz.open(pdf_path)
    
    # 1.1 Answers
    answers = {}
    for page_idx in [44, 45]:
        words = doc[page_idx].get_text("words")
        bands = []
        for w in sorted(words, key=lambda x: (x[1], x[0])):
            if not bands or abs(w[1] - bands[-1][0][1]) > 8:
                bands.append([w])
            else:
                bands[-1].append(w)
        
        b_idx = 0
        while b_idx < len(bands):
            band = sorted(bands[b_idx], key=lambda x: x[0])
            txts = [w[4] for w in band]
            if all(t.isdigit() for t in txts):
                num_list = [int(t) for t in txts]
                next_b = b_idx + 1
                while next_b < len(bands):
                    next_band = sorted(bands[next_b], key=lambda x: x[0])
                    next_txts = [w[4] for w in next_band]
                    if all(t.isdigit() for t in next_txts) and len(num_list) + len(next_txts) <= 10:
                        num_list.extend([int(t) for t in next_txts])
                        next_b += 1
                    else:
                        break
                ans_list = []
                while next_b < len(bands) and len(ans_list) < len(num_list):
                    ans_band = sorted(bands[next_b], key=lambda x: x[0])
                    ans_txts = [w[4] for w in ans_band]
                    if all(t.isalpha() for t in ans_txts):
                        ans_list.extend(ans_txts)
                        next_b += 1
                    else:
                        break
                if len(num_list) == len(ans_list):
                    for n, a in zip(num_list, ans_list):
                        answers[n] = a
                b_idx = next_b
            else:
                b_idx += 1

    extra_ans = ["B", "B", "B", "A", "B", "ABD", "ABCD", "ABD"]
    for i, a in enumerate(extra_ans):
        answers[261 + i] = a

    # 1.2 Images
    page_images = defaultdict(list)
    for p_idx in range(1, 44):
        page = doc[p_idx]
        imgs = page.get_images()
        for img_idx, img_info in enumerate(imgs):
            xref = img_info[0]
            base_img = doc.extract_image(xref)
            if base_img["width"] >= 60 and base_img["height"] >= 60:
                img_ext = base_img["ext"]
                img_filename = f"elem_p{p_idx+1}_img{img_idx+1}.{img_ext}"
                img_path = os.path.join(ASSETS_IMG_DIR, img_filename)
                if not os.path.exists(img_path):
                    with open(img_path, "wb") as f:
                        f.write(base_img["image"])
                page_images[p_idx + 1].append(f"assets/images/{img_filename}")

    # 1.3 Questions by visual blocks (sort blocks by y, then x)
    raw_lines = []
    for p_idx in range(1, 44):
        page = doc[p_idx]
        # get blocks sorted visually
        blocks = page.get_text("blocks")
        # sort blocks primarily by y-top, but handle 2 columns if any (here it is 1 col)
        blocks = sorted(blocks, key=lambda b: (b[1], b[0]))
        for b in blocks:
            text = b[4].strip()
            if text:
                for line in text.split("\n"):
                    l = line.strip()
                    if l:
                        raw_lines.append((p_idx + 1, l))

    questions = []
    current_q = None

    for page_num, line in raw_lines:
        # Skip standalone page numbers or headers
        if line.isdigit() and int(line) == page_num:
            continue
        if "国家版图知识竞赛" in line or "备赛资料包" in line or "样题库" in line:
            continue

        m = re.match(r"^(\d+)[\.、\uff0e]\s*(.*)", line)
        if m and int(m.group(1)) <= 300:
            q_num = int(m.group(1))
            if current_q:
                questions.append(current_q)
            current_q = {
                "id": f"elem_{q_num:03d}",
                "source": "小学组样题库",
                "num": q_num,
                "title": m.group(2).strip(),
                "options": [],
                "answer": answers.get(q_num, ""),
                "images": page_images.get(page_num, []) if any(k in m.group(2) for k in ["下图", "图中", "看图", "照片", "轮廓", "卫星"]) else [],
                "page": page_num
            }
            continue

        if current_q:
            opt_m = re.match(r"^([A-E])[\.、\uff0e\s]*(.*)", line)
            if opt_m and len(line) > 1:
                current_q["options"].append(f"{opt_m.group(1)}. {opt_m.group(2).strip()}")
            else:
                if not current_q["options"]:
                    current_q["title"] += " " + line
                    if any(k in line for k in ["下图", "图中", "看图", "照片", "轮廓", "卫星"]) and not current_q["images"]:
                        current_q["images"] = page_images.get(page_num, [])
                else:
                    current_q["options"][-1] += " " + line

    if current_q:
        questions.append(current_q)

    # Clean options
    for q in questions:
        expanded_opts = []
        for opt in q["options"]:
            sub_opts = re.findall(r'([A-E][\.、\uff0e\s][^A-E]+)', opt)
            if len(sub_opts) > 1:
                expanded_opts.extend([s.strip() for s in sub_opts])
            else:
                expanded_opts.append(opt)
        q["options"] = expanded_opts
        q["type"] = "multi" if len(q["answer"]) > 1 else "single"

    # Sort questions by num
    questions = sorted(questions, key=lambda q: q["num"])
    print(f"  PDF 1 parsed: {len(questions)} questions (answers matched: {sum(1 for q in questions if q['answer'])})")
    return questions

# ==========================================
# 2. Parse 2.国家版图知识竞赛题库.pdf (中学组)
# ==========================================
def parse_pdf2():
    print("Parsing 2.国家版图知识竞赛题库.pdf (中学组)...")
    pdf_path = os.path.join(BASE_DIR, "2.国家版图知识竞赛题库.pdf")
    doc = fitz.open(pdf_path)

    ans_table = [
        'C', 'B', 'A', 'B', 'A', 'B', 'C', 'D', 'C', 'A',
        'A', 'D', 'C', 'C', 'B', 'C', 'B', 'B', 'A', 'D',
        'A', 'D', 'C', 'A', 'D', 'A', 'A', 'B', 'B', 'C',
        'D', 'C', 'B', 'C', 'D', 'B', 'D', 'D', 'C', 'C',
        'C', 'A', 'B', 'D', 'C', 'C', 'B', 'A', 'B', 'D',
        'C', 'A', 'B', 'A', 'C', 'A', 'C', 'B', 'B', 'B',
        'B', 'C', 'A', 'C', 'D', 'C', 'B', 'D', 'D', 'D',
        'B', 'D', 'C', 'B', 'B', 'B', 'B', 'B', 'A', 'D',
        'B', 'A', 'C', 'A', 'C', 'C', 'C', 'C', 'A', 'A',
        'C', 'A', 'D', 'D', 'A', 'A', 'B', 'B', 'A', 'B',
        'C', 'D', 'D', 'B', 'B', 'C', 'D', 'B', 'B', 'B',
        'A', 'A', 'B', 'C', 'A', 'C', 'B', 'B', 'A', 'C',
        'B', 'C', 'B', 'C', 'C', 'C', 'B', 'C', 'A', 'A',
        'A', 'D', 'A', 'C', 'D', 'C', 'B', 'D', 'B', 'C',
        'D', 'A', 'A', 'D', 'D', 'C', 'B', 'C', 'C', 'A',
        'C', 'A', 'C', 'A', 'C', 'B', 'C', 'D', 'B', 'C',
        'C', 'C', 'A', 'D', 'B', 'A', 'B', 'C', 'C', 'D',
        'D', 'B', 'B', 'B', 'C', 'B', 'C', 'D', 'B', 'D',
        'B', 'A', 'C', 'C', 'A', 'B', 'C', 'B', 'D', 'A',
        'D', 'C', 'B', 'B', 'D', 'B', 'D', 'B', 'A', 'A',
        'D', 'D', 'C', 'A', 'D', 'C', 'B', 'B', 'A', 'A',
        'B', 'A', 'B', 'C', 'D', 'C', 'A', 'D', 'D', 'A',
        'A', 'B', 'C', 'A', 'B', 'B', 'B', 'A', 'B', 'D',
        'A', 'B', 'C', 'B', 'B', 'D', 'D', 'B', 'D', 'C',
        'D', 'A', 'B', 'C', 'B', 'A', 'B', 'D', 'A', 'D',
        'D', 'C', 'B', 'D', 'C', 'D', 'B', 'D', 'D', 'B',
        'A', 'B', 'ABCD', 'ABC', 'AB', 'ABD', 'ABCD', 'ABD'
    ]
    answers = {i + 1: ans for i, ans in enumerate(ans_table)}

    # Images
    page_images = defaultdict(list)
    for p_idx in range(len(doc) - 1):
        page = doc[p_idx]
        imgs = page.get_images()
        for img_idx, img_info in enumerate(imgs):
            xref = img_info[0]
            base_img = doc.extract_image(xref)
            if base_img["width"] >= 60 and base_img["height"] >= 60:
                img_ext = base_img["ext"]
                img_filename = f"middle_p{p_idx+1}_img{img_idx+1}.{img_ext}"
                img_path = os.path.join(ASSETS_IMG_DIR, img_filename)
                if not os.path.exists(img_path):
                    with open(img_path, "wb") as f:
                        f.write(base_img["image"])
                page_images[p_idx + 1].append(f"assets/images/{img_filename}")

    # Lines
    raw_lines = []
    for p_idx in range(len(doc) - 1):
        page = doc[p_idx]
        blocks = page.get_text("blocks")
        blocks = sorted(blocks, key=lambda b: (b[1], b[0]))
        for b in blocks:
            text = b[4].strip()
            if text:
                for line in text.split("\n"):
                    l = line.strip()
                    if l:
                        raw_lines.append((p_idx + 1, l))

    questions = []
    current_q = None
    expected_num = 1

    for page_num, line in raw_lines:
        if line.isdigit() and int(line) == page_num:
            continue
        if "国家版图知识竞赛" in line:
            continue
        
        # Match question start, including without punctuation (e.g. 233能够直观)
        m = re.match(r"^(\d+)[\.、\uff0e\s\t]*(.*)", line)
        if m and int(m.group(1)) <= 300:
            parsed_num = int(m.group(1))
            rest = m.group(2).strip()
            
            # Check if this is indeed a question line (not option or random text)
            if len(rest) >= 2 or not rest:
                # Handle numbering typos in original PDF (21, 21, 21 -> 21, 22, 23; 100, 100 -> 100, 101)
                actual_num = parsed_num
                if parsed_num < expected_num and expected_num - parsed_num <= 3:
                    actual_num = expected_num
                else:
                    actual_num = parsed_num
                
                expected_num = actual_num + 1

                if current_q:
                    questions.append(current_q)
                current_q = {
                    "id": f"middle_{actual_num:03d}",
                    "source": "中学组样题库",
                    "num": actual_num,
                    "title": rest,
                    "options": [],
                    "answer": answers.get(actual_num, ""),
                    "images": page_images.get(page_num, []) if any(k in rest for k in ["下图", "图中", "看图", "照片", "轮廓", "卫星"]) else [],
                    "page": page_num
                }
                continue

        if current_q:
            opt_m = re.match(r"^([A-E])[\.、\uff0e\s]*(.*)", line)
            if opt_m and len(line) > 1:
                current_q["options"].append(f"{opt_m.group(1)}. {opt_m.group(2).strip()}")
            else:
                if not current_q["options"]:
                    current_q["title"] += " " + line
                    if any(k in line for k in ["下图", "图中", "看图", "照片", "轮廓", "卫星"]) and not current_q["images"]:
                        current_q["images"] = page_images.get(page_num, [])
                else:
                    current_q["options"][-1] += " " + line

    if current_q:
        questions.append(current_q)

    # Clean options
    for q in questions:
        expanded_opts = []
        for opt in q["options"]:
            sub_opts = re.findall(r'([A-E][\.、\uff0e\s][^A-E]+)', opt)
            if len(sub_opts) > 1:
                expanded_opts.extend([s.strip() for s in sub_opts])
            else:
                expanded_opts.append(opt)
        q["options"] = expanded_opts
        q["type"] = "multi" if len(q["answer"]) > 1 else "single"

    print(f"  PDF 2 parsed: {len(questions)} questions (answers matched: {sum(1 for q in questions if q['answer'])})")
    return questions

# ==========================================
# 3. Parse 历年真题模拟汇编.pdf (632题)
# ==========================================
def parse_pdf3():
    print("Parsing 历年真题模拟汇编.pdf (历年真题)...")
    pdf_path = os.path.join(BASE_DIR, "历年真题模拟汇编.pdf")
    doc = fitz.open(pdf_path)

    full_text = ""
    for page in doc:
        full_text += "\n" + page.get_text("text")

    lines = [l.strip() for l in full_text.split("\n") if l.strip()]
    questions = []
    current_q = None

    for line in lines:
        if any(h in line for h in ["国家版图知识竞赛真题模拟汇编", "共632 题", "备考正在进行中", "预祝大家考试取得优异成绩"]):
            continue
        
        # Match question start e.g. "1、以下哪项不是..."
        m = re.match(r"^(\d+)[、\.\uff0e]\s*(.*)", line)
        if m and int(m.group(1)) <= 700:
            q_num = int(m.group(1))
            if current_q:
                questions.append(current_q)
            current_q = {
                "id": f"history_{q_num:03d}",
                "source": "历年真题汇编",
                "num": q_num,
                "title": m.group(2).strip(),
                "options": [],
                "answer": "",
                "images": [],
                "type": "single"
            }
            continue

        if current_q:
            if "试题答案：" in line or "答案：" in line:
                ans_str = re.sub(r".*答案[：:]\s*", "", line).strip()
                current_q["answer"] = ans_str
                continue
            
            opt_m = re.match(r"^([A-D])[\.、\uff0e\s]*(.*)", line)
            if opt_m:
                current_q["options"].append(f"{opt_m.group(1)}. {opt_m.group(2).strip()}")
            else:
                if not current_q["options"]:
                    current_q["title"] += " " + line
                else:
                    current_q["options"][-1] += " " + line

    if current_q:
        questions.append(current_q)

    for q in questions:
        q["title"] = re.sub(r'（）\s*（单选题）', '（）', q["title"])
        q["title"] = re.sub(r'（单选题）', '', q["title"]).strip()

    print(f"  PDF 3 parsed: {len(questions)}/632 questions (answers: {sum(1 for q in questions if q['answer'])})")
    return questions

# ==========================================
# 4. Parse 25年版图大赛题库.docx (1143题)
# ==========================================
def parse_docx():
    print("Parsing 25年版图大赛题库.docx (2025新赛题)...")
    docx_path = os.path.join(BASE_DIR, "25年版图大赛题库.docx")
    
    # 4.1 Extract media images and their relationship IDs
    doc_zip = zipfile.ZipFile(docx_path, 'r')
    rels_xml = doc_zip.read('word/_rels/document.xml.rels').decode('utf-8')
    rel_id_to_target = {}
    for m in re.finditer(r'Id="([^"]+)"\s+Type="[^"]*image"\s+Target="([^"]+)"', rels_xml):
        rel_id = m.group(1)
        target = m.group(2)
        img_name = os.path.basename(target)
        target_zip_path = "word/" + target if not target.startswith("word/") else target
        if target_zip_path in doc_zip.namelist():
            img_data = doc_zip.read(target_zip_path)
            dest_file = f"docx_{img_name}"
            dest_path = os.path.join(ASSETS_IMG_DIR, dest_file)
            if not os.path.exists(dest_path):
                with open(dest_path, "wb") as f:
                    f.write(img_data)
            rel_id_to_target[rel_id] = f"assets/images/{dest_file}"

    doc = docx.Document(docx_path)
    questions = []
    current_q = None

    for p in doc.paragraphs:
        t = p.text.strip()
        p_xml = p._element.xml
        
        blip_ids = re.findall(r'r:embed="([^"]+)"', p_xml)
        para_images = [rel_id_to_target[bid] for bid in blip_ids if bid in rel_id_to_target]

        m = re.match(r"^(\d+)[\.、\uff0e\s]+(.*)", t, re.S)
        if m and (t.endswith("（）。") or t.endswith("（）") or "的是" in t or "下列" in t or "关于" in t or "我国" in t or len(t) > 5):
            q_num = int(m.group(1))
            if current_q:
                questions.append(current_q)
            current_q = {
                "id": f"contest25_{q_num:04d}",
                "source": "2025大赛题库",
                "num": q_num,
                "title": m.group(2).strip(),
                "options": [],
                "answer": "",
                "images": para_images,
                "type": "single"
            }
            continue

        if current_q:
            if para_images:
                current_q["images"].extend(para_images)
            if not t:
                continue
            
            opt_m = re.match(r"^([A-F])[\.、\uff0e\s]+(.*)", t, re.S)
            if opt_m:
                current_q["options"].append(f"{opt_m.group(1)}. {opt_m.group(2).strip()}")
            else:
                if not current_q["options"]:
                    current_q["title"] += " " + t
                else:
                    current_q["options"][-1] += " " + t

    if current_q:
        questions.append(current_q)

    for q in questions:
        q["images"] = list(dict.fromkeys(q["images"]))
        if "多选" in q["title"] or "下列哪些" in q["title"]:
            q["type"] = "multi"

    print(f"  DOCX parsed: {len(questions)}/1143 questions")
    return questions

# ==========================================
# 5. Deduplication and Cross-Comparison
# ==========================================
def compare_and_deduplicate(all_banks):
    # Reuse the source-checked importer, option-content matching and complete-question identity.
    from audit_questions import rebuild_question_bank
    return rebuild_question_bank(all_banks, BASE_DIR)["summary"]


def main():
    q_elem = parse_pdf1()
    q_middle = parse_pdf2()
    q_hist = parse_pdf3()
    q_2025 = parse_docx()

    all_banks = {
        "小学组样题库": q_elem,
        "中学组样题库": q_middle,
        "历年真题汇编": q_hist,
        "2025大赛题库": q_2025
    }

    summary = compare_and_deduplicate(all_banks)

if __name__ == "__main__":
    main()
