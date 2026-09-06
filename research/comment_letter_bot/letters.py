"""Read a comment letter the way an analyst would: what was asked, about
what, how hard, and whether it was settled.

Everything in here is deterministic. An optional model pass (llm.py) can add
narrative on top, but the score, the topics, and the extracted asks never
depend on a network call to anything but EDGAR.
"""

import re

from . import taxonomy

_RE_LINE = re.compile(r"^\s*Re:\s*(.+?)(?:\n\s*\n|\Z)", re.I | re.M | re.S)
_ITEM_RE = re.compile(r"^\s{0,8}(\d{1,2})\.\s+(?=[A-Z(\"'])", re.M)
_SECTION_RE = re.compile(r"^(.{4,120}?,\s*page\s*[\dIVXivx\-]+)\s*$", re.M)
_RESPONSE_RE = re.compile(
    r"^\s*(?:Company\s+|Apple\s+)?Response\s*(?:to\s+Comment)?\s*"
    r"(?:No\.?\s*\d+)?\s*[:.\-]", re.I | re.M)
_SALUTATION_RE = re.compile(
    r"(Ladies and Gentlemen|Dear (Mr|Ms|Mrs|Dr)?\.?\s*[A-Z][\w.\- ]{2,40}:)", re.I)
_PAGE_NOISE_RE = re.compile(r"^\s*(page\s*)?[\divxlIVXL]{1,4}\s*$", re.I)
_ASK_RE = re.compile(
    r"(please\s+\w+|tell us\b|explain to us\b|describe\b|clarify\b|"
    r"provide us\b|revise\b|quantify\b|confirm\b|advise us\b)", re.I)
_SENTENCE_RE = re.compile(r"(?<=[.;:])\s+(?=[A-Z(])")
_WS_RE = re.compile(r"\s+")


def _clean(text):
    return _WS_RE.sub(" ", text or "").strip()


def strip_repeated_furniture(text):
    """Remove the running headers, footers, and page numbers EDGAR's text
    extractor leaves interleaved with the prose.

    A short line that appears more than once in a five-page letter is nearly
    always the addressee block or a page number repeating at a page break -
    and left in place it truncates the sentence it lands in the middle of.
    """
    lines = text.splitlines()
    counts = {}
    for line in lines:
        stripped = line.strip()
        if stripped and len(stripped) < 60 and len(stripped.split()) <= 8:
            counts[stripped] = counts.get(stripped, 0) + 1

    kept = []
    for line in lines:
        stripped = line.strip()
        if _PAGE_NOISE_RE.match(stripped):
            continue
        if counts.get(stripped, 0) >= 2:
            continue
        kept.append(line)
    return "\n".join(kept)


def _sentences(text):
    return [s.strip() for s in _SENTENCE_RE.split(_clean(text)) if s.strip()]


class CommentItem:
    """One numbered comment.

    In a CORRESP the company restates the staff's comment and then answers it,
    so a single numbered block holds both halves. `comment` is the staff's
    words, `response` the company's - keeping them apart stops a response
    from being scored as if it were a fresh demand.
    """

    def __init__(self, number, section, raw, staff_letter):
        self.number = number
        self.section = section
        self.raw = raw
        self.text = _clean(raw)
        self.comment, self.response = self._split(raw, staff_letter)

    @staticmethod
    def _split(raw, staff_letter):
        """Separate the staff's comment from the company's answer.

        A staff letter is all comment. A response letter either labels the
        halves ("Response:") or - the common house style - quotes the comment
        as its own paragraph and answers in the paragraphs beneath it.
        """
        if staff_letter:
            return _clean(raw), ""
        match = _RESPONSE_RE.search(raw)
        if match:
            return _clean(raw[:match.start()]), _clean(raw[match.end():])
        parts = re.split(r"\n\s*\n", raw.strip(), maxsplit=1)
        if len(parts) == 2 and len(_clean(parts[1])) > 60:
            return _clean(parts[0]), _clean(parts[1])
        return _clean(raw), ""

    @property
    def ask(self):
        """The sentence in which the staff actually asks for something."""
        sentences = _sentences(self.comment)
        for sentence in sentences:
            if _ASK_RE.search(sentence):
                return sentence
        return sentences[-1] if sentences else ""

    @property
    def reply(self):
        """The opening of the company's answer, cut on a sentence boundary."""
        budget = 300
        out = []
        for sentence in _sentences(self.response):
            if out and sum(len(s) for s in out) + len(sentence) > budget:
                break
            out.append(sentence)
            if len(out) >= 3:
                break
        return " ".join(out)

    @property
    def context(self):
        sentences = _sentences(self.comment)
        return sentences[0] if sentences else ""

    def topics(self):
        found = []
        for topic in taxonomy.TOPICS:
            hits = topic.hits(self.text)
            if hits:
                found.append(topic)
        return found


