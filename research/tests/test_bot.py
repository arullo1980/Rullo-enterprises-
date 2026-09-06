"""Offline tests. No network, no credentials, no fixtures newer than the repo.

Run from the repository root:

    python3 -m unittest discover -s research/tests -t research
"""

import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from comment_letter_bot import edgar, letters, prices, scoring, taxonomy  # noqa: E402
from comment_letter_bot.cli import _parse_date  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as handle:
        return handle.read()


def make_filing(form, filed, accession="0000000000-25-000001"):
    return edgar.Filing(cik=99999, form=form, filing_date=filed,
                        accession=accession, primary_document="filename1.htm")


def analyse(fixture_name, form, filed):
    text = edgar.extract_text(fixture(fixture_name))
    return letters.Analysis(letters.Letter(make_filing(form, filed), text))


# --------------------------------------------------------------- extraction --

class ExtractionTests(unittest.TestCase):
    def test_prefers_text_extract_over_pdf(self):
        text = edgar.extract_text(fixture("upload_closure.txt"))
        self.assertIn("We have completed our review", text)
        self.assertNotIn("begin 644", text)

    def test_html_response_is_flattened(self):
        text = edgar.extract_text(fixture("corresp_response.txt"))
        self.assertIn("The Company respectfully advises", text)
        self.assertNotIn("<p>", text)

    def test_strip_html_unescapes_and_breaks_lines(self):
        out = edgar.strip_html("<p>a &amp; b</p><p>c</p>")
        self.assertIn("a & b", out)
        self.assertIn("c", out)

    def test_split_submission_reports_each_document(self):
        docs = edgar.split_submission(fixture("upload_closure.txt"))
        self.assertEqual([d[0] for d in docs], ["LETTER", "TEXT-EXTRACT"])


# ------------------------------------------------------------------ parsing --

class ParsingTests(unittest.TestCase):
    def test_closure_letter_is_recognised(self):
        analysis = analyse("upload_closure.txt", "UPLOAD", datetime.date(2024, 5, 16))
        self.assertTrue(analysis.is_closure)
        self.assertGreater(analysis.score, 0)
        self.assertIn("Form 10-K", analysis.letter.subject)
        self.assertNotIn("Dear", analysis.letter.subject)

    def test_numbered_comments_and_sections(self):
        analysis = analyse("upload_material_weakness.txt", "UPLOAD",
                           datetime.date(2025, 3, 6))
        items = analysis.letter.items
        self.assertEqual([i.number for i in items], [1, 2])
        self.assertIn("Note 16", items[0].section)
        self.assertIn("Please tell us", items[0].ask)

    def test_running_headers_are_stripped(self):
        analysis = analyse("upload_material_weakness.txt", "UPLOAD",
                           datetime.date(2025, 3, 6))
        # "Jane Roe" repeats at every page break in the extracted text and
        # would otherwise land in the middle of comment 1.
        self.assertNotIn("Jane Roe", analysis.letter.items[0].text)
        self.assertIn("material weakness", analysis.letter.items[0].text)

    def test_response_letter_splits_comment_from_answer(self):
        analysis = analyse("corresp_response.txt", "CORRESP",
                           datetime.date(2025, 3, 20))
        item = analysis.letter.items[0]
        self.assertIn("Please tell us", item.comment)
        self.assertIn("respectfully advises", item.response)
        self.assertNotIn("respectfully advises", item.comment)

    def test_response_scoring_uses_only_the_company_words(self):
        analysis = analyse("corresp_response.txt", "CORRESP",
                           datetime.date(2025, 3, 20))
        # The staff's "Please tell us" is quoted in the letter but must not be
        # counted as the company escalating against itself.
        self.assertEqual(analysis.escalations, [])
        self.assertTrue(analysis.prospective_only)


# ------------------------------------------------------------------ scoring --

