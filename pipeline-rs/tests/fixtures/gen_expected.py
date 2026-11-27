#!/usr/bin/env python3
"""Regenerate tests/fixtures/expected/ by running the reference pipeline/build.py on sample.csv.

See SPEC.md §9.2. build.py has no import-time side effects, so it is imported by path and its
module globals RAW and OUT are pointed at the fixture; build() is the same function the nightly
run calls. build.py itself is not modified.

    python3 -I pipeline-rs/tests/fixtures/gen_expected.py
"""
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep pipeline/ free of __pycache__

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

spec = importlib.util.spec_from_file_location("build", REPO / "pipeline" / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

build.RAW = HERE / "sample.csv"
build.OUT = HERE / "expected"
build.build()
