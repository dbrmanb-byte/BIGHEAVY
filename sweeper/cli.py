"""Command line control surface (R1.7.1).

The commands mirror the lifecycle the requirements describe: validate, dry-run,
approve, apply, then inspect what happened.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

from .cleanse.rules import registered_rules
from .collect.parsers import registered_parsers
from .connectors import available as available_connectors
from .connectors import build
from .crypto import NullCipher, unseal
from .engine import IMPLEMENTED_MODES, Engine, RunResult
from .errors import SweeperError
from .rollback import rollback_run
from .spec import Spec
from .store import Store


def _store(args: argparse.Namespace) -> Store:
    return Store(args.db)


def _engine(args: argparse.Namespace, store: Store) -> Engine:
    return Engine(store, landing_root=getattr(args, "landing", None))


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str, sort_keys=True))


def _result(result: RunResult) -> int:
    _print(
        {
            "run_id": result.run_id,
            "state": result.state,
            "dry_run": result.dry_run,
            "counters": result.counters,
            "pipeline": result.pipeline_stats,
            "notes": result.notes,
            "error": result.error,
        }
    )
    return 0 if result.ok else 1


# ------------------------------------------------------------- commands

def cmd_validate(args: argparse.Namespace) -> int:
    spec = Spec.from_file(args.spec)
    problems: list[str] = []
    if spec.mode not in IMPLEMENTED_MODES:
        problems.append(
            f"mode {spec.mode!r} is valid but not implemented "
            f"(implemented: {', '.join(IMPLEMENTED_MODES)})"
        )
    else:
        try:
            store = Store(":memory:")
            engine = Engine(store)
            source = engine.build_source(spec)
            engine.build_pipeline(spec, source)
            source.close()
        except SweeperError as exc:
            problems.append(str(exc))
    _print({"spec": spec.id, "mode": spec.mode, "hash": spec.hash, "problems": problems})
    return 1 if problems else 0


def cmd_registry(args: argparse.Namespace) -> int:
    _print(
        {
            "connectors": available_connectors(),
            "parsers": registered_parsers(),
            "rules": registered_rules(),
            "modes_implemented": list(IMPLEMENTED_MODES),
        }
    )
    return 0


def cmd_dry_run(args: argparse.Namespace) -> int:
    store = _store(args)
    spec = Spec.from_file(args.spec)
    return _result(_engine(args, store).run(spec, dry_run=True, initiated_by=args.actor))


def cmd_apply(args: argparse.Namespace) -> int:
    store = _store(args)
    spec = Spec.from_file(args.spec)
    return _result(
        _engine(args, store).run(
            spec, dry_run=False, initiated_by=args.actor, based_on_run_id=args.based_on
        )
    )


def cmd_approve(args: argparse.Namespace) -> int:
    store = _store(args)
    run = store.get_run(args.run_id)
    store.add_approval(
        args.run_id,
        run["spec_hash"],
        args.approver,
        "reject" if args.reject else "approve",
        args.comment,
    )
    _print(store.approvals(args.run_id, run["spec_hash"]))
    return 0


def cmd_runs(args: argparse.Namespace) -> int:
    _print(
        [
            {k: r[k] for k in ("run_id", "spec_id", "mode", "dry_run", "state", "counters", "error")}
            for r in _store(args).list_runs(args.spec_id, args.limit)
        ]
    )
    return 0


def cmd_events(args: argparse.Namespace) -> int:
    store = _store(args)
    store.get_run(args.run_id)  # an unknown id must not read as "no events"
    cipher = NullCipher()
    rows = []
    for event in store.events(args.run_id, args.decision):
        rows.append(
            {
                "event_id": event["event_id"],
                "record": event["source_record_id"],
                "decision": event["decision"],
                "action": event["action"],
                "applied": bool(event["applied"]),
                "reason": event["reason"],
                "before": unseal(cipher, event["before"]),
                "after": unseal(cipher, event["after"]),
            }
        )
    _print(rows[: args.limit])
    return 0


def cmd_dlq(args: argparse.Namespace) -> int:
    store = _store(args)
    store.get_run(args.run_id)
    _print(store.dlq(args.run_id))
    return 0


def cmd_review(args: argparse.Namespace) -> int:
    store = _store(args)
    if args.run_id:
        store.get_run(args.run_id)
    _print(store.review_tasks(args.run_id, args.state))
    return 0


def cmd_review_resolve(args: argparse.Namespace) -> int:
    store = _store(args)
    store.resolve_review_task(args.task_id, args.state, args.reviewer)
    _print({"task_id": args.task_id, "state": args.state, "reviewer": args.reviewer})
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    store = _store(args)
    store.request_cancel(args.run_id, args.actor)
    _print({"run_id": args.run_id, "cancel_requested_by": args.actor})
    return 0


def cmd_rollback(args: argparse.Namespace) -> int:
    store = _store(args)
    run = store.get_run(args.run_id)
    body, _version = store.get_spec(run["spec_id"], run["spec_version"])
    spec = Spec(body)
    connector = build(spec.source["connector"], spec.source.get("config") or {})
    window = spec.safety.get("rollback_window_hours")
    result = rollback_run(
        store, connector, args.run_id, actor=args.actor, window_hours=window, force=args.force
    )
    _print(result.__dict__)
    return 0 if not result.problems else 1


# ------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sweeper", description="Run and inspect data sweeps.")
    parser.add_argument("--db", default="sweeper.db", help="state database (default: sweeper.db)")
    parser.add_argument("--verbose", "-v", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="schema- and resolution-check a spec")
    p.add_argument("spec", type=Path)
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("registry", help="list connectors, parsers and rules")
    p.set_defaults(func=cmd_registry)

    p = sub.add_parser("dry-run", help="preview a sweep without applying anything")
    p.add_argument("spec", type=Path)
    p.add_argument("--actor", default="cli")
    p.add_argument("--landing", help="landing zone root (mode A)")
    p.set_defaults(func=cmd_dry_run)

    p = sub.add_parser("apply", help="execute a sweep for real")
    p.add_argument("spec", type=Path)
    p.add_argument("--based-on", required=False, help="the approved dry run's id")
    p.add_argument("--actor", default="cli")
    p.add_argument("--landing", help="landing zone root (mode A)")
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("approve", help="approve or reject a dry run")
    p.add_argument("run_id")
    p.add_argument("--approver", required=True)
    p.add_argument("--reject", action="store_true")
    p.add_argument("--comment")
    p.set_defaults(func=cmd_approve)

    p = sub.add_parser("runs", help="list runs")
    p.add_argument("--spec-id")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_runs)

    p = sub.add_parser("events", help="inspect the audit trail for a run")
    p.add_argument("run_id")
    p.add_argument("--decision", choices=["match", "no_match", "excluded"])
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=cmd_events)

    p = sub.add_parser("dlq", help="list dead-lettered records")
    p.add_argument("run_id")
    p.set_defaults(func=cmd_dlq)

    p = sub.add_parser("review", help="list review-queue tasks")
    p.add_argument("--run-id")
    p.add_argument("--state", default="open")
    p.set_defaults(func=cmd_review)

    p = sub.add_parser("review-resolve", help="accept or reject a review task")
    p.add_argument("task_id", type=int)
    p.add_argument("--state", choices=["accepted", "rejected", "deferred"], required=True)
    p.add_argument("--reviewer", required=True)
    p.set_defaults(func=cmd_review_resolve)

    p = sub.add_parser("cancel", help="request cancellation of a running sweep")
    p.add_argument("run_id")
    p.add_argument("--actor", default="cli")
    p.set_defaults(func=cmd_cancel)

    p = sub.add_parser("rollback", help="reverse a cleanse run from its audit trail")
    p.add_argument("run_id")
    p.add_argument("--actor", default="cli")
    p.add_argument("--force", action="store_true", help="ignore the rollback window")
    p.set_defaults(func=cmd_rollback)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )
    try:
        return int(args.func(args))
    except SweeperError as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    except KeyError as exc:
        print(f"not found: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
