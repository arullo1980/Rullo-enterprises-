"""Offline tests. No network, no credentials, no fixtures newer than the repo.

Run from the repository root:

    python3 -m unittest discover -s research/tests -t research
"""

import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from comment_letter_bot import (census, edgar, insiders, letters, prices,  # noqa: E402
                                scoring, taxonomy)
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


class EvidenceWeightingTests(unittest.TestCase):
    """One passing mention of a heavy topic is not a letter about that topic."""

    def test_a_single_mention_earns_half_the_topic_weight(self):
        self.assertEqual(letters.Analysis.evidence_factor(1), 0.5)
        self.assertEqual(letters.Analysis.evidence_factor(3), 1.0)
        self.assertEqual(letters.Analysis.evidence_factor(0), 0.0)

    def test_headline_topic_is_the_one_with_evidence_behind_it(self):
        # Non-GAAP outweighs leases 14 to 11 on the table, so a letter that
        # mentions non-GAAP once and argues about leases throughout is ranked
        # as a lease letter: 14 x 0.5 is less than 11 x 1.0.
        filing = make_filing("UPLOAD", datetime.date(2025, 6, 2))
        text = ("1.    We note your non-GAAP presentation. "
                + "Please tell us how your lease accounting under ASC 842 "
                  "treats the right-of-use asset and the incremental borrowing "
                  "rate for each lease, and revise your lease disclosures. " * 3)
        analysis = letters.Analysis(letters.Letter(filing, text))
        self.assertEqual(analysis.headline_topics(1), ["Leases (ASC 842)"])

    def test_a_heavy_topic_argued_at_length_still_outranks_a_light_one(self):
        # The discount is a discount, not an inversion: one mention of a
        # restatement is still the most serious thing in a lease letter.
        filing = make_filing("UPLOAD", datetime.date(2025, 6, 2))
        text = ("1.    We note the restatement of your previously issued "
                "financial statements. "
                + "Please tell us how your lease accounting under ASC 842 "
                  "treats the right-of-use asset. " * 3)
        analysis = letters.Analysis(letters.Letter(filing, text))
        self.assertEqual(analysis.headline_topics(1), ["Restatement / non-reliance"])

    def test_repeated_evidence_scores_worse_than_a_passing_mention(self):
        filing = make_filing("UPLOAD", datetime.date(2025, 6, 2))
        passing = letters.Analysis(letters.Letter(filing, (
            "1.    We note the reference to a material weakness on page 41. "
            "Please confirm the page number is correct.")))
        argued = letters.Analysis(letters.Letter(filing, (
            "1.    We note the material weakness disclosed on page 41. Tell us "
            "how you concluded internal control over financial reporting was "
            "effective given that material weakness, and describe the "
            "significant deficiencies aggregated into it.")))
        self.assertLess(argued.score, passing.score)


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


# ---------------------------------------------------- the private window --

class DisseminationTests(unittest.TestCase):
    """The date on a comment letter is not the date the market saw it."""

    def test_header_yields_the_public_date_not_the_letter_date(self):
        filing = make_filing("UPLOAD", datetime.date(2025, 9, 10))
        info = edgar.parse_submission_header(fixture("upload_header.txt"), filing)
        self.assertEqual(info["public_date"], datetime.date(2026, 1, 27))
        self.assertTrue(info["was_private"])
        self.assertEqual(filing.public_date, datetime.date(2026, 1, 27))
        self.assertEqual(filing.private_window_days, 139)
        self.assertEqual(filing.effective_public_date, datetime.date(2026, 1, 27))

    def test_missing_header_falls_back_to_the_filing_date(self):
        filing = make_filing("UPLOAD", datetime.date(2025, 9, 10))
        edgar.parse_submission_header("no header here", filing)
        self.assertIsNone(filing.public_date)
        self.assertFalse(filing.was_private)
        # Conservative: understates the window rather than inventing one.
        self.assertEqual(filing.effective_public_date, datetime.date(2025, 9, 10))

    def test_letters_age_from_publication_not_from_their_own_date(self):
        text = edgar.extract_text(fixture("upload_header.txt"))
        filing = make_filing("UPLOAD", datetime.date(2025, 9, 10))
        edgar.parse_submission_header(fixture("upload_header.txt"), filing)
        analysis = letters.Analysis(letters.Letter(filing, text))
        verdict = scoring.evaluate([analysis], as_of=datetime.date(2026, 2, 3))
        # One week old as news, five months old as a document.
        self.assertGreater(verdict.contributions[0].weight, 0.95)


