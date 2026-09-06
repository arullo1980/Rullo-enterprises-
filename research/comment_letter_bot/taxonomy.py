"""What SEC staff comments are about, and how much each kind should worry you.

The weights are pressure points on a 0-40 scale and encode one opinion: a
comment that can force a company to restate or that questions whether the
books can be relied on is a different animal from a comment about the order
of a non-GAAP reconciliation. Both are real; only one moves the thesis.

Weights are deliberately in one table so they can be argued with, tuned, and
back-tested rather than buried in scoring code.
"""

import re


class Topic:
    def __init__(self, key, label, weight, patterns, note=""):
        self.key = key
        self.label = label
        self.weight = weight
        self.note = note
        self.regex = re.compile("|".join(patterns), re.I)

    def hits(self, text):
        return len(self.regex.findall(text))


# Ordered roughly by how much a live comment on the subject should move you.
TOPICS = [
    Topic("restatement", "Restatement / non-reliance", 40, [
        r"\brestat(e|ed|ement|ements)\b",
        r"non-?reliance",
        r"item\s*4\.02",
        r"previously issued financial statements",
    ], "The staff is questioning numbers already reported as final."),

    Topic("material_weakness", "ICFR material weakness", 34, [
        r"material weakness(es)?",
        r"internal control over financial reporting",
        r"\bICFR\b",
        r"disclosure controls and procedures were not effective",
        r"significant deficienc(y|ies)",
    ], "Control failures precede earnings surprises more often than not."),

    Topic("going_concern", "Going concern / liquidity", 32, [
        r"going concern",
        r"substantial doubt",
        r"ability to continue as a going concern",
        r"ASC 205-40",
    ], "Solvency language in a staff letter is never routine."),

    Topic("revenue_recognition", "Revenue recognition (ASC 606)", 26, [
        r"revenue recognition",
        r"ASC\s*606",
        r"principal versus agent|principal vs\.? agent|gross versus net|gross vs\.? net",
        r"performance obligation",
        r"variable consideration",
        r"bill[- ]and[- ]hold",
    ], "Timing and gross/net calls change the top line itself."),

    Topic("impairment", "Impairment of goodwill or long-lived assets", 24, [
        r"impairment",
        r"ASC\s*350|ASC\s*360",
        r"reporting unit",
        r"triggering event",
        r"recoverab(le|ility) of",
    ], "Usually a write-down argument that has not been taken yet."),

    Topic("business_combination", "Business combinations (ASC 805)", 20, [
        r"business combination",
        r"ASC\s*805",
        r"purchase price allocation",
        r"contingent consideration",
        r"asset acquisition",
    ]),

    Topic("consolidation", "Consolidation / VIEs", 20, [
        r"variable interest entit(y|ies)",
        r"\bVIE\b",
        r"ASC\s*810",
        r"consolidat(e|ion) of",
        r"primary beneficiary",
    ]),

    Topic("fair_value", "Fair value / Level 3 estimates", 18, [
        r"fair value",
        r"ASC\s*820",
        r"level 3 (inputs|measurements)",
        r"valuation (technique|methodology|allowance)",
        r"unobservable inputs",
    ]),

    Topic("credit_losses", "Credit losses / allowances / reserves", 18, [
        r"allowance for (credit|doubtful|loan) losses",
        r"\bCECL\b|ASC\s*326",
        r"reserve methodology",
        r"charge-?offs?",
    ]),

    Topic("segments", "Segment reporting (ASC 280)", 17, [
        r"segment(s| reporting| disclosure)",
        r"ASC\s*280",
        r"chief operating decision maker|\bCODM\b",
        r"operating segments",
        r"aggregation criteria",
    ], "Re-segmentation changes what investors can see, and often why."),

    Topic("income_taxes", "Income taxes (ASC 740)", 16, [
        r"income tax(es)?",
        r"ASC\s*740",
        r"valuation allowance",
        r"effective tax rate",
        r"uncertain tax position",
        r"undistributed (foreign )?earnings",
    ]),

    Topic("related_party", "Related-party transactions", 16, [
        r"related part(y|ies)",
        r"Item 404",
        r"ASC\s*850",
        r"affiliate transactions",
    ], "Governance smoke; occasionally fire."),

    Topic("concentration", "Customer / supplier concentration", 14, [
        r"concentration of (credit )?risk",
        r"significant customer",
        r"single (customer|supplier|vendor)",
        r"customer concentration",
    ]),

    Topic("non_gaap", "Non-GAAP measures", 14, [
        r"non-?GAAP",
        r"Item 10\(e\)",
        r"Regulation G",
        r"adjusted (EBITDA|earnings|revenue)",
        r"equal or greater prominence",
        r"individually tailored (accounting )?measure",
    ], "Common and usually cosmetic - unless the adjustment is the story."),

    Topic("mdna", "MD&A quality / KPIs / liquidity", 13, [
        r"management'?s discussion and analysis|\bMD&A\b",
        r"key performance indicator|\bKPIs?\b",
        r"results of operations",
        r"liquidity and capital resources",
        r"known trends? (or|and) uncertaint(y|ies)",
        r"quantify the (extent|impact|underlying)",
    ], "Disclosure comments, but they force detail companies chose to omit."),

    Topic("stock_comp", "Share-based compensation / cheap stock", 13, [
        r"share-?based compensation|stock-?based compensation",
        r"ASC\s*718",
        r"cheap stock",
        r"grant date fair value",
    ]),

    Topic("inventory", "Inventory and cost of sales", 12, [
        r"inventor(y|ies)",
        r"lower of cost (and|or) (net realizable value|market)",
        r"cost of (sales|revenue|goods sold)",
        r"excess and obsolete",
    ]),

    Topic("leases", "Leases (ASC 842)", 11, [
        r"\bleases?\b",
        r"ASC\s*842",
        r"right-?of-?use asset",
        r"incremental borrowing rate",
    ]),

    Topic("debt", "Debt, covenants, and equity instruments", 14, [
        r"covenant",
        r"debt (classification|modification|extinguishment)",
        r"convertible (note|debt|preferred)",
        r"ASC\s*470|ASC\s*480|ASC\s*815",
        r"derivative liabilit(y|ies)",
    ]),

    Topic("digital_assets", "Digital assets / crypto", 15, [
        r"digital assets?",
        r"crypto(currency|currencies|-?assets?)?",
        r"safeguarding obligation",
        r"\bSAB 121\b",
    ]),

    Topic("climate_cyber", "Climate, cyber, and human-capital disclosure", 8, [
        r"climate(-related)? (risk|disclosure|change)",
        r"cybersecurity",
        r"Item 1\.05",
        r"human capital",
        r"greenhouse gas",
    ], "Disclosure-regime housekeeping; rarely thesis-changing."),

    Topic("risk_factors", "Risk factors and forward-looking language", 7, [
        r"risk factors?",
        r"Item 105",
        r"forward-?looking statements",
        r"safe harbor",
    ]),

    Topic("executive_comp", "Executive compensation disclosure", 7, [
        r"Item 402",
        r"compensation discussion and analysis|\bCD&A\b",
        r"pay (versus|vs\.?) performance",
        r"perquisites",
    ]),
]