class Letter:
    """One UPLOAD or CORRESP filing, parsed."""

    def __init__(self, filing, text):
        self.filing = filing
        self.raw_text = text or ""
        self.text = strip_repeated_furniture(self.raw_text)
        self.subject = self._subject()
        self.items = self._items()

    # -- structure ---------------------------------------------------------

    def _subject(self):
        match = _RE_LINE.search(self.text)
        if not match:
            return ""
        subject = _clean(match.group(1))
        # The salutation often follows the Re: block with no blank line.
        cut = re.search(r"\bDear\b", subject)
        if cut:
            subject = subject[:cut.start()].strip()
        return subject[:300]

    def _items(self):
        sections = [(m.start(), _clean(m.group(1)))
                    for m in _SECTION_RE.finditer(self.text)]

        def section_for(position):
            current = ""
            for start, heading in sections:
                if start < position:
                    current = heading
                else:
                    break
            return current

        marks = list(_ITEM_RE.finditer(self.text))
        items = []
        for index, mark in enumerate(marks):
            end = marks[index + 1].start() if index + 1 < len(marks) else len(self.text)
            body = self.text[mark.end():end]
            if len(_clean(body)) < 40:
                continue
            items.append(CommentItem(int(mark.group(1)), section_for(mark.start()),
                                     body, self.filing.is_staff_letter))
        return items

    @property
    def is_staff_letter(self):
        return self.filing.is_staff_letter

    def body_excerpt(self, limit=500):
        """The letter's own prose, skipping the law-firm letterhead.

        Outside counsel files responses on letterhead listing every office the
        firm has; starting at the salutation is what keeps that out of a
        summary that is supposed to be about accounting.
        """
        body = self.text
        match = _SALUTATION_RE.search(body)
        if match:
            body = body[match.end():]
        elif self.subject:
            index = body.find(self.subject[:60])
            if index >= 0:
                body = body[index + len(self.subject[:60]):]
        body = _clean(body).lstrip(":,;- ")
        return body[:limit] + ("..." if len(body) > limit else "")

    @property
    def body_for_scoring(self):
        """The text whose language should count against the company.

        For a staff letter that is the numbered comments. For a company
        response it is the company's own answers - a CORRESP quotes the staff
        verbatim, and scoring the quotation would count the same comment
        twice.
        """
        if self.is_staff_letter:
            if self.items:
                return "\n".join(item.comment for item in self.items)
            return self.text
        replies = "\n".join(item.response for item in self.items if item.response)
        return replies or self.text


