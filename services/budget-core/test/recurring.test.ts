import { expect, test } from "bun:test";
import { merchantKey, normalizeMerchant } from "@lumpy/contracts";
import { category, expense, fixedCost, lumpy } from "../fixtures/factories";
import { recurringCandidates } from "../src/recurring";

const TODAY = "2026-03-15";

const twice = (merchant: string, amounts: [number, number], dates: [string, string], extra = {}) => [
  expense({ merchant, amount_cents: amounts[0], txn_date: dates[0], ...extra }),
  expense({ merchant, amount_cents: amounts[1], txn_date: dates[1], ...extra }),
];

test("an annual charge seen twice is an annual lumpy item", () => {
  const rows = recurringCandidates(
    twice("GEICO *AUTO 8829", [118000, 124000], ["2025-04-02", "2026-04-02"].reverse() as [string, string]),
    { today: TODAY },
  );
  expect(rows).toHaveLength(0); // the 2026 charge is in the future, so only one has happened

  const seen = recurringCandidates(twice("GEICO *AUTO 8829", [118000, 124000], ["2024-04-02", "2025-04-02"]), {
    today: TODAY,
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.frequency_months).toBe(12);
  // The most recent charge, not the average: a premium goes up, not down.
  expect(seen[0]!.amount_cents).toBe(124000);
  expect(seen[0]!.typical_cents).toBe(121000);
  expect(seen[0]!.next_due_date).toBe("2026-04-02");
  expect(seen[0]!.annual_cents).toBe(124000);
});

test("a due date already passed rolls forward, the way a lumpy item's does", () => {
  const [row] = recurringCandidates(twice("TOWN OF PERINTON TAX", [90000, 92000], ["2024-01-10", "2025-01-10"]), {
    today: TODAY,
  });
  // Last seen Jan 2025, so Jan 2026 has been and gone: the next one is Jan 2027.
  expect(row!.next_due_date).toBe("2027-01-10");
});

test("a quarterly charge is snapped to the cycle the app has a word for", () => {
  const rows = recurringCandidates(
    [
      expense({ merchant: "WATER AUTHORITY", amount_cents: 21000, txn_date: "2025-06-05" }),
      expense({ merchant: "WATER AUTHORITY", amount_cents: 22000, txn_date: "2025-09-03" }),
      expense({ merchant: "WATER AUTHORITY", amount_cents: 20500, txn_date: "2025-12-08" }),
    ],
    { today: TODAY },
  );
  expect(rows[0]!.frequency_months).toBe(3);
  expect(rows[0]!.annual_cents).toBe(82000);
  expect(rows[0]!.regular).toBe(true);
});

test("a gap that is a month off is still the same bill", () => {
  const [row] = recurringCandidates(
    [
      expense({ merchant: "AAA MEMBERSHIP", amount_cents: 18600, txn_date: "2025-03-20" }),
      expense({ merchant: "AAA MEMBERSHIP", amount_cents: 18600, txn_date: "2025-09-18" }),
      expense({ merchant: "AAA MEMBERSHIP", amount_cents: 19200, txn_date: "2026-02-19" }),
    ],
    { today: TODAY },
  );
  expect(row!.frequency_months).toBe(6);
  expect(row!.regular).toBe(false);
});

test("two different spacings at one merchant are two things, not one bill", () => {
  const rows = recurringCandidates(
    [
      expense({ merchant: "BIG BOX", amount_cents: 20000, txn_date: "2025-01-05" }),
      expense({ merchant: "BIG BOX", amount_cents: 20000, txn_date: "2025-04-05" }),
      expense({ merchant: "BIG BOX", amount_cents: 20000, txn_date: "2026-02-05" }),
    ],
    { today: TODAY },
  );
  expect(rows).toHaveLength(0);
});

test("amounts that disagree are not one recurring bill", () => {
  const rows = recurringCandidates(twice("SOME SHOP", [20000, 90000], ["2024-05-01", "2025-05-01"]), {
    today: TODAY,
  });
  expect(rows).toHaveLength(0);
});

test("monthly is a fixed cost, not a lumpy item", () => {
  const rows = recurringCandidates(
    ["2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01"].map((txn_date) =>
      expense({ merchant: "NATIONAL GRID", amount_cents: 21000, txn_date }),
    ),
    { today: TODAY },
  );
  expect(rows).toHaveLength(0);
});

test("small charges are noise, not bills to save up for", () => {
  const rows = recurringCandidates(twice("COFFEE PLACE", [400, 420], ["2024-06-01", "2025-06-01"]), {
    today: TODAY,
  });
  expect(rows).toHaveLength(0);
});

test("what is already in the fund is not suggested again", () => {
  const charges = twice("STATE FARM INS", [80000, 82000], ["2024-02-01", "2025-02-01"]);
  expect(recurringCandidates(charges, { today: TODAY })).toHaveLength(1);
  expect(
    recurringCandidates(charges, { today: TODAY, lumpyItems: [lumpy({ name: "State Farm" })] }),
  ).toHaveLength(0);
});

test("a bill whose pattern already claims the charge is not suggested", () => {
  const charges = twice("NATIONAL GRID", [21000, 22000], ["2024-07-01", "2025-07-01"]);
  expect(recurringCandidates(charges, { today: TODAY })).toHaveLength(1);
  expect(
    recurringCandidates(charges, {
      today: TODAY,
      fixedCosts: [fixedCost({ name: "Gas and electric", merchant_pattern: "national grid" })],
    }),
  ).toHaveLength(0);
});

test("a card payment is money moving, not money spent", () => {
  const transfer = category({ name: "Card payment", bucket: "transfer" });
  const charges = twice("CHASE CARD PMT", [80000, 80000], ["2024-08-01", "2025-08-01"]).map((e) => ({
    ...e,
    category_id: transfer.id,
  }));
  expect(recurringCandidates(charges, { today: TODAY, categories: [transfer] })).toHaveLength(0);
});

test("the category the charges already agree on rides along; a split opinion does not", () => {
  const insurance = category({ name: "Insurance", bucket: "lumpy" });
  const other = category({ name: "Other", bucket: "discretionary" });
  const agreed = twice("ERIE INSURANCE", [60000, 62000], ["2024-09-01", "2025-09-01"], {
    category_id: insurance.id,
  });
  expect(recurringCandidates(agreed, { today: TODAY, categories: [insurance] })[0]!.category_id).toBe(insurance.id);

  const split = [
    expense({ merchant: "ERIE INSURANCE", amount_cents: 60000, txn_date: "2024-09-01", category_id: insurance.id }),
    expense({ merchant: "ERIE INSURANCE", amount_cents: 62000, txn_date: "2025-09-01", category_id: other.id }),
  ];
  expect(recurringCandidates(split, { today: TODAY, categories: [insurance, other] })[0]!.category_id).toBeNull();
});

test("future-dated rows have not happened yet", () => {
  const rows = recurringCandidates(
    [
      expense({ merchant: "HOA DUES", amount_cents: 45000, txn_date: "2025-05-01" }),
      expense({ merchant: "HOA DUES", amount_cents: 45000, txn_date: "2026-05-01" }),
    ],
    { today: TODAY },
  );
  expect(rows).toHaveLength(0);
});

test("the lookback window ends the suggestion, so an old one-off stays gone", () => {
  const charges = twice("OLD THING", [50000, 50000], ["2020-01-01", "2021-01-01"]);
  expect(recurringCandidates(charges, { today: TODAY })).toHaveLength(0);
  expect(recurringCandidates(charges, { today: TODAY, lookbackMonths: 120 })).toHaveLength(1);
});

test("suggestions are ordered by what they cost a year", () => {
  const rows = recurringCandidates(
    [
      ...twice("SMALL ANNUAL", [12000, 12000], ["2024-03-01", "2025-03-01"]),
      ...twice("BIG ANNUAL", [150000, 150000], ["2024-03-01", "2025-03-01"]),
      ...twice("MID QUARTERLY", [30000, 30000], ["2025-06-01", "2025-09-01"]),
    ],
    { today: TODAY },
  );
  // $1,500 a year, then $1,200 (four quarters of $300), then $120.
  expect(rows.map((r) => r.key)).toEqual(["BIG ANNUAL", "MID QUARTERLY", "SMALL ANNUAL"]);
  expect(rows.map((r) => r.annual_cents)).toEqual([150000, 120000, 12000]);
});

test("the merchant key survives the noise a statement glues on", () => {
  expect(normalizeMerchant("Café  Nero*  1234")).toBe("CAFE NERO 1234");
  expect(merchantKey("GEICO *AUTO 8829")).toBe("GEICO AUTO");
  expect(merchantKey("GEICO AUTO PAY 9134")).toBe("GEICO AUTO");
  expect(merchantKey("BP")).toBe("BP");
  // Without this, every municipality in the county is one merchant called TOWN OF.
  expect(merchantKey("TOWN OF PERINTON TAX")).toBe("TOWN PERINTON");
  expect(merchantKey("TOWN OF BRIGHTON TAX")).toBe("TOWN BRIGHTON");
  expect(merchantKey("1234 5678")).toBe("");
});

test("one statement's spelling and the next one's are one candidate", () => {
  const [row] = recurringCandidates(
    [
      expense({ merchant: "GEICO *AUTO 8829", amount_cents: 118000, txn_date: "2024-04-02" }),
      expense({ merchant: "GEICO AUTO PAY 9134", amount_cents: 121000, txn_date: "2025-04-02" }),
    ],
    { today: TODAY },
  );
  expect(row!.merchants).toEqual(["GEICO *AUTO 8829", "GEICO AUTO PAY 9134"]);
  // The name offered is the one the most recent statement used.
  expect(row!.name).toBe("GEICO AUTO PAY 9134");
});
