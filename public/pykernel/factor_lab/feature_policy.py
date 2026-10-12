"""Availability and research admission are separate decisions.

The small real-data pilot did not establish incremental value for the two TA
candidates. They remain executable, but require an explicit pool or seed to
enter search. No historical token meaning or score threshold is changed.
"""
RESEARCH_CANDIDATE_IDS = frozenset({62, 63})


def search_feature_pool(active, requested=None, seeds=None):
    if requested is not None:
        if not requested or any(type(i) is not int or i < 0 for i in requested):
            raise ValueError("Invalid explicit feature search pool")
        result = [i for i in active if i in requested]
    else:
        explicit = {int(t) for tokens in (seeds or []) for t in tokens if int(t) in RESEARCH_CANDIDATE_IDS}
        result = [i for i in active if i not in RESEARCH_CANDIDATE_IDS or i in explicit]
    if not result:
        raise ValueError("No available features in the requested search pool")
    return result
