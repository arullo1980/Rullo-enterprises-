# Stripe Radar rule set — Rullo Enterprises

Content Research Group USA Inc., trading as Rullo Enterprises
Version 1.0 · September 10, 2026 · Companion to `risk-and-compliance-statement.md`

## Before you start

- **Custom rules need Radar for Fraud Teams.** Stripe's built-in Radar only blocks "highest risk" payments. Writing your own rules, the review queue, and the velocity attributes below all require the Radar for Fraud Teams add-on (Stripe Dashboard → Radar → enable; it is a small per-transaction fee). Turn it on first or the rule editor will not accept these.
- **Where to enter them:** Stripe Dashboard → Radar → Rules. Each rule is one line. Use the "Test rule" button on every rule before saving; Stripe shows how many recent payments it would have caught.
- **Rules apply to every payment on the account**, including payments started by the Reloadly plugin, because the plugin charges through this Stripe account.
- **Amounts** in `:amount_in_usd:` are the payment amount converted to US dollars. Velocity amounts (`:total_amount_per_…:`) are in your settlement currency, which is USD.
- **3D Secure rules only work if the plugin's integration supports it.** Reloadly's plugin uses Stripe's hosted payment fields, which normally handle the 3DS challenge automatically. Confirm with a test payment using Stripe's 3DS test card (4000 0027 6000 3184) once live. If the challenge never appears, ask Reloadly to enable automatic 3D Secure on their Stripe integration and rely on the block and review rules until they do.
- **Order of evaluation:** Stripe evaluates Allow rules first, then Block, then Review, then Request 3DS. We use no Allow rules; an Allow rule overrides every Block rule, so never add one for convenience.

Enter the rules in the sections below, in this order.

## 1. Block rules

| # | Rule | Why |
| --- | --- | --- |
| B1 | `Block if :risk_level: = 'highest'` | Stripe's default; keep it enabled. |
| B2 | `Block if :risk_score: > 80` | Hard stop above our block threshold. |
| B3 | `Block if :amount_in_usd: > 500` | Backstop for the USD 500 order cap. Nothing legitimate exceeds it. |
| B4 | `Block if :card_country: in ('CU', 'IR', 'KP', 'SY')` | Cards issued in comprehensively sanctioned countries. |
| B5 | `Block if :ip_country: in ('CU', 'IR', 'KP', 'SY')` | Buyer connecting from a sanctioned country. |
| B6 | `Block if :is_anonymous_ip:` | Tor, VPN, and proxy traffic. Legitimate gift buyers do not hide their location. |
| B7 | `Block if :is_disposable_email:` | Throwaway email domains; the email is where gift card codes go. |
| B8 | `Block if :cvc_check: = 'fail'` | Wrong security code means the buyer does not hold the card. |
| B9 | `Block if :card_country: != :ip_country: and :risk_level: = 'elevated'` | Country mismatch is tolerable alone (see R3) but not combined with an elevated score. |
| B10 | `Block if :total_charges_per_card_number_daily: > 3` | Velocity cap: more than three orders per card per day. |
| B11 | `Block if :total_amount_per_card_number_daily: > 750` | Velocity cap: more than USD 750 per card per day. |
| B12 | `Block if :total_charges_per_email_daily: > 3` | Same caps keyed on the buyer's email. |
| B13 | `Block if :total_amount_per_email_daily: > 750` | |
| B14 | `Block if :total_charges_per_ip_address_daily: > 5` | Slightly looser on IP, since households share one. |
| B15 | `Block if :card_count_for_email_daily: > 2` | More than two different cards on one email in a day is card testing. |
| B16 | `Block if :card_count_for_ip_address_daily: > 3` | Same, per IP. |
| B17 | `Block if :declined_charges_per_card_number_daily: > 2` | Repeated declines then a success is a stolen-card pattern. |
| B18 | `Block if :blocked_charges_per_ip_address_daily: > 1` | Anyone Radar already blocked today does not get another try from the same IP. |

## 2. Review rules

Reviewed payments are authorised but held in Radar → Reviews. Approve or refund each one within the authorisation window (7 days for cards). The plugin will treat the payment as paid and may fulfil immediately, so **check the Reviews queue before fulfilment goes out, or set Reloadly to hold orders pending your approval if that option exists.** Until that is confirmed, treat review as an after-the-fact check that decides whether the next order from this buyer is allowed.

| # | Rule | Why |
| --- | --- | --- |
| R1 | `Review if :amount_in_usd: > 250` | Manual review threshold from the compliance statement. |
| R2 | `Review if :risk_score: > 65` | Our review threshold. |
| R3 | `Review if :card_country: != :ip_country:` | Buyer abroad using a card from elsewhere. Common for diaspora customers, so review rather than block. |
| R4 | `Review if :card_funding: = 'prepaid'` | Prepaid cards buying gift cards is a laundering and fraud pattern. |
| R5 | `Review if :total_charges_per_card_number_daily: > 1 and :amount_in_usd: > 100` | A second sizeable order from the same card in a day. |
| R6 | `Review if :total_charges_per_ip_address_daily: > 2` | Third order from one IP in a day. |
| R7 | `Review if :email_count_for_card_number_weekly: > 1` | One card used with more than one email address. |
| R8 | `Review if :name_count_for_card_number_weekly: > 1` | One card used with more than one cardholder name. |
| R9 | `Review if :address_zip_check: = 'fail'` | Only fires if the plugin collects a billing postcode; harmless otherwise. |
| R10 | `Review if :ip_country: in ('RU', 'BY', 'NG', 'GH', 'PK', 'ID', 'VN')` | Countries with the highest gift-card fraud rates. Review, not block, because they are also real destinations for our customers' families. Revisit after 90 days of data. |

## 3. Request 3D Secure rules

3DS shifts liability for fraudulent card use to the issuing bank, so request it wherever the stakes are meaningful.

| # | Rule | Why |
| --- | --- | --- |
| T1 | `Request 3D Secure if :amount_in_usd: > 50` | Every order above a trivial amount. |
| T2 | `Request 3D Secure if :risk_score: > 50` | Any moderately risky payment. |
| T3 | `Request 3D Secure if :card_country: != :ip_country:` | Every country-mismatch order. |
| T4 | `Request 3D Secure if :card_funding: = 'prepaid'` | Every prepaid card. |

Then add one Block rule so a failed challenge is never charged:

| B19 | `Block if :is_3d_secure: and not :is_3d_secure_authenticated:` | 3DS was attempted and the cardholder failed or abandoned it. |

## 4. Weekly review routine

1. Radar → Reviews: clear the queue. Refund anything you cannot verify. Add the email and card fingerprint of confirmed fraud to the Radar block lists (Radar → Lists).
2. Radar → Rules: open each rule's "matched payments" count. A rule matching zero payments in a month is not hurting; a rule matching more than 5% of volume is probably too tight and deserves a look at the false positives.
3. Disputes and early fraud warnings: for each, ask which rule should have caught it, and tighten that threshold by a small step.
4. Record any change to this file with a new version line at the top.

## 5. When to loosen

Do not loosen anything before 90 days of live data. After that, candidates for loosening in order: R10 (drop countries that produced no fraud), T1 (raise to USD 100 if 3DS abandonment is costing sales), R1 (raise to USD 350 if reviews above 250 are all clean). Never loosen B3, B4, B5, or the velocity blocks without changing the Terms of Service and the compliance statement to match.
