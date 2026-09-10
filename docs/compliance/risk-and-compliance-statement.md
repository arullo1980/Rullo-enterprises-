# Risk and Compliance Statement

**Content Research Group USA Inc.**, a Florida corporation, trading as **Rullo Enterprises** (rulloenterprises.com)
Version 1.0 · September 10, 2026 · Responsible officer: the company's owner and principal

This statement describes the risk controls Content Research Group USA Inc. applies to its Rullo Enterprises storefront. It is provided to payment processors and partners on request. It is reviewed at least annually and whenever the product range, volumes, or regulatory environment changes.

## 1. What the business does and does not do

Rullo Enterprises is an online retail storefront that sells four kinds of digital product to individual consumers: prepaid mobile airtime, mobile data bundles, closed-loop digital gift cards, and utility bill payments, delivered to recipients in more than 190 countries. Every product is fulfilled at the moment of purchase by our distribution partner, Reloadly, which holds the supply agreements with mobile operators, gift card brands, and utility providers.

The business **does not**:

- hold, store, or transmit customer funds, or maintain any customer balance, wallet, or account;
- issue its own stored-value instruments;
- sell open-loop prepaid cards (Visa, Mastercard, or similar), cryptocurrency, or cryptocurrency-redeemable cards;
- sell adult content or gambling products;
- sell to businesses, resellers, or bulk buyers, or offer wholesale pricing;
- ship physical goods;
- see, store, or process payment card data (payments are processed by Stripe inside the checkout).

Because the company sells goods and services at retail and never holds or transmits value on a customer's behalf, it does not act as a money transmitter or money services business. Airtime, data, and bill payments are consumed as services on the recipient's account. Gift cards are closed-loop products redeemable only at the issuing brand and are not redeemable for cash except where state law requires a small residual balance to be cashed out.

## 2. Product and customer risk assessment

| Risk | Assessment | Principal mitigations |
| --- | --- | --- |
| Stolen-card fraud (gift cards) | High for the industry; the primary risk to this business | Stripe Radar, 3D Secure on all gift card orders, order caps, velocity limits, manual review above USD 250 |
| Scam-victim purchases (customer coerced into buying gift cards) | Medium | Scam warning at checkout and in Terms; refusal of orders with scam indicators; support contact before payment |
| Money laundering / structuring | Low: no cash-out path, small ticket sizes, no customer balances | Order caps, velocity limits, monitoring for repeated purchases from one card, email, or device; record keeping |
| Sanctions | Low-to-medium given worldwide delivery | Card-country and IP-country blocking at Stripe; destination controls at Reloadly; no comprehensively sanctioned destinations except where a general license applies |
| Chargebacks / friendly fraud | Medium | Clear descriptor (RULLOENTERPRISES.COM), price and recipient shown before confirmation, refund policy, 24-hour support, delivery evidence retained |
| Failed delivery | Low | Full automatic refund policy; Reloadly credits wholesale cost back on failed fulfilment |

## 3. Fraud prevention controls

