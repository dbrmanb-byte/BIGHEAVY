"""Seed the demo CRM table with messy contacts."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROWS = [
    # (id, first, last, email, phone, address, postal, status, source, updated_at)
    ("c1", "Dana", " Reyes ", "Dana@Example.ORG", "(512) 555-0134", "1200 west 6th street", "78703-1234", "active", "crm", "2026-01-04"),
    ("c2", "Dana", "Reyes", "dana@example.org", "512-555-0134", "1200 W 6th St", "78703", "active", "import", "2026-05-19"),
    ("c3", "Kim", "Lee", "kim.lee@example.net", "", "88 Pine Ave", "98101", "active", "crm", "2026-03-02"),
    ("c4", "Kimberly", "Lee", "kimberly.lee@example.net", "206-555-0199", "88 Pine Avenue", "98101", "active", "import", "2026-04-11"),
    ("c5", "Ari", "Novak", "ari@@broken", "+1 (415) 555-0110", "9 Market St", "94103", "active", "crm", "2026-02-20"),
    ("c6", "Jo", "Park", "jo.park@example.com", "4155550171", "9 Market Street", "94103", "active", "crm", "2026-02-21"),
    ("c7", "Archived", "Person", "old@example.org", "", "", "", "archived", "crm", "2024-01-01"),
]


def seed(path: str = "build/demo-crm.db") -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("DROP TABLE IF EXISTS contacts")
    conn.execute(
        "CREATE TABLE contacts (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT,"
        " email TEXT, phone TEXT, address_line1 TEXT, postal_code TEXT, status TEXT,"
        " source TEXT, updated_at TEXT)"
    )
    conn.executemany("INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?,?,?)", ROWS)
    conn.commit()
    conn.close()
    return path


if __name__ == "__main__":
    print(seed(*sys.argv[1:]))
