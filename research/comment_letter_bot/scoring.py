"""Turn parsed letters plus price context into one directional read.

The arithmetic is deliberately simple and fully exposed in the report. Three
inputs, weighted the way a fundamentals-first process should weight them:

  fundamental pressure   what the letters say, decayed by age      (dominant)
  already-priced-in      what the tape did when each went public   (offset)
  trend confirmation     price versus its own 50/200-day averages  (minor)

The output is a lean and a confidence, never a certainty. Comment letters are
a slow, sparse, and public signal; treat a strong reading as a reason to do
more work on the name, not as an entry trigger.
"""

import datetime

from . import config

HALF_LIFE = config.SCORE_HALF_LIFE_DAYS

# How much of the composite each input is allowed to move.
WEIGHT_RESIDUAL = 0.80
WEIGHT_MOMENTUM = 0.20

# A 1% abnormal move is treated as 5 points of the letter score already paid.
REACTION_TO_POINTS = 5.0

BANDS = [
    (25.0, "UP", "Letters point higher than the price currently reflects"),
    (10.0, "SLIGHTLY UP", "Mild upward lean"),
    (-10.0, "NEUTRAL", "Nothing in the filing record moves the direction"),
    (-25.0, "SLIGHTLY DOWN", "Mild downward lean"),
    (-1e9, "DOWN", "Letters point lower than the price currently reflects"),
]


def _clamp(value, low, high):
    return max(low, min(high, value))


def decay_weight(age_days, half_life=HALF_LIFE):
    if age_days <= 0:
        return 1.0
    return 0.5 ** (age_days / float(half_life))


class Contribution:
    def __init__(self, analysis, weight, event):
        self.analysis = analysis
        self.weight = weight
        self.raw = analysis.score
        self.weighted = analysis.score * weight
        self.event = event

    @property
    def filing(self):
        return self.analysis.filing


class Verdict:
    def __init__(self):
        self.direction = "NO SIGNAL"
        self.headline = ""
        self.composite = 0.0
        self.fundamental = 0.0
        self.priced_in = None
        self.residual = 0.0
        self.momentum = 0.0
        self.confidence = "low"
        self.reasons = []
        self.flags = []
        self.contributions = []
        self.rounds = 0
        self.review_open = False

    def as_dict(self):
        return {
            "direction": self.direction,
            "headline": self.headline,
            "composite": round(self.composite, 1),
            "fundamental_pressure": round(self.fundamental, 1),
            "priced_in_points": (None if self.priced_in is None
                                 else round(self.priced_in, 1)),
            "residual": round(self.residual, 1),
            "momentum": round(self.momentum, 1),
            "confidence": self.confidence,
            "staff_letter_rounds": self.rounds,
            "review_open": self.review_open,
            "reasons": self.reasons,
            "flags": self.flags,
        }


def _band(composite):
    for threshold, direction, headline in BANDS:
        if composite >= threshold:
            return direction, headline
    return "NEUTRAL", ""