class TaxonomyTests(unittest.TestCase):
    def test_topic_weights_are_ordered_by_severity(self):
        self.assertGreater(taxonomy.TOPICS_BY_KEY["restatement"].weight,
                           taxonomy.TOPICS_BY_KEY["non_gaap"].weight)
        self.assertGreater(taxonomy.TOPICS_BY_KEY["material_weakness"].weight,
                           taxonomy.TOPICS_BY_KEY["risk_factors"].weight)

    def test_material_weakness_letter_scores_worse_than_a_disclosure_nit(self):
        heavy = analyse("upload_material_weakness.txt", "UPLOAD",
                        datetime.date(2025, 3, 6))
        light = analyse("upload_closure.txt", "UPLOAD", datetime.date(2025, 3, 6))
        self.assertLess(heavy.score, light.score)
        self.assertTrue(heavy.amendment_required)
        labels = heavy.headline_topics(5)
        self.assertIn("ICFR material weakness", labels)


class ScoringTests(unittest.TestCase):
    def test_decay_halves_at_the_half_life(self):
        self.assertAlmostEqual(scoring.decay_weight(scoring.HALF_LIFE), 0.5, places=6)
        self.assertEqual(scoring.decay_weight(0), 1.0)

    def test_no_letters_is_no_signal_not_a_buy(self):
        verdict = scoring.evaluate([], price=None, events={},
                                   as_of=datetime.date(2025, 6, 1))
        self.assertEqual(verdict.direction, "NO SIGNAL")
        self.assertEqual(verdict.composite, 0.0)

    def test_unpriced_pressure_leans_down(self):
        heavy = analyse("upload_material_weakness.txt", "UPLOAD",
                        datetime.date(2025, 3, 6))
        verdict = scoring.evaluate([heavy], price=None, events={},
                                   as_of=datetime.date(2025, 3, 20))
        self.assertLess(verdict.fundamental, 0)
        self.assertIn(verdict.direction, ("DOWN", "SLIGHTLY DOWN"))
        self.assertTrue(any("Asymmetry" in r for r in verdict.reasons))

    def test_a_selloff_already_taken_dampens_the_bearish_read(self):
        heavy = analyse("upload_material_weakness.txt", "UPLOAD",
                        datetime.date(2025, 3, 6))
        events = {heavy.filing.accession: {"raw": -20.0, "abnormal": -18.0,
                                           "benchmark": -2.0, "window": 10,
                                           "complete": True}}
        without = scoring.evaluate([heavy], events={},
                                   as_of=datetime.date(2025, 3, 20))
        with_selloff = scoring.evaluate([heavy], events=events,
                                        as_of=datetime.date(2025, 3, 20))
        self.assertGreater(with_selloff.composite, without.composite)

    def test_old_letters_matter_less_than_new_ones(self):
        old = analyse("upload_material_weakness.txt", "UPLOAD",
                      datetime.date(2021, 3, 6))
        fresh = analyse("upload_material_weakness.txt", "UPLOAD",
                        datetime.date(2025, 3, 6))
        as_of = datetime.date(2025, 4, 1)
        self.assertGreater(scoring.evaluate([old], as_of=as_of).fundamental,
                           scoring.evaluate([fresh], as_of=as_of).fundamental)

    def test_closure_alone_does_not_manufacture_a_buy_signal(self):
        closed = analyse("upload_closure.txt", "UPLOAD", datetime.date(2025, 3, 6))
        verdict = scoring.evaluate([closed], as_of=datetime.date(2025, 3, 20))
        self.assertEqual(verdict.direction, "NEUTRAL")
        self.assertFalse(verdict.review_open)


