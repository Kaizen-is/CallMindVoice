"""Decide what changed since the last run. Pure logic, no I/O.

Inputs are what we knew before (url → fingerprint) and what this run saw.
The rules that keep the knowledge base safe live here:

  • a page that failed to load (timeout, 500) is NOT removed: we keep the
    version we have and try again tomorrow;
  • a page is removed only when it left the sitemap/API, or answered 404;
  • if a run would remove too many pages at once, it removes none of them
    (the safety brake): a broken sitemap must not wipe the agent's knowledge.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .models import Page


@dataclass
class Changes:
    new: list[Page] = field(default_factory=list)
    changed: list[Page] = field(default_factory=list)
    unchanged: list[Page] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    removal_blocked: bool = False
    blocked_reason: str | None = None


def plan_changes(
    known: dict[str, str],
    loaded: dict[str, Page],
    in_scope: set[str],
    gone: set[str],
    max_removed_share: float,
    allow_mass_removal: bool = False,
) -> Changes:
    """
    known      url → fingerprint of every page currently in the knowledge base
    loaded     pages this run loaded successfully
    in_scope   every URL this run found and kept (loaded, failed or not tried)
    gone       URLs that answered 404/410
    """
    out = Changes()
    for url, page in loaded.items():
        before = known.get(url)
        if before is None:
            out.new.append(page)
        elif before != page.fingerprint:
            out.changed.append(page)
        else:
            out.unchanged.append(page)

    removed = sorted(url for url in known if url not in in_scope or url in gone)
    if removed and known and not allow_mass_removal:
        share = len(removed) / len(known)
        if share > max_removed_share and len(known) >= 10:
            out.removal_blocked = True
            out.blocked_reason = (
                f"this run would remove {len(removed)} of {len(known)} pages ({share:.0%}), above the "
                f"{max_removed_share:.0%} limit; nothing was removed. If this is intended (for example "
                f"you excluded a section), run again with --allow-mass-removal."
            )
            removed = []
    out.removed = removed
    return out