def evaluate(analyses, price=None, events=None, as_of=None):
    """`analyses` newest first; `events` maps accession -> event_return dict."""
    as_of = as_of or datetime.date.today()
    events = events or {}
    verdict = Verdict()

    # Acceleration requests and no-review notices are filed on the same forms
    # but carry no comments; they must not count as review rounds.
    staff = [a for a in analyses
             if a.letter.is_staff_letter and not a.is_administrative]
    verdict.rounds = len(staff)

    if not analyses:
        verdict.direction = "NO SIGNAL"
        verdict.headline = "No SEC comment-letter activity in the window"
        verdict.reasons.append(
            "EDGAR shows no UPLOAD or CORRESP filings in the period examined. "
            "Absence of a letter is the normal state for most registrants and "
            "is not itself bullish.")
        return verdict

    # -- 1. fundamental pressure ------------------------------------------
    total = 0.0
    for analysis in analyses:
        age = (as_of - analysis.filing.filing_date).days
        weight = decay_weight(age)
        contribution = Contribution(analysis, weight,
                                    events.get(analysis.filing.accession))
        verdict.contributions.append(contribution)
        total += contribution.weighted
    verdict.fundamental = _clamp(total, -100.0, 100.0)

    if staff:
        newest = staff[0]
        verdict.review_open = not newest.is_closure
        if newest.is_closure:
            verdict.flags.append(
                "Review closed by the staff on %s." % newest.filing.filing_date)
        else:
            verdict.flags.append(
                "Most recent staff letter (%s) does not close the review."
                % newest.filing.filing_date)
    if verdict.rounds >= 3:
        verdict.flags.append(
            "%d staff letters in the window - a multi-round review is friction, "
            "not routine correspondence." % verdict.rounds)
    if any(a.amendment_required for a in analyses):
        verdict.flags.append(
            "At least one letter raises amendment or restatement language.")

    # -- 2. what the market already paid ----------------------------------
    # Only the staff's own letters are the news event. A CORRESP is the
    # company answering, and its publication date drags in whatever else the
    # company reported that fortnight.
    pool = [c.event for c in verdict.contributions
            if c.event and c.analysis.letter.is_staff_letter
            and not c.analysis.is_administrative]
    if not pool:
        pool = [c.event for c in verdict.contributions
                if c.event and not c.analysis.is_administrative]

    measured = [e for e in pool if e.get("abnormal") is not None]
    basis = "abnormal"
    if not measured:
        measured = [e for e in pool if e.get("raw") is not None]
        basis = "raw"
    reaction = ((sum(e[basis if basis == "abnormal" else "raw"] for e in measured)
                 / len(measured)) if measured else None)

    if reaction is None:
        verdict.priced_in = None
        verdict.residual = verdict.fundamental
        verdict.reasons.append(
            "No usable post-publication price window, so nothing is assumed to "
            "be priced in; the read rests on the letters alone.")
    else:
        verdict.priced_in = _clamp(reaction * REACTION_TO_POINTS, -100.0, 100.0)
        verdict.residual = _clamp(verdict.fundamental - verdict.priced_in,
                                  -100.0, 100.0)
        verdict.reasons.append(
            "Average %s return over the %d trading days after each letter went "
            "public: %+.1f%%." % (basis, config.EVENT_WINDOW_DAYS, reaction))

    # -- 3. trend confirmation --------------------------------------------
    if price:
        steps = [price.get("above_sma50"), price.get("above_sma200")]
        known = [s for s in steps if s is not None]
        if known:
            verdict.momentum = (sum(1 if s else -1 for s in known)
                                / float(len(known))) * 30.0

    verdict.composite = _clamp(
        WEIGHT_RESIDUAL * verdict.residual + WEIGHT_MOMENTUM * verdict.momentum,
        -100.0, 100.0)
    verdict.direction, verdict.headline = _band(verdict.composite)

    # -- 4. the readable why ----------------------------------------------
    if verdict.fundamental <= -15 and (verdict.priced_in is None
                                       or verdict.priced_in > -15):
        verdict.reasons.append(
            "Asymmetry: the letters carry real accounting pressure and the "
            "stock did not sell off when they were published. That gap, not "
            "the letters on their own, is the bearish part of this read.")
    elif verdict.fundamental <= -15 and verdict.priced_in <= -30:
        verdict.reasons.append(
            "The market already discounted these letters at publication; the "
            "remaining edge is smaller than the raw letter score suggests.")
    elif verdict.fundamental >= 8 and (verdict.priced_in or 0) < -5:
        verdict.reasons.append(
            "The staff closed its review while the stock underperformed into "
            "the news - a resolved-overhang setup rather than a new problem.")

    top = sorted(verdict.contributions, key=lambda c: c.weighted)[:3]
    for contribution in top:
        if contribution.weighted >= -1.0:
            continue
        analysis = contribution.analysis
        labels = ", ".join(analysis.headline_topics(3)) or "unclassified"
        detail = "%d numbered comment(s)" % len(analysis.letter.items) \
            if analysis.letter.items else "no numbered comments parsed"
        if analysis.amendment_required:
            detail += ", amendment/restatement language"
        verdict.reasons.append(
            "%s %s - %s; %s [raw %.0f, aged to %.0f]"
            % (contribution.filing.form, contribution.filing.filing_date,
               labels, detail, contribution.raw, contribution.weighted))

    # -- 5. confidence -----------------------------------------------------
    readable = sum(1 for a in analyses if not a.unreadable)
    verdict.confidence = _confidence(verdict, readable, len(measured))
    return verdict


def _confidence(verdict, readable_letters, measured_events):
    if readable_letters == 0:
        return "very low"
    score = 0
    score += 1 if readable_letters >= 2 else 0
    score += 1 if abs(verdict.composite) >= 25 else 0
    score += 1 if measured_events >= 1 else 0
    score += 1 if verdict.rounds >= 2 else 0
    return {0: "low", 1: "low", 2: "moderate", 3: "moderate", 4: "high"}[score]