class AdministrativeTests(unittest.TestCase):
    """Acceleration requests share a form type with real comment letters."""

    RULE_461 = ("<DOCUMENT>\n<TYPE>CORRESP\n<FILENAME>a.htm\n<TEXT>\n"
                "<p>Re: Registration Statement on Form S-1</p>"
                "<p>Ladies and Gentlemen:</p>"
                "<p>Pursuant to Rule 461 under the Securities Act of 1933, as "
                "amended, Example Corp hereby requests that the effective date "
                "of the Registration Statement be accelerated so that it will "
                "become effective on Friday at 5:15 p.m.</p>\n"
                "</TEXT>\n</DOCUMENT>")

    NO_REVIEW = ("<DOCUMENT>\n<TYPE>TEXT-EXTRACT\n<FILENAME>filename2.txt\n<TEXT>\n"
                 "       Re: Example Corp\n\n       Dear Jane Roe:\n\n"
                 "This is to advise you that we do not intend to review your\n"
                 "registration statement. We remind you that the company and its\n"
                 "management are responsible for the accuracy of their disclosures.\n"
                 "</TEXT>\n</DOCUMENT>")

    def _analyse(self, raw, form):
        text = edgar.extract_text(raw)
        return letters.Analysis(
            letters.Letter(make_filing(form, datetime.date(2025, 6, 2)), text))

    def test_acceleration_request_is_administrative_and_scores_zero(self):
        analysis = self._analyse(self.RULE_461, "CORRESP")
        self.assertTrue(analysis.is_administrative)
        self.assertEqual(analysis.score, 0.0)

    def test_no_review_notice_survives_line_wrapping(self):
        # The phrase is split across two lines in the source, as EDGAR's text
        # extractor always splits it.
        analysis = self._analyse(self.NO_REVIEW, "UPLOAD")
        self.assertTrue(analysis.is_administrative)

    def test_administrative_letters_are_not_review_rounds(self):
        admin = self._analyse(self.NO_REVIEW, "UPLOAD")
        verdict = scoring.evaluate([admin], as_of=datetime.date(2025, 6, 20))
        self.assertEqual(verdict.rounds, 0)
        self.assertEqual(verdict.direction, "NEUTRAL")


# ------------------------------------------------------------------- prices --

def build_series(symbol, start, values):
    dates, day = [], start
    for _ in values:
        dates.append(day)
        day += datetime.timedelta(days=1)
    return prices.Series(symbol, dates, list(values))


class PriceTests(unittest.TestCase):
    def setUp(self):
        self.start = datetime.date(2025, 1, 1)
        self.stock = build_series("XYZ", self.start, [100.0] * 5 + [90.0] * 20)
        self.bench = build_series("SPY", self.start, [100.0] * 25)

    def test_pct_change_from_a_past_date(self):
        self.assertAlmostEqual(prices.pct_change(self.stock, self.start), -10.0)

    def test_event_return_is_net_of_the_benchmark(self):
        event = prices.event_return(self.stock, self.bench,
                                    datetime.date(2025, 1, 6), window=5)
        self.assertAlmostEqual(event["raw"], -10.0)
        self.assertAlmostEqual(event["abnormal"], -10.0)

    def test_event_window_running_past_the_data_returns_nothing(self):
        self.assertIsNone(prices.event_return(self.stock, self.bench,
                                              datetime.date(2025, 1, 24), window=10))

    def test_snapshot_reports_the_drawdown(self):
        snapshot = prices.snapshot(self.stock)
        self.assertAlmostEqual(snapshot["drawdown_from_52w_high"], -10.0)
        self.assertEqual(snapshot["last"], 90.0)


class DateParsingTests(unittest.TestCase):
    def test_accepted_formats(self):
        self.assertEqual(_parse_date("2025-03-06"), datetime.date(2025, 3, 6))
        self.assertEqual(_parse_date("03/06/2025"), datetime.date(2025, 3, 6))
        self.assertEqual(_parse_date("2025-03"), datetime.date(2025, 3, 1))

    def test_rejects_nonsense(self):
        with self.assertRaises(ValueError):
            _parse_date("last tuesday")


if __name__ == "__main__":
    unittest.main()
