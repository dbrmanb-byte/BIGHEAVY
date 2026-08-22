"""Mode A — collect: harvest from a source into a destination store."""

from .landing import LandingZone
from .parsers import ParseError, get_parser, register_parser, registered_parsers
from .pipeline import CollectPipeline

__all__ = [
    "CollectPipeline",
    "LandingZone",
    "ParseError",
    "get_parser",
    "register_parser",
    "registered_parsers",
]