class Form4Tests(unittest.TestCase):
    def _trades(self, name):
        filing = make_filing("4", datetime.date(2025, 11, 17))
        return insiders.parse_form4(fixture(name), filing)

    def test_parses_owner_role_and_transaction(self):
        trades = self._trades("form4_sale.xml")
        sale = trades[0]
        self.assertEqual(sale.owner, "Roe Jane")
        self.assertIn("chief financial officer", sale.roles)
        self.assertEqual(sale.code, "S")
        self.assertEqual(sale.value, 40000 * 25.50)
        self.assertTrue(sale.disposed)
        self.assertTrue(sale.open_market)
        self.assertTrue(sale.discretionary)

    def test_tax_withholding_is_not_an_open_market_trade(self):
        withholding = self._trades("form4_sale.xml")[1]
        self.assertEqual(withholding.code, "F")
        self.assertFalse(withholding.open_market)

    def test_10b5_1_plan_sales_are_not_discretionary(self):
        planned = self._trades("form4_planned_sale.xml")[0]
        self.assertTrue(planned.planned)
        self.assertTrue(planned.open_market)
        self.assertFalse(planned.discretionary)

    def test_unparseable_xml_returns_no_trades(self):
        filing = make_filing("4", datetime.date(2025, 11, 17))
        self.assertEqual(insiders.parse_form4("<not xml", filing), [])


class WindowSignalTests(unittest.TestCase):
    START = datetime.date(2025, 9, 10)
    END = datetime.date(2026, 1, 27)

    def _activity(self, fixture_name):
        filing = make_filing("4", datetime.date(2025, 11, 17))
        trades = insiders.parse_form4(fixture(fixture_name), filing)
        return insiders.WindowActivity(self.START, self.END, trades, [])

    def test_routine_letter_means_the_window_is_reported_but_not_scored(self):
        points, notes = self._activity("form4_sale.xml").signal(letter_score=-4.0)
        self.assertEqual(points, 0.0)
        self.assertTrue(any("not scored" in n for n in notes))

    def test_discretionary_selling_against_a_serious_letter_scores_down(self):
        points, notes = self._activity("form4_sale.xml").signal(letter_score=-34.0)
        self.assertLess(points, 0)
        self.assertTrue(any("not yet public" in n for n in notes))

    def test_a_10b5_1_plan_sale_is_reported_but_not_held_against_anyone(self):
        activity = self._activity("form4_planned_sale.xml")
        points, notes = activity.signal(letter_score=-34.0)
        self.assertEqual(points, 0.0)
        self.assertTrue(any("10b5-1" in n for n in notes))

    def test_trades_outside_the_window_are_excluded_by_date(self):
        activity = self._activity("form4_sale.xml")
        narrow = insiders.WindowActivity(
            datetime.date(2025, 12, 1), self.END,
            [t for t in activity.trades
             if datetime.date(2025, 12, 1) <= t.date <= self.END], [])
        self.assertEqual(narrow.trades, [])
        self.assertEqual(narrow.signal(letter_score=-34.0)[0], 0.0)

    def test_insider_pressure_reaches_the_verdict(self):
        text = edgar.extract_text(fixture("upload_header.txt"))
        filing = make_filing("UPLOAD", self.START, accession="0000000000-25-009803")
        edgar.parse_submission_header(fixture("upload_header.txt"), filing)
        analysis = letters.Analysis(letters.Letter(filing, text))
        signal = self._activity("form4_sale.xml").signal(analysis.score)
        without = scoring.evaluate([analysis], as_of=datetime.date(2026, 2, 3))
        with_insiders = scoring.evaluate(
            [analysis], as_of=datetime.date(2026, 2, 3),
            insider_signals={filing.accession: signal})
        self.assertLess(with_insiders.fundamental, without.fundamental)
        self.assertLess(with_insiders.insider_pressure, 0)


# ------------------------------------------------------------- the census --

