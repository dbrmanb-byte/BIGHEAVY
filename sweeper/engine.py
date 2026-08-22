"""The sweep engine: safety gates, batching, resumability, audit (R1.4, R1.5).

The engine owns everything that must be true of *every* sweep. Pipelines
decide what a record means; the engine decides whether the run is allowed to
touch it, whether it already has, and what gets written down either way.
"""

from __future__ import annotations

import hashlib
import logging
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .connectors import Connector, Record, build, require
from .core import Decision, Pipeline
from .crypto import Cipher, NullCipher, seal
from .errors import (
    InfrastructureError,
    ModeNotImplemented,
    RecordError,
    RunAborted,
    RunCancelled,
    SafetyViolation,
)
from .ratelimit import backoff_delays, bucket_for
from .secrets import EnvSecrets, SecretResolver
from .spec import Spec
from .store import Counters, Store

log = logging.getLogger("sweeper")

IMPLEMENTED_MODES = ("collect", "cleanse")


@dataclass
class RunResult:
    run_id: str
    state: str
    counters: dict[str, int]
    pipeline_stats: dict[str, int]
    notes: list[str]
    dry_run: bool
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.state == "succeeded"


class RunContext:
    """The committer handed to pipelines. Every mutation goes through here."""

    def __init__(
        self,
        engine: "Engine",
        spec: Spec,
        run_id: str,
        dry_run: bool,
        counters: Counters,
        dry_run_matched: int | None,
    ) -> None:
        self.engine = engine
        self.spec = spec
        self.run_id = run_id
        self.dry_run = dry_run
        self.counters = counters
        self.notes: list[str] = []
        self._lock = threading.Lock()
        self._dry_run_matched = dry_run_matched

    def note(self, message: str) -> None:
        with self._lock:
            self.notes.append(message)
        log.info("run %s: %s", self.run_id, message)

    def _idempotency_key(self, decision: Decision) -> str:
        raw = f"{self.run_id}|{decision.record_id}|{decision.action_hash()}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def commit(self, decision: Decision, apply_fn: Callable[[], None] | None = None) -> bool:
        """Record a decision and, on a live run, apply it. True if applied."""
        store = self.engine.store
        cipher = self.engine.cipher
        system = decision.system or self.spec.source.get("system") or self.spec.source["connector"]
        key = self._idempotency_key(decision)

        if not decision.is_match:
            with self._lock:
                self.counters.bump("skipped")
            store.append_event(
                run_id=self.run_id,
                system=system,
                source_record_id=decision.record_id,
                decision=decision.decision,
                action=decision.action,
                applied=False,
                idempotency_key=key,
                reason=decision.reason,
                before=seal(cipher, decision.before),
            )
            return False

        with self._lock:
            self.counters.bump("matched")
            matched = self.counters.matched
        self._check_match_caps(matched)

        if self.dry_run or apply_fn is None:
            store.append_event(
                run_id=self.run_id,
                system=system,
                source_record_id=decision.record_id,
                decision=decision.decision,
                action=decision.action,
                applied=False,
                idempotency_key=key,
                reason=decision.reason,
                before=seal(cipher, decision.before),
                after=seal(cipher, decision.after),
            )
            return False

        # Reserve before mutating so a crash between the two is visible as a
        # dangling reservation rather than a silent double-apply (R1.4.3).
        if not store.reserve_mutation(key, self.run_id):
            with self._lock:
                self.counters.bump("skipped")
            self.note(f"duplicate mutation suppressed for {decision.record_id}")
            return False

        with self._lock:
            projected = self.counters.acted + 1
        self._check_mutation_cap(projected, key)

        try:
            apply_fn()
        except Exception:
            store.release_mutation(key)
            raise
        store.complete_mutation(key)

        with self._lock:
            self.counters.bump("acted")
        store.append_event(
            run_id=self.run_id,
            system=system,
            source_record_id=decision.record_id,
            decision=decision.decision,
            action=decision.action,
            applied=True,
            idempotency_key=key,
            reason=decision.reason,
            before=seal(cipher, decision.before),
            after=seal(cipher, decision.after),
        )
        return True

    def review(self, rule_id: str, score: float | None, candidates: Any, proposal: Any) -> int:
        with self._lock:
            self.counters.bump("reviewed")
        return self.engine.store.add_review_task(self.run_id, rule_id, score, candidates, proposal)

    def dead_letter(self, record_id: str, payload: Any, error: str, error_class: str) -> int:
        """Report a sub-record failure without failing the record.

        Deliberately does not bump `failed`: that counter drives the DLQ-rate
        guard, which is measured per record scanned. Counting rows there would
        make the rate meaningless. Pipelines apply their own row-level
        threshold instead.
        """
        return self.engine.store.add_dlq(self.run_id, record_id, payload, error, error_class)

    # ----------------------------------------------------- safety caps

    def _check_match_caps(self, matched: int) -> None:
        cap = self.spec.max_records_matched
        if cap is not None and matched > cap:
            raise RunAborted(
                f"max_records_matched exceeded: {matched} > {cap} (R1.5.3). "
                "Nothing beyond the cap was applied."
            )
        # Over-application is the dangerous direction, so the divergence guard
        # trips on the way up, during the run (R1.5.4).
        if self._dry_run_matched is not None:
            tolerance = float(self.spec.safety.get("divergence_tolerance_pct", 10)) / 100.0
            ceiling = self._dry_run_matched * (1 + tolerance)
            if matched > max(ceiling, self._dry_run_matched + 1):
                raise RunAborted(
                    f"match count diverged from the approved dry run: {matched} > "
                    f"{ceiling:.0f} (dry run matched {self._dry_run_matched}); "
                    "re-approval required (R1.5.4)"
                )

    def _check_mutation_cap(self, projected: int, reserved_key: str) -> None:
        cap = self.spec.max_mutations
        if cap is not None and projected > cap:
            self.engine.store.release_mutation(reserved_key)
            raise RunAborted(f"max_mutations exceeded: {projected} > {cap} (R1.5.3)")


