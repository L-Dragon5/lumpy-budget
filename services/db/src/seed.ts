#!/usr/bin/env bun
import { insert, rows, sql } from "./client";

/**
 * Categories and merchant rules good enough to make the first import useful.
 * Idempotent: re-running only fills in what is missing. Colors stay null so the
 * chart palette owns them until the user picks one.
 */
type Bucket = "discretionary" | "fixed" | "lumpy" | "savings" | "transfer";
const CATEGORIES: [name: string, bucket: Bucket, icon: string][] = [
  ["Groceries", "discretionary", "cart"],
  ["Dining", "discretionary", "utensils"],
  ["Gas & Fuel", "discretionary", "fuel"],
  ["Shopping", "discretionary", "bag"],
  ["Entertainment", "discretionary", "film"],
  ["Health", "discretionary", "health"],
  ["Travel", "discretionary", "plane"],
  ["Home", "discretionary", "home"],
  ["Pets", "discretionary", "dog"],
  ["Kids", "discretionary", "baby"],
  ["Personal Care", "discretionary", "scissors"],
  ["Gifts & Donations", "discretionary", "gift"],
  ["Misc", "discretionary", "tag"],
  ["Housing", "fixed", "building"],
  ["Utilities", "fixed", "zap"],
  ["Internet & Phone", "fixed", "wifi"],
  ["Auto Loan", "fixed", "car"],
  ["Childcare", "fixed", "baby"],
  ["Subscriptions", "lumpy", "repeat"],
  ["Insurance", "lumpy", "shield"],
  ["Taxes & Fees", "lumpy", "landmark"],
  ["Savings Transfer", "savings", "piggy-bank"],
  ["Credit Card Payment", "transfer", "credit-card"],
  ["Income", "transfer", "banknote"],
];

/**
 * Rules that must not match a longer name that starts with them: BP #4021 yes,
 * BPOST no. These two used to carry a trailing space reaching for the same
 * thing, which the matcher trimmed off before it ever looked.
 */
const WHOLE_WORD = new Set(["bp", "amc"]);

const RULES: [pattern: string, category: string, priority?: number][] = [
  ["wegmans", "Groceries"], ["trader joe", "Groceries"], ["whole foods", "Groceries"],
  ["safeway", "Groceries"], ["kroger", "Groceries"], ["aldi", "Groceries"],
  ["costco", "Groceries"], ["publix", "Groceries"], ["grocery", "Groceries", 200],
  ["starbucks", "Dining"], ["chipotle", "Dining"], ["doordash", "Dining"],
  ["uber eats", "Dining"], ["grubhub", "Dining"], ["restaurant", "Dining", 200],
  ["pizza", "Dining"], ["coffee", "Dining", 200],
  ["shell", "Gas & Fuel"], ["exxon", "Gas & Fuel"], ["chevron", "Gas & Fuel"],
  ["bp", "Gas & Fuel"], ["wawa", "Gas & Fuel"], ["speedway", "Gas & Fuel"],
  ["amazon", "Shopping"], ["target", "Shopping"], ["walmart", "Shopping"],
  ["ebay", "Shopping"], ["etsy", "Shopping"], ["best buy", "Shopping"],
  ["netflix", "Subscriptions"], ["spotify", "Subscriptions"], ["hulu", "Subscriptions"],
  ["disney", "Subscriptions"], ["youtube premium", "Subscriptions"], ["patreon", "Subscriptions"],
  ["adobe", "Subscriptions"], ["github", "Subscriptions"], ["namecheap", "Subscriptions"],
  ["godaddy", "Subscriptions"], ["cloudflare", "Subscriptions"], ["openai", "Subscriptions"],
  ["anthropic", "Subscriptions"], ["icloud", "Subscriptions"], ["dropbox", "Subscriptions"],
  ["uber", "Travel", 150], ["lyft", "Travel"], ["airbnb", "Travel"],
  ["delta air", "Travel"], ["united air", "Travel"], ["marriott", "Travel"], ["hilton", "Travel"],
  ["cvs", "Health"], ["walgreens", "Health"], ["pharmacy", "Health", 200], ["dental", "Health"],
  ["petco", "Pets"], ["petsmart", "Pets"], ["chewy", "Pets"], ["vet", "Pets", 250],
  ["amc", "Entertainment"], ["steam games", "Entertainment"], ["ticketmaster", "Entertainment"],
  ["home depot", "Home"], ["lowes", "Home"], ["ikea", "Home"], ["ace hardware", "Home"],
  ["geico", "Insurance"], ["progressive", "Insurance"], ["state farm", "Insurance"],
  ["allstate", "Insurance"], ["insurance", "Insurance", 250],
  ["dmv", "Taxes & Fees"], ["registration", "Taxes & Fees", 250], ["hoa", "Taxes & Fees"],
  ["mortgage", "Housing"], ["rent", "Housing", 250], ["property mgmt", "Housing"],
  ["electric", "Utilities"], ["gas company", "Utilities"], ["water", "Utilities", 250],
  ["national grid", "Utilities"], ["pse&g", "Utilities"], ["sewer", "Utilities"],
  ["comcast", "Internet & Phone"], ["xfinity", "Internet & Phone"], ["verizon", "Internet & Phone"],
  ["at&t", "Internet & Phone"], ["t-mobile", "Internet & Phone"], ["spectrum", "Internet & Phone"],
  ["payment thank you", "Credit Card Payment", 10], ["autopay", "Credit Card Payment", 10],
  ["online transfer to sav", "Savings Transfer", 10],
  ["payroll", "Income", 10], ["direct dep", "Income", 10],
];

export async function seed() {
  const existing = new Map(
    (await rows<{ id: number; name: string }>("categories")).map((c) => [c.name.toLowerCase(), c.id]),
  );
  let addedCategories = 0;
  for (const [name, bucket, icon] of CATEGORIES) {
    if (existing.has(name.toLowerCase())) continue;
    existing.set(name.toLowerCase(), await insert("categories", { name, bucket, icon, color: null }));
    addedCategories++;
  }

  const haveRules = new Set(
    (await rows<{ pattern: string }>("category_rules")).map((r) => r.pattern.toLowerCase()),
  );
  let addedRules = 0;
  for (const [pattern, category, priority] of RULES) {
    const categoryId = existing.get(category.toLowerCase());
    if (!categoryId || haveRules.has(pattern.toLowerCase())) continue;
    await insert("category_rules", {
      pattern, category_id: categoryId, priority: priority ?? 100, whole_word: WHOLE_WORD.has(pattern),
    });
    addedRules++;
  }
  return { addedCategories, addedRules };
}

if (import.meta.main) {
  const r = await seed();
  console.log(`seeded: +${r.addedCategories} categories, +${r.addedRules} rules`);
  await sql.end();
}