class CensusTests(unittest.TestCase):
    def test_display_name_yields_cik_name_and_tickers(self):
        cik, name, tickers = census._parse_display(
            ["Nuburu, Inc.  (BURU, BURUW)  (CIK 0001861457)"], ["0001861457"])
        self.assertEqual(cik, 1861457)
        self.assertEqual(name, "Nuburu, Inc.")
        self.assertEqual(tickers, ["BURU", "BURUW"])

    def test_display_name_without_a_ticker_still_resolves(self):
        cik, name, tickers = census._parse_display(
            ["Thoughtful Media Group Inc.  (CIK 0001922639)"], ["0001922639"])
        self.assertEqual(cik, 1922639)
        self.assertEqual(tickers, [])

    def test_quarters_cover_the_range_without_gaps(self):
        spans = list(census._quarters(datetime.date(2024, 2, 15),
                                      datetime.date(2024, 12, 31)))
        self.assertEqual(spans[0][0], datetime.date(2024, 2, 15))
        self.assertEqual(spans[-1][1], datetime.date(2024, 12, 31))
        self.assertEqual(len(spans), 4)
        for earlier, later in zip(spans, spans[1:]):
            self.assertEqual((later[0] - earlier[1]).days, 1)

    def _registrant(self, dates):
        entry = census.Registrant(99999, "Example Corp", ["EXC"])
        for index, day in enumerate(dates):
            entry.letters["acc-%d" % index] = day
        return entry

    def test_rounds_within_one_review_are_one_thread(self):
        entry = self._registrant([datetime.date(2025, 3, 6),
                                  datetime.date(2025, 4, 2),
                                  datetime.date(2025, 5, 16)])
        self.assertEqual(entry.threads(), 1)
        self.assertEqual(entry.rounds_in_longest_thread(), 3)

    def test_a_steady_drip_of_letters_is_not_one_endless_review(self):
        # A serial filer draws letters every couple of months for years. Each
        # gap is short, but it is not one review with forty rounds.
        import datetime as dt
        dates = [dt.date(2019, 3, 18) + dt.timedelta(days=60 * i)
                 for i in range(20)]
        entry = self._registrant(dates)
        self.assertGreater(entry.threads(), 1)
        self.assertLess(entry.rounds_in_longest_thread(), 15)

    def test_reviews_years_apart_are_separate_threads(self):
        entry = self._registrant([datetime.date(2021, 3, 6),
                                  datetime.date(2023, 4, 2),
                                  datetime.date(2025, 5, 16)])
        self.assertEqual(entry.threads(), 3)
        self.assertEqual(entry.rounds_in_longest_thread(), 1)

    def test_overdue_ranking_respects_the_universe(self):
        stale = self._registrant([datetime.date(2019, 1, 4)])
        recent = census.Registrant(88888, "Fresh Inc", ["FRS"])
        recent.letters["a"] = datetime.date(2026, 1, 4)
        registrants = {99999: stale, 88888: recent}
        ranked = census.longest_without(registrants, universe={99999},
                                        as_of=datetime.date(2026, 9, 6))
        self.assertEqual([r.cik for r, _ in ranked], [99999])
        self.assertEqual(census.never_in_window(registrants, {99999, 77777}),
                         [77777])

    def test_a_letter_at_the_census_edge_is_flagged_as_a_floor(self):
        edge = self._registrant([datetime.date(2021, 1, 4)])
        middle = self._registrant([datetime.date(2023, 6, 1)])
        start = datetime.date(2021, 1, 1)
        self.assertTrue(census.is_censored(edge, start))
        self.assertFalse(census.is_censored(middle, start))


class PrivateWindowPriceTests(unittest.TestCase):
    def test_window_return_is_net_of_the_benchmark(self):
        start = datetime.date(2025, 1, 1)
        stock = build_series("XYZ", start, [100.0] * 5 + [120.0] * 5)
        bench = build_series("SPY", start, [100.0] * 5 + [110.0] * 5)
        drift = prices.window_return(stock, bench, start,
                                     datetime.date(2025, 1, 10))
        self.assertAlmostEqual(drift["raw"], 20.0)
        self.assertAlmostEqual(drift["abnormal"], 10.0)

    def test_a_zero_length_window_has_no_return(self):
        start = datetime.date(2025, 1, 1)
        stock = build_series("XYZ", start, [100.0] * 5)
        self.assertIsNone(prices.window_return(stock, None, start, start))


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