1. **Stripe Radar** screens every payment. Rules block or hold for review: billing country different from card-issuing country; IP country different from card country on gift card orders; more than two cards used from one device or email in 24 hours; repeated declined attempts; and any Radar risk score above the threshold we set (initially 65, tightened as data accumulates).
2. **3D Secure** is requested on every gift card purchase and on any order Radar flags, shifting liability for unauthorised card use to the issuing bank.
3. **Order caps.** A single order is limited to USD 500 for gift cards and USD 250 for airtime, data, and bill payments. Lower brand or operator limits apply automatically. Caps are reviewed after 90 days of live data and changed only in consultation with our payment processor.
4. **Velocity limits.** No more than three orders, and no more than USD 750 in aggregate, from the same card, email address, or device in any 24-hour period.
5. **Manual review** by the owner of every order above USD 250 and every order flagged by Radar, before fulfilment. Orders that cannot be verified are cancelled and refunded.
6. **Customer identification per order.** Every order captures a customer email address (where receipts and gift card codes are delivered), the recipient phone number, email, or account reference, the card fingerprint, IP address, and device data, all retained in the Stripe and Reloadly records.
7. **Scam-victim protection.** A prominent warning at checkout and in the Terms of Service tells customers that no agency, bank, or company asks to be paid in gift cards or phone credit. Orders showing scam indicators (an older customer buying multiple high-value gaming or retail cards in one session, a support enquiry describing a third party's instructions) are held and the customer is contacted before fulfilment.
8. **Early-warning feedback loop.** Stripe early fraud warnings and disputes are reviewed weekly and used to adjust Radar rules, caps, and blocked destinations.

## 4. Anti-money-laundering statement

Although the company is not a money services business, it applies proportionate anti-money-laundering controls:

- **No cash-out path.** No product sold can be converted to cash, which removes the principal laundering use of stored value.
- **Ticket and velocity limits** (section 3) make structuring impractical and visible.
- **Monitoring.** The owner reviews transaction reports weekly for repeated purchases to the same recipient from different cards, purchases of the same gift card brand in round amounts across many orders, and any pattern inconsistent with personal use.
- **Refusal and reporting.** Orders that appear to be for resale, commercial distribution, or unlawful purposes are cancelled and refunded, and the customer is blocked. Activity that appears to involve the proceeds of crime is reported to our payment processor and, where appropriate, to law enforcement.
- **Record keeping.** Order, payment, and delivery records are retained for five years in the Stripe and Reloadly dashboards.
- **Training.** The owner, who handles all orders and support, has professional experience in banking and foreign exchange and maintains awareness of current fraud and laundering typologies affecting gift card retail.

## 5. Sanctions policy

- We do not sell to any person or entity on the US Treasury OFAC Specially Designated Nationals list or any other US sanctions list, and we do not deliver to destinations subject to comprehensive US sanctions (currently Iran, North Korea, Syria, and the Crimea, Donetsk, and Luhansk regions), except where a specific OFAC general license permits the transaction, such as telecommunications services to Cuba under 31 CFR §515.542.
- **Enforcement points.** Stripe blocks cards and IP addresses from sanctioned countries at checkout. Reloadly, as a licensed distributor, controls which destinations, operators, and brands are available in the catalog and does not offer products for sanctioned destinations. We do not enable any destination in our catalog that Reloadly does not support.
- **Screening.** Where an order is held for manual review, the customer and recipient details are checked against the OFAC SDN list before fulfilment.

## 6. Content and prohibited-product policy

We sell only products available through Reloadly's licensed catalog. Within that catalog we exclude, and will not enable, any product in the following categories: adult content, gambling and betting, cryptocurrency or cryptocurrency-redeemable cards, open-loop prepaid cards, weapons, and any product whose issuing brand prohibits third-party resale. Product categories are reviewed before any new brand or operator is enabled.

## 7. Consumer protection and disclosures

The storefront provides, before payment and in plain language:

- the full price including any service fee, and the recipient details, on the confirmation step inside the checkout;
- a link to the Terms of Service and the Refund & Delivery Policy, and an acceptance checkbox at checkout;
- the order caps and the statement that delivered digital products cannot be refunded;
- the scam warning described in section 3;
- gift card disclosures: cards are subject to the issuing brand's terms, are closed-loop, and are not redeemable for cash;
- the support email address (info@rulloenterprises.com) and a 24-hour response commitment, in the footer of every page and in the policies;
- a privacy policy explaining what data is collected and by whom.

The statement descriptor on customer card statements is RULLOENTERPRISES.COM, matching the storefront domain.

## 8. Customer service, refunds, and disputes

All customer service, refunds, and disputes are handled by Content Research Group USA Inc., not by Reloadly. The owner personally answers every request within 24 hours. Refunds are issued from the Stripe balance to the original payment method. Failed deliveries are refunded in full regardless of whether Reloadly has yet credited the wholesale cost back to us. Disputes are answered through the Stripe dashboard with order, recipient, and delivery evidence from the Reloadly order record.

## 9. Data security

The storefront is a static website with no backend, database, or customer accounts. Card data is entered only into Stripe's fields inside the checkout and never touches our systems. Access to the Stripe and Reloadly dashboards is limited to the owner and protected by two-factor authentication. Any API credentials used for catalog lookups are stored as encrypted secrets in Cloudflare and are never present in the website or the code repository.

## 10. Review

This statement, the Radar rules, the order caps, and the blocked-destination list are reviewed by the owner at least every twelve months, after any significant change in products or volumes, and after any dispute or fraud event that suggests a gap.
