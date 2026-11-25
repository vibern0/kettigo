"""Match Slither's reported operations to the contract review in SLITHER.md."""

import hashlib
import json
import sys
from collections import defaultdict
from functools import cache
from pathlib import Path


@cache
def source(path):
    return Path(path).read_bytes()


def source_digest(mapping):
    start = mapping["start"]
    if start < 0:
        raise ValueError(f"Missing source location in {mapping['filename_short']}")
    span = source(mapping["filename_absolute"])[start : start + mapping["length"]]
    if not span or len(span) != mapping["length"]:
        raise ValueError(f"Invalid Slither source range in {mapping['filename_short']}")
    return hashlib.sha256(span).hexdigest()


def review_keys(detectors):
    # Slither can group the same reentrancy paths differently across runs. Keep
    # every distinct call, write and event, including the role Slither gave it.
    evidence = defaultdict(set)
    for finding in detectors:
        if finding["impact"] in ("Informational", "Optimization"):
            continue
        first = finding["elements"][0]
        context = first["type_specific_fields"].get("signature", first["name"])
        scope = f"{first['source_mapping']['filename_short']}:{context}/{finding['check']}"
        for element in finding["elements"]:
            location = element["source_mapping"]
            parent = element.get("type_specific_fields", {}).get("parent", {})
            # Bind approvals to the enclosing implementation too. A changed
            # guard or reordered operation needs review even at the same site.
            enclosing = parent["source_mapping"] if parent.get("type") == "function" else location
            record = [
                finding["impact"], location["filename_short"], element["type"], element["name"],
                element.get("additional_fields"), source_digest(location), source_digest(enclosing),
                location["start"] - enclosing["start"],
            ]
            evidence[scope].add(json.dumps(record, sort_keys=True))
    return {
        scope: hashlib.sha256("\n".join(sorted(records)).encode()).hexdigest()
        for scope, records in evidence.items()
    }


def main():
    report = json.loads(Path(sys.argv[1]).read_text())
    if report["success"] is not True or report.get("error"):
        sys.exit("Slither did not complete successfully.")
    reviews = json.loads(Path(__file__).with_name("slither-reviewed.json").read_text())
    findings = report["results"].get("detectors", [])
    current = review_keys(findings)
    if int(sys.argv[2]) == 255 and not current:
        sys.exit("Slither failed without reporting a blocking finding.")
    pending = {key: digest for key, digest in current.items() if reviews.get(key) != digest}
    obsolete = sorted(reviews.keys() - current.keys())
    if obsolete:
        print("Remove obsolete Slither reviews:", *obsolete, sep="\n")
    if pending:
        print("Unreviewed Slither findings. Inspect slither.md and slither.json before approving.")
        print(json.dumps(pending, sort_keys=True, indent=2))
    if pending or obsolete:
        return 1
    print(f"Slither reported {len(findings)} findings. All blocking sites match their review.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
