"""Whole-run rollback for mode C (C6, R1.5.6).

Reversal is driven entirely by the recorded before-state in `record_event`.
That is the point of storing it: if the audit trail cannot reconstruct the
prior value, the sweep was never reversible, whatever the config claimed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .connectors import Connector, Mutation
from .crypto import Cipher, NullCipher, seal, unseal
from .errors import SafetyViolation
from .store import Store

REVERSIBLE_ACTIONS = {"update", "merge", "delete"}


@dataclass
class RollbackResult:
    run_id: str
    rollback_run_id: str
    restored: int
    reinserted: int
    skipped: int
    problems: list[str]


def rollback_run(
    store: Store,
    connector: Connector,
    run_id: str,
    *,
    actor: str,
    cipher: Cipher | None = None,
    window_hours: int | None = None,
    force: bool = False,
) -> RollbackResult:
    cipher = cipher or NullCipher()
    run = store.get_run(run_id)

    if run["dry_run"]:
        raise SafetyViolation(f"run {run_id} was a dry run; there is nothing to roll back")
    if run["mode"] != "cleanse":
        raise SafetyViolation(
            f"rollback supports mode 'cleanse'; run {run_id} is mode {run['mode']!r}. "
            "Erasure is not reversible by design (R1.5.6)."
        )

    finished = run.get("finished_at")
    if window_hours and finished and not force:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(finished)
        if age > timedelta(hours=window_hours):
            raise SafetyViolation(
                f"run {run_id} finished {age.total_seconds() / 3600:.1f}h ago, past the "
                f"{window_hours}h rollback window"
            )

    body, version = store.get_spec(run["spec_id"], run["spec_version"])
    rollback_run_id = store.create_run(
        spec_id=run["spec_id"],
        spec_version=version,
        spec_hash=run["spec_hash"],
        mode=run["mode"],
        dry_run=False,
        initiated_by=actor,
        trigger="rollback",
        based_on_run_id=run_id,
        cipher=getattr(cipher, "name", "custom"),
    )
    store.start_run(rollback_run_id)

    restored = reinserted = skipped = 0
    problems: list[str] = []
    # Reverse order, so a record touched twice ends on its earliest state.
    events = [e for e in store.events(run_id) if e["applied"]]
    for event in reversed(events):
        action = event["action"]
        before: Any = unseal(cipher, event["before"])
        if action not in REVERSIBLE_ACTIONS or before is None:
            skipped += 1
            continue
        record_id = event["source_record_id"]
        try:
            if action == "delete":
                values = {k: v for k, v in before.items() if not k.startswith("_")}
                connector.apply(Mutation("upsert", record_id, values))
                reinserted += 1
                restored_action = "insert"
            else:
                values = {k: v for k, v in before.items() if not k.startswith("_")}
                connector.apply(Mutation("update", record_id, values))
                restored += 1
                restored_action = "update"
        except Exception as exc:  # noqa: BLE001 - one bad restore must not stop the rest
            problems.append(f"{record_id}: {exc}")
            skipped += 1
            continue

        store.append_event(
            run_id=rollback_run_id,
            system=event["system"],
            source_record_id=record_id,
            decision="match",
            action=restored_action,
            applied=True,
            idempotency_key=f"rollback:{rollback_run_id}:{event['event_id']}",
            reason=f"rollback of run {run_id} event {event['event_id']} ({action})",
            before=seal(cipher, unseal(cipher, event["after"])),
            after=seal(cipher, before),
        )

    from .store import Counters

    counters = Counters(
        scanned=len(events), matched=restored + reinserted, acted=restored + reinserted,
        skipped=skipped, failed=len(problems),
    )
    store.finish_run(
        rollback_run_id,
        "succeeded" if not problems else "failed",
        counters,
        "; ".join(problems[:5]) or None,
    )
    return RollbackResult(
        run_id=run_id,
        rollback_run_id=rollback_run_id,
        restored=restored,
        reinserted=reinserted,
        skipped=skipped,
        problems=problems,
    )
