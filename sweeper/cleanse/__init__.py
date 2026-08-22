"""Mode C — cleanse: normalise, validate and dedupe records in place."""

from .matching import Matcher, jaro_winkler, soundex, token_set_ratio
from .pipeline import CleansePipeline
from .rules import RuleSpec, apply_rules, get_rule, registered_rules
from .survivorship import merge_records

__all__ = [
    "CleansePipeline",
    "Matcher",
    "RuleSpec",
    "apply_rules",
    "get_rule",
    "jaro_winkler",
    "merge_records",
    "registered_rules",
    "soundex",
    "token_set_ratio",
]
