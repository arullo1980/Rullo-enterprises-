/**
 * Fixture data for RELOADLY_ENV = "mock".
 *
 * Reloadly credentials have not been issued yet, so mock mode lets the
 * storefront be wired and tested end-to-end today with no account at all.
 * The shapes here match exactly what the live handlers return, so switching
 * to "sandbox" or "live" changes nothing on the front end.
 *
 * This is NOT sample data for display — it is a stand-in for an API we
 * cannot call yet. Never ship the Worker to production in mock mode.
 */

var OPERATORS = {
  NG: [
    { id: 341, name: "MTN Nigeria", bundle: false, data: false, type: "RANGE" },
    { id: 342, name: "Airtel Nigeria", bundle: false, data: false, type: "RANGE" },
    { id: 535, name: "9mobile Nigeria", bundle: false, data: false, type: "RANGE" },
    { id: 683, name: "Glo Nigeria Data", bundle: true, data: true, type: "FIXED" },
  ],
  MX: [
    { id: 158, name: "Telcel Mexico", bundle: false, data: false, type: "FIXED" },
    { id: 160, name: "Movistar Mexico", bundle: false, data: false, type: "FIXED" },
    { id: 720, name: "AT&T Mexico", bundle: false, data: false, type: "FIXED" },
  ],
  IN: [
    { id: 283, name: "Airtel India", bundle: false, data: false, type: "FIXED" },
    { id: 285, name: "Jio India", bundle: true, data: true, type: "FIXED" },
    { id: 287, name: "Vi India", bundle: false, data: false, type: "FIXED" },
  ],
};

var GIFTCARDS = {
  NG: [
    { id: 21, name: "Amazon Nigeria", brand: "Amazon", currency: "NGN" },
    { id: 88, name: "Jumia Nigeria", brand: "Jumia", currency: "NGN" },
  ],
  MX: [
    { id: 12, name: "Amazon Mexico", brand: "Amazon", currency: "MXN" },
    { id: 45, name: "Netflix Mexico", brand: "Netflix", currency: "MXN" },
    { id: 91, name: "Spotify Mexico", brand: "Spotify", currency: "MXN" },
  ],
  IN: [{ id: 33, name: "Amazon India", brand: "Amazon", currency: "INR" }],
};

var UTILITIES = {
  NG: [
    { id: 1, name: "Ikeja Electric", type: "ELECTRICITY_BILL_PAYMENT", serviceType: "PREPAID" },
    { id: 2, name: "Eko Electricity", type: "ELECTRICITY_BILL_PAYMENT", serviceType: "POSTPAID" },
    { id: 9, name: "DSTV Nigeria", type: "TV_BILL_PAYMENT", serviceType: "POSTPAID" },
  ],
  MX: [{ id: 40, name: "CFE Mexico", type: "ELECTRICITY_BILL_PAYMENT", serviceType: "POSTPAID" }],
  IN: [],
};

var COUNTRIES = [
  { iso: "NG", name: "Nigeria", currency: "NGN" },
  { iso: "MX", name: "Mexico", currency: "MXN" },
  { iso: "IN", name: "India", currency: "INR" },
];

export function isMock(env) {
  return (env.RELOADLY_ENV || "").toLowerCase() === "mock";
}

/**
 * Countries not in the fixtures still resolve, with empty lists — the real API
 * behaves the same way for a country with no coverage, and the UI must handle
 * it either way.
 */
export function mockData(product, iso) {
  if (product === "countries") return COUNTRIES;
  var table = product === "giftcards" ? GIFTCARDS : product === "utilities" ? UTILITIES : OPERATORS;
  return table[iso] || [];
}