class Analysis:
    """The scored reading of one letter."""

    def __init__(self, letter):
        self.letter = letter
        self.filing = letter.filing
        # Every phrase this class looks for is multi-word, and EDGAR's text
        # extractor wraps lines mid-sentence. Matching against a whitespace-
        # normalised copy is what stops "we have completed our\nreview" from
        # reading as a letter with no closure in it.
        body = _clean(letter.body_for_scoring)
        whole = _clean(letter.text)

        self.is_closure = any(p.search(whole) for p in taxonomy.CLOSURE_PATTERNS)
        self.is_administrative = (not self.is_closure
                                  and bool(taxonomy.ADMINISTRATIVE.search(whole))
                                  and not letter.items)
        self.topics = self._topics(body)
        # Tone is judged on whichever side of the exchange this filing is.
        self.escalations = (self._match(body, taxonomy.ESCALATION_PATTERNS)
                            if letter.is_staff_letter else [])
        self.concessions = (self._match(body, taxonomy.CONCESSION_PATTERNS)
                            if not letter.is_staff_letter else [])
        self.amendment_required = bool(taxonomy.AMENDMENT_REQUIRED.search(body))
        self.prospective_only = bool(
            taxonomy.PROSPECTIVE_ONLY.search(body)) and not self.amendment_required
        self.unreadable = len(whole.strip()) < 200
        self.score = self._score()

    @staticmethod
    def _match(text, patterns):
        found = []
        for regex, points, note in patterns:
            if regex.search(text):
                found.append((points, note))
        return found

    @staticmethod
    def _topics(text):
        found = []
        for topic in taxonomy.TOPICS:
            hits = topic.hits(text)
            if hits:
                found.append((topic, hits))
        found.sort(key=lambda pair: (pair[0].weight, pair[1]), reverse=True)
        return found

    # -- scoring -----------------------------------------------------------

    def _score(self):
        """Bearish pressure as a negative number; relief as a positive one.

        A closure letter is scored on its own terms: the staff writing "we
        have completed our review" ends the overhang regardless of what the
        thread was about, so its topic keywords are not double-counted.
        """
        if self.is_closure:
            return 12.0
        if self.unreadable or self.is_administrative:
            return 0.0

        # Topic pressure: the heaviest topic in full, the rest at a discount,
        # because one letter about six things is not six letters.
        weights = sorted((topic.weight for topic, _ in self.topics), reverse=True)
        pressure = 0.0
        for rank, weight in enumerate(weights[:5]):
            pressure += weight * (0.45 ** rank)

        escalation = sum(points for points, _ in self.escalations)
        concession = sum(points for points, _ in self.concessions)

        score = -(pressure + escalation)
        if self.amendment_required:
            score -= 15.0
        if self.prospective_only:
            score *= 0.5
        if not self.letter.is_staff_letter:
            # A company response is evidence about the thread, not a new
            # demand; it counts for less except where it concedes.
            score = min(score * 0.35, 0.0) + concession

        return max(-90.0, min(20.0, score))

    # -- presentation ------------------------------------------------------

    def headline_topics(self, limit=4):
        return [topic.label for topic, _ in self.topics[:limit]]

    def summary_lines(self, max_items=6):
        """A compact, faithful summary built only from the letter's own text."""
        lines = []
        if self.unreadable:
            return ["Letter text could not be extracted from EDGAR "
                    "(scanned PDF with no text layer). Open the filing directly."]
        if self.is_administrative:
            return ["Administrative correspondence - an acceleration or "
                    "withdrawal request, or the staff declining to review a "
                    "registration statement. No accounting comments in it."]
        if self.is_closure:
            lines.append("Staff closed the review: \"we have completed our review\" "
                         "- no further comments outstanding.")
        if self.letter.subject:
            lines.append("Re: %s" % self.letter.subject)

        staff = self.letter.is_staff_letter
        for item in self.letter.items[:max_items]:
            where = (" [%s]" % item.section) if item.section else ""
            if staff:
                lines.append("#%d%s %s" % (item.number, where, item.ask[:400]))
            else:
                lines.append("#%d%s asked: %s" % (item.number, where, item.ask[:260]))
                if item.reply:
                    lines.append("answered: %s" % item.reply)

        if not self.letter.items and not self.is_closure:
            lines.append(self.letter.body_excerpt())

        for _, note in self.escalations:
            lines.append("Tone: %s." % note)
        for _, note in self.concessions:
            lines.append("Response: %s." % note)
        return lines


def build(fetcher, filings, fetch_text):
    """Fetch, parse, and analyse a list of filings. Newest first."""
    analyses = []
    for filing in filings:
        text = fetch_text(fetcher, filing)
        analyses.append(Analysis(Letter(filing, text)))
    return analyses