TOPICS_BY_KEY = {topic.key: topic for topic in TOPICS}


# ------------------------------------------------------------- letter tone --

# Phrases that show the staff escalating rather than merely asking.
ESCALATION_PATTERNS = [
    (re.compile(r"we (re)?issue our (previous|prior) comment", re.I), 12,
     "staff reissued an unresolved comment"),
    (re.compile(r"we note your response.{0,60}however", re.I | re.S), 8,
     "staff was not satisfied by the response"),
    (re.compile(r"please (revise|amend) (your|the) (filing|Form|registration)", re.I), 7,
     "staff asked for a revised or amended filing"),
    (re.compile(r"\bamend\b.{0,30}\bForm\s*(10-K|10-Q|8-K|S-1)\b", re.I), 10,
     "amendment of a filed report requested"),
    (re.compile(r"we do not (agree|believe)", re.I), 9,
     "staff disagreed with the company's position"),
    (re.compile(r"provide us with your analysis|tell us how you (considered|determined)",
                re.I), 4,
     "staff asked for a supporting technical analysis"),
    (re.compile(r"it (is |appears )?unclear|we are unable to (agree|locate)", re.I), 4,
     "staff found the disclosure unclear"),
]

# The staff's sign-off letter. Its arrival is the end of the overhang.
CLOSURE_PATTERNS = [
    re.compile(r"we have completed our review", re.I),
    re.compile(r"we have no further comments", re.I),
]

# Company language that concedes the point.
CONCESSION_PATTERNS = [
    (re.compile(r"\bwill (restate|amend)\b|\bintends? to (restate|amend)\b", re.I), -18,
     "company agreed to restate or amend"),
    (re.compile(r"(revise|update|expand|enhance)[^.]{0,40}"
                r"(future|subsequent) filings", re.I), -4,
     "company agreed to fix disclosure prospectively"),
    (re.compile(r"we (respectfully )?(advise|submit|believe) that .{0,80}"
                r"(appropriate|correct|complies)", re.I | re.S), 3,
     "company defended its accounting"),
]

# Traffic between a filer and the staff that carries no accounting content:
# acceleration requests, withdrawal notices, and the staff's own "we are not
# going to review this" note. Real filings, but not comments.
ADMINISTRATIVE = re.compile(
    r"we do not intend to review your registration statement"
    r"|pursuant to rule 461"
    r"|request(s|ing)? that the effective date"
    r"|acceleration of (the )?effective(ness|\s*date)"
    r"|withdrawal of (the )?registration statement"
    r"|\bRule 477\b", re.I)

# A staff request that only asks for future-filing changes is low stakes.
PROSPECTIVE_ONLY = re.compile(
    r"in future filings"
    r"|(revise|update|expand|enhance)[^.]{0,40}(future|subsequent) filings"
    r"|beginning with your next (Form|periodic report)", re.I)

AMENDMENT_REQUIRED = re.compile(
    r"please amend (your|the) (Form|filing|registration statement)"
    r"|file an amend(ed|ment)"
    r"|\bitem\s*4\.02\b"
    r"|\brestate(ment)?\b", re.I)
