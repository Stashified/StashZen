#!/usr/bin/env python3
"""Read one harness result file, once, for both run.sh and sweep.sh.

Exit codes: 0 all checks passed, 1 a check failed, 2 the file is missing or
not a check-row list. Callers tell "red" from "the driver never reported" by
that code, so a truncated payload cannot read as a pass.
"""
import json
import sys


def load(path):
    try:
        with open(path) as f:
            rows = json.load(f)
        if not isinstance(rows, list) or not all(
            isinstance(r, dict) and 'pass' in r for r in rows
        ):
            raise ValueError('not check rows')
        return rows
    except Exception:
        return None


def main(argv):
    verbose = '--print' in argv[1:]
    paths = [a for a in argv[1:] if not a.startswith('--')]
    if len(paths) != 1:
        print('usage: tally.py [--print] <result.json>', file=sys.stderr)
        return 2
    rows = load(paths[0])
    if rows is None:
        print('NO RESULTS')
        return 2
    passed = sum(1 for r in rows if r['pass'])
    if verbose:
        for r in rows:
            print(f"  {'PASS' if r['pass'] else 'FAIL'}  {r.get('name', '?')}")
            if r.get('detail'):
                print(f"          {r['detail']}")
        print(f'\n{passed}/{len(rows)} passed')
    else:
        print(f'{passed}/{len(rows)}')
    # An empty run covered no checks, which is not green either.
    return 0 if rows and passed == len(rows) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
