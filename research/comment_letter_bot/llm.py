"""Optional narrative layer.

Everything the bot decides - topics, scores, direction - is computed without
a model. This module only adds prose: a plain-English read of each letter and
a synthesis of the whole picture. It is skipped silently when the `anthropic`
package or credentials are missing, so the tool never depends on it.

    pip install anthropic
    export ANTHROPIC_API_KEY=...        # or: ant auth login
"""

import json

from . import config

SYSTEM = (
    "You are a sell-side forensic accounting analyst reading SEC staff comment "
    "letters (form UPLOAD) and company responses (form CORRESP). You are terse, "
    "specific, and sceptical of your own conclusions. You never speculate about "
    "facts that are not in the letter, and you never give investment advice. "
    "When a letter is routine, say it is routine."
)

# Very large letters are rare; when one appears, say so rather than silently
# sending a truncated document to the model.
MAX_CHARS = 180_000


class Unavailable(RuntimeError):
    pass


def client():
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise Unavailable("the `anthropic` package is not installed "
                          "(pip install anthropic)") from exc
    try:
        return anthropic.Anthropic()
    except Exception as exc:  # noqa: BLE001 - surfaces missing credentials
        raise Unavailable("no Anthropic credentials found: %s" % exc) from exc


def available():
    try:
        client()
        return True
    except Unavailable:
        return False


def _ask(handle, prompt, schema, max_tokens=8000):
    response = handle.messages.create(
        model=config.LLM_MODEL,
        max_tokens=max_tokens,
        system=SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": prompt}],
    )
    if getattr(response, "stop_reason", None) == "refusal":
        raise Unavailable("model declined to answer")
    text = next((b.text for b in response.content if b.type == "text"), "")
    return json.loads(text)


LETTER_SCHEMA = {
    "type": "object",
    "properties": {
        "read": {"type": "string",
                 "description": "Two or three sentences: what the staff is "
                                "actually challenging and what it would cost "
                                "the company to concede."},
        "routine": {"type": "boolean",
                    "description": "True if this is ordinary disclosure "
                                   "housekeeping with no earnings implication."},
    },
    "required": ["read", "routine"],
    "additionalProperties": False,
}

SYNTHESIS_SCHEMA = {
    "type": "object",
    "properties": {
        "synthesis": {"type": "string",
                      "description": "Three to five sentences tying the letters "
                                     "together and naming the single thing that "
                                     "would change the read."},
    },
    "required": ["synthesis"],
    "additionalProperties": False,
}


def read_letter(handle, company_name, analysis):
    text = analysis.letter.text
    if len(text) > MAX_CHARS:
        return ("Letter is %d characters - too long to send in one request; "
                "read it directly at %s"
                % (len(text), analysis.filing.index_url))
    prompt = (
        "Company: %s\nForm: %s\nFiled: %s\n\n"
        "Comment letter text follows between the markers.\n"
        "<<<LETTER\n%s\nLETTER>>>\n\n"
        "Give your read. Judge materiality by whether the staff's position, if "
        "conceded, would change reported numbers, restrict a disclosure the "
        "company relies on, or force an amendment."
        % (company_name, analysis.filing.form, analysis.filing.filing_date, text)
    )
    return _ask(handle, prompt, LETTER_SCHEMA)["read"]


def synthesise(handle, company_name, result):
    facts = {
        "company": company_name,
        "window": result["window"],
        "letters": [{"form": l["form"], "filed": l["filed"], "topics": l["topics"],
                     "score": l["score"], "summary": l["summary"][:6]}
                    for l in result["letters"]],
        "price": result.get("price"),
        "verdict": result["verdict"],
    }
    prompt = (
        "Here is a completed deterministic analysis of one company's SEC "
        "comment-letter record and its price context, as JSON:\n\n%s\n\n"
        "Write the synthesis a portfolio manager needs: what the filing record "
        "says about the business, whether the computed direction is well "
        "founded or fragile, and the single piece of evidence that would flip "
        "it. Do not restate the numbers. Do not recommend a trade."
        % json.dumps(facts, indent=2, default=str)
    )
    return _ask(handle, prompt, SYNTHESIS_SCHEMA)["synthesis"]


def enrich(result, analyses, company_name, per_letter=True):
    """Add `narrative` fields in place. Returns a note when it cannot run."""
    try:
        handle = client()
    except Unavailable as exc:
        return str(exc)

    by_accession = {a.filing.accession: a for a in analyses}
    if per_letter:
        for entry in result["letters"]:
            analysis = by_accession.get(entry["accession"])
            if analysis is None or analysis.unreadable:
                continue
            try:
                entry["narrative"] = read_letter(handle, company_name, analysis)
            except Exception as exc:  # noqa: BLE001 - enrichment is best effort
                entry["narrative"] = "unavailable (%s)" % exc
    try:
        result["narrative"] = synthesise(handle, company_name, result)
    except Exception as exc:  # noqa: BLE001
        return "synthesis unavailable (%s)" % exc
    return None
