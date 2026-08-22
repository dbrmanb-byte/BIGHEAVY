"""Exception hierarchy.

The distinction that matters: `RecordError` is per-record and routes to the
dead-letter queue (R1.4.5); everything else terminates the run.
"""


class SweeperError(Exception):
    """Base for every error this package raises."""


class SpecInvalid(SweeperError):
    """A sweep spec failed schema or resolution validation (R1.1.4)."""

    def __init__(self, message: str, problems: list[str] | None = None) -> None:
        self.problems = problems or []
        if self.problems:
            message = message + "\n  - " + "\n  - ".join(self.problems)
        super().__init__(message)


class SafetyViolation(SweeperError):
    """A safety gate refused the run (R1.5.x). Never catch this to continue."""


class CapabilityError(SweeperError):
    """The connector cannot do what the spec asks of it (R1.2.2)."""


class RecordError(SweeperError):
    """A single record failed. Routed to the DLQ; the run continues."""


class RunCancelled(SweeperError):
    """Cancellation was requested and the run stopped at a checkpoint (R1.5.5)."""


class RunAborted(SweeperError):
    """A blast-radius cap or DLQ threshold was breached (R1.5.3, R1.4.5)."""


class InfrastructureError(SweeperError):
    """The worker or its environment failed, not the record.

    Kept distinct from `RecordError` on purpose: dead-lettering a lost worker
    would record ten thousand perfectly good records as bad data. These
    propagate and end the run, which is then resumable from its checkpoint.
    """


class ModeNotImplemented(SweeperError):
    """The spec's mode is specified but not built yet."""