class Engine:
    """Executes one sweep spec."""

    def __init__(
        self,
        store: Store,
        *,
        secrets: SecretResolver | None = None,
        cipher: Cipher | None = None,
        landing_root: str | Path | None = None,
        read_retries: int = 2,
        backoff_base: float = 0.5,
        rng_seed: int = 0,
    ) -> None:
        self.store = store
        self.secrets = secrets or EnvSecrets(allow_missing=True)
        self.cipher = cipher or NullCipher()
        self.landing_root = landing_root
        self.read_retries = read_retries
        self.backoff_base = backoff_base
        self._rng = random.Random(rng_seed)

    # -------------------------------------------------------- building

    def build_source(self, spec: Spec) -> Connector:
        source = spec.source
        auth = self.secrets.resolve(source["auth_ref"]) if source.get("auth_ref") else None
        config = dict(source.get("config") or {})
        if spec.mode == "collect":
            politeness = (spec.action.get("politeness") or {})
            if politeness:
                config["politeness"] = politeness
        connector = build(source["connector"], config, auth)
        caps = connector.capabilities()
        if spec.is_incremental:
            require(caps, incremental=True)
        if spec.scope.get("pushdown_required"):
            require(caps, filter_pushdown=True)
        if spec.mode == "cleanse":
            require(caps, writable=True, field_update=True, hard_delete=True)
        return connector

    def build_pipeline(self, spec: Spec, source: Connector) -> Pipeline:
        if spec.mode == "collect":
            from .collect.pipeline import CollectPipeline

            return CollectPipeline(spec, source, self.store, landing_root=self.landing_root)
        if spec.mode == "cleanse":
            from .cleanse.pipeline import CleansePipeline

            key = str((spec.source.get("config") or {}).get("key", "id"))
            return CleansePipeline(spec, source, key=key)
        raise ModeNotImplemented(
            f"mode {spec.mode!r} is specified but not implemented; "
            f"implemented modes: {', '.join(IMPLEMENTED_MODES)}"
        )

    # -------------------------------------------------------- preflight

    def preflight(
        self, spec: Spec, *, dry_run: bool, initiated_by: str, based_on_run_id: str | None
    ) -> int | None:
        """Run every safety gate before a single record is touched (R1.5).

        Returns the approved dry run's match count, when there is one.
        """
        if dry_run:
            return None

        safety = spec.safety
        dry_matched: int | None = None

        if safety.get("dry_run_required", True):
            if not based_on_run_id:
                raise SafetyViolation(
                    f"{spec.describe()}: a live run requires an approved dry run (R1.5.1)"
                )
            prior = self.store.get_run(based_on_run_id)
            if not prior["dry_run"]:
                raise SafetyViolation(f"run {based_on_run_id} is not a dry run")
            if prior["state"] != "succeeded":
                raise SafetyViolation(
                    f"dry run {based_on_run_id} ended in state {prior['state']!r}, not 'succeeded'"
                )
            if prior["spec_hash"] != spec.hash:
                raise SafetyViolation(
                    "the spec changed since that dry run; re-run and re-approve (R1.5.1)"
                )
            max_age = int(safety.get("dry_run_max_age_hours", 72))
            started = prior.get("finished_at") or prior.get("started_at")
            if started:
                age = datetime.now(timezone.utc) - datetime.fromisoformat(started)
                if age > timedelta(hours=max_age):
                    raise SafetyViolation(
                        f"dry run {based_on_run_id} is {age.total_seconds() / 3600:.1f}h old, "
                        f"past the {max_age}h freshness window (R1.5.1)"
                    )
            dry_matched = int(prior["counters"].get("matched", 0))

        needed = int(safety.get("approvals_required", 0))
        if needed and based_on_run_id:
            approvals = self.store.approvals(based_on_run_id, spec.hash)
            rejections = [a for a in approvals if a["decision"] == "reject"]
            if rejections:
                raise SafetyViolation(
                    f"dry run {based_on_run_id} was rejected by "
                    f"{', '.join(sorted(a['approver'] for a in rejections))}"
                )
            approvers = {a["approver"] for a in approvals if a["decision"] == "approve"}
            # The initiator cannot self-approve (R1.5.7).
            approvers.discard(initiated_by)
            if len(approvers) < needed:
                raise SafetyViolation(
                    f"{spec.describe()} needs {needed} approval(s) from someone other than "
                    f"{initiated_by}; have {len(approvers)} (R1.5.7)"
                )
        elif needed:
            raise SafetyViolation(f"{spec.describe()} needs {needed} approval(s) (R1.5.7)")

        return dry_matched

    # -------------------------------------------------------------- run

    def run(
        self,
        spec: Spec,
        *,
        dry_run: bool = True,
        initiated_by: str = "cli",
        trigger: str = "manual",
        based_on_run_id: str | None = None,
        resume_run_id: str | None = None,
    ) -> RunResult:
        if spec.mode not in IMPLEMENTED_MODES:
            raise ModeNotImplemented(
                f"mode {spec.mode!r} is specified but not implemented; "
                f"implemented modes: {', '.join(IMPLEMENTED_MODES)}"
            )

        version = self.store.put_spec(spec.body, initiated_by)
        spec = Spec(spec.body, version=version)
        dry_matched = self.preflight(
            spec, dry_run=dry_run, initiated_by=initiated_by, based_on_run_id=based_on_run_id
        )

        source = self.build_source(spec)
        pipeline = self.build_pipeline(spec, source)

        if resume_run_id:
            run_id = resume_run_id
            counters = Counters(**{
                k: v for k, v in self.store.get_run(run_id)["counters"].items()
                if k in ("scanned", "matched", "acted", "skipped", "failed", "reviewed")
            })
        else:
            run_id = self.store.create_run(
                spec_id=spec.id,
                spec_version=version,
                spec_hash=spec.hash,
                mode=spec.mode,
                dry_run=dry_run,
                initiated_by=initiated_by,
                trigger=trigger,
                based_on_run_id=based_on_run_id,
                cipher=getattr(self.cipher, "name", "custom"),
            )
            counters = Counters()

        ctx = RunContext(self, spec, run_id, dry_run, counters, dry_matched)
        pipeline.attach(ctx)
        self.store.start_run(run_id)
        log.info("run %s started: %s dry_run=%s", run_id, spec.describe(), dry_run)

        state, error = "succeeded", None
        try:
            self._sweep(spec, source, pipeline, ctx)
            pipeline.finalise(ctx)
            if dry_matched is not None:
                self._report_undercount(ctx, dry_matched)
        except RunCancelled as exc:
            state, error = "cancelled", str(exc)
        except RunAborted as exc:
            state, error = "aborted", str(exc)
        except Exception as exc:  # noqa: BLE001 - the run's terminal state must be recorded
            state, error = "failed", f"{type(exc).__name__}: {exc}"
            log.exception("run %s failed", run_id)
        finally:
            source.close()
            self.store.finish_run(run_id, state, counters, error)

        return RunResult(
            run_id=run_id,
            state=state,
            counters=counters.as_dict(),
            pipeline_stats=dict(pipeline.stats.detail),
            notes=list(ctx.notes),
            dry_run=dry_run,
            error=error,
        )

    def _report_undercount(self, ctx: RunContext, dry_matched: int) -> None:
        tolerance = float(ctx.spec.safety.get("divergence_tolerance_pct", 10)) / 100.0
        floor = dry_matched * (1 - tolerance)
        if ctx.counters.matched < floor:
            ctx.note(
                f"matched {ctx.counters.matched} against {dry_matched} in the approved dry run, "
                f"below the {tolerance:.0%} tolerance — the source changed underneath the "
                "approval; review before relying on this run"
            )

    # ------------------------------------------------------ the sweep

    def _sweep(self, spec: Spec, source: Connector, pipeline: Pipeline, ctx: RunContext) -> None:
        bucket = bucket_for(spec.rate_per_second)
        partitions = source.partitions(spec.scope)
        log.info("run %s: %d partition(s)", ctx.run_id, len(partitions))

        for partition in partitions:
            checkpoint = self.store.get_checkpoint(ctx.run_id, partition)
            cursor, done = checkpoint if checkpoint else (None, 0)
            watermark = (
                self.store.get_watermark(spec.id, partition) if spec.is_incremental else None
            )
            high_watermark = watermark

            while True:
                if self.store.cancel_requested(ctx.run_id):
                    raise RunCancelled(f"cancelled at partition {partition!r}, cursor {cursor!r}")

                batch = source.enumerate(
                    partition, cursor, spec.batch_size, spec.scope, watermark
                )
                if batch.records:
                    self._process_batch(batch.records, source, pipeline, ctx, bucket, spec)
                    done += len(batch.records)
                    high_watermark = self._advance_watermark(spec, batch.records, high_watermark)

                cursor = batch.next_cursor
                # Checkpoint only after the whole batch is durably accounted
                # for, so a crash re-processes rather than skips (R1.4.2).
                self.store.save_checkpoint(ctx.run_id, partition, cursor, done)
                self.store.save_counters(ctx.run_id, ctx.counters)
                self._check_dlq_rate(spec, ctx)

                if batch.exhausted:
                    break

            if spec.is_incremental and high_watermark is not None and not ctx.dry_run:
                self.store.set_watermark(spec.id, partition, high_watermark, ctx.run_id)

    @staticmethod
    def _advance_watermark(spec: Spec, records: list[Record], current: Any) -> Any:
        field = spec.scope.get("watermark_field")
        if not field:
            return current
        for record in records:
            value = (record.payload or {}).get(field) or record.meta.get(field)
            if value is None:
                continue
            if current is None or str(value) > str(current):
                current = value
        return current

    def _process_batch(
        self,
        records: list[Record],
        source: Connector,
        pipeline: Pipeline,
        ctx: RunContext,
        bucket: Any,
        spec: Spec,
    ) -> None:
        def handle(record: Record) -> None:
            with ctx._lock:
                ctx.counters.bump("scanned")
            try:
                hydrated = self._read_with_retry(source, record, bucket)
                decision = pipeline.plan(hydrated)
                ctx.commit(
                    decision,
                    apply_fn=(lambda d=decision: pipeline.apply(d)) if decision.is_match else None,
                )
            except (RunAborted, RunCancelled, InfrastructureError):
                # The record is fine; the run is not. Ending here keeps the
                # checkpoint honest so a fresh worker can resume.
                raise
            except RecordError as exc:
                self._dead_letter(ctx, record, exc)
            except Exception as exc:  # noqa: BLE001 - one bad record must not kill the run
                self._dead_letter(ctx, record, exc)

        if spec.concurrency <= 1 or len(records) == 1:
            for record in records:
                handle(record)
            return

        with ThreadPoolExecutor(max_workers=spec.concurrency) as pool:
            for future in [pool.submit(handle, r) for r in records]:
                future.result()  # re-raise RunAborted/RunCancelled on the caller

    def _read_with_retry(self, source: Connector, record: Record, bucket: Any) -> Record:
        delays = backoff_delays(self.read_retries, base=self.backoff_base)
        last: Exception | None = None
        for attempt in range(self.read_retries + 1):
            bucket.acquire()
            try:
                return source.read(record)
            except RecordError as exc:
                last = exc
                if attempt < self.read_retries:
                    time.sleep(delays[attempt] * (0.5 + self._rng.random()))
        raise last if last else RecordError(f"read failed for {record.id}")

    def _dead_letter(self, ctx: RunContext, record: Record, exc: Exception) -> None:
        with ctx._lock:
            ctx.counters.bump("failed")
        self.store.add_dlq(
            ctx.run_id,
            record.id,
            {"meta": record.meta, "payload": record.payload},
            str(exc),
            type(exc).__name__,
        )
        log.warning("run %s: record %s -> DLQ: %s", ctx.run_id, record.id, exc)

    def _check_dlq_rate(self, spec: Spec, ctx: RunContext) -> None:
        """A run dies on a DLQ *rate*, not on one bad record (R1.4.5)."""
        counters = ctx.counters
        if counters.scanned < 20:
            return
        rate = counters.dlq_rate_pct()
        if rate > spec.max_dlq_rate_pct:
            raise RunAborted(
                f"dead-letter rate {rate:.1f}% exceeds the configured "
                f"{spec.max_dlq_rate_pct:.1f}% ({counters.failed}/{counters.scanned} records)"
            )
