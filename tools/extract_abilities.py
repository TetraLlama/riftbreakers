"""Extract combat Abilities from your own copy of the Riftbreakers 2e PDF.

Usage:
    python tools/extract_abilities.py path/to/Riftbreakers_2e.pdf

Writes two files:
    js/abilities.js            stats only (name, heart, cost, range, action,
                               defense, prime). Safe to commit.
    private/abilities-full.json  stats + full rules text. Gitignored. Import it
                               into a room from the app's Library tab so the
                               effect text shows up on your cards.

Needs `pdftotext` on PATH (ships with Git for Windows / poppler), or
`pip install pypdf` as a fallback.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

NAME_RE = re.compile(r"^([A-Z][A-Z0-9 '\-(),&!:.]+?)\s*$")
HEART_RE = re.compile(r"^\s*([A-Z][a-z]+) Heart\s*$")
COST_RE = re.compile(r"^Cost:\s*(\d+)\s*/(.*)$")


def pdf_text(pdf: Path) -> str:
    if shutil.which("pdftotext"):
        out = subprocess.run(
            ["pdftotext", "-layout", str(pdf), "-"],
            capture_output=True, check=True,
        )
        return out.stdout.decode("utf-8", errors="replace")
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("Need pdftotext on PATH or `pip install pypdf`.")
    return "\n".join(p.extract_text(extraction_mode="layout") or "" for p in PdfReader(str(pdf)).pages)


def parse_cost_line(rest: str) -> dict:
    parts = [p.strip() for p in rest.split("/") if p.strip()]
    info = {"range": "", "action": "Standard", "defense": ""}
    for p in parts:
        if p.lower() == "self":
            info["range"] = "Self"
        elif p.startswith("Range:"):
            info["range"] = p.split(":", 1)[1].strip()
        elif p.startswith("Defense:"):
            info["defense"] = p.split(":", 1)[1].strip()
        elif "Reaction" in p:
            info["action"] = "Reaction"
        elif "Standard" in p:
            info["action"] = "Standard"
    return info


def source_for(lines, i, heart):
    """Figure out where an ability comes from by the section it sits in."""
    if heart:
        return heart
    window = "\n".join(lines[max(0, i - 400):i])
    if "LOADOUT ABILITY" in window and "PASSIVE TRAITS" not in window.split("LOADOUT ABILITY")[-1]:
        return "Companion"
    return "Other"


def extract(text: str):
    lines = text.replace("\f", "\n").splitlines()
    abilities = []
    heart = None
    hearts_done = False
    i = 0
    while i < len(lines):
        line = lines[i]
        m = HEART_RE.match(line)
        if m and not hearts_done:
            heart = m.group(1)
        if "Creating Your Character" in line and heart:
            hearts_done = True
            heart = None
        if "NON-COMBAT ABILITIES" in line:
            # Non-combat abilities have no Aether cost; skip until next heart.
            pass

        cost = COST_RE.match(line.strip())
        if cost:
            # Walk back to the name, noting a (Prime) tag on the way.
            prime = False
            j = i - 1
            name = None
            while j >= 0 and i - j <= 4:
                s = lines[j].strip()
                if s == "(Prime)":
                    prime = True
                elif s and NAME_RE.match(s):
                    name = NAME_RE.match(s).group(1).strip()
                    break
                j -= 1
            if name:
                desc = []
                k = i + 1
                while k < len(lines):
                    s = lines[k].rstrip()
                    if not s.strip():
                        break
                    if HEART_RE.match(s) or s.strip() in ("The Player Characters", "The Core Rules"):
                        break
                    desc.append(s.strip())
                    k += 1
                entry = {
                    "name": name.title().replace("'S", "'s"),
                    "source": source_for(lines, i, None if hearts_done else heart),
                    "cost": int(cost.group(1)),
                    "prime": prime,
                    **parse_cost_line(cost.group(2)),
                    "text": " ".join(desc),
                }
                abilities.append(entry)
        i += 1

    for a in abilities:
        if a["source"] == "Other":
            if "Strike (" in a["name"]:
                a["source"] = "Weapon"
            elif a["name"] == "Companion":
                a["source"] = "Companion"
            else:
                a["source"] = "Achievement"

    # De-duplicate by name+source (some abilities are reprinted).
    seen, unique = set(), []
    for a in abilities:
        key = (a["name"], a["source"])
        if key not in seen:
            seen.add(key)
            unique.append(a)
    return unique


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    abilities = extract(pdf_text(Path(sys.argv[1])))
    stats = [{k: v for k, v in a.items() if k != "text"} for a in abilities]

    (ROOT / "js").mkdir(exist_ok=True)
    (ROOT / "js" / "abilities.js").write_text(
        "// Generated by tools/extract_abilities.py: stats only, no rules text.\n"
        "export const ABILITIES = [\n"
        + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in stats)
        + "\n];\n",
        encoding="utf-8",
    )
    (ROOT / "private").mkdir(exist_ok=True)
    (ROOT / "private" / "abilities-full.json").write_text(
        json.dumps({"riftbreakersLibrary": 1, "abilities": abilities}, indent=1, ensure_ascii=False),
        encoding="utf-8",
    )
    by_source = {}
    for a in abilities:
        by_source[a["source"]] = by_source.get(a["source"], 0) + 1
    print(f"Extracted {len(abilities)} abilities:", by_source)


if __name__ == "__main__":
    main()
