/**
 * Who counts as a bot on /stats. Edit the lists and weights here; the logic
 * that applies them is in track.js and does not need touching.
 *
 * Every page view is scored 0-100 by adding the weight of each rule it trips,
 * capped at 100. A score at or above THRESHOLD is filed as a bot: kept out of
 * the default dashboard, and counted separately so "Show bots" can reveal it.
 * The file name starts with an underscore so Vercel does not publish it as an
 * endpoint of its own.
 */

export const THRESHOLD = 50;

export const WEIGHTS = {
  crawlerAgent: 100,     // the isbot package recognises the user agent
  automationAgent: 100,  // empty, not Mozilla/..., or names a headless/automation tool
  webdriver: 100,        // the browser itself reports it is being driven by a script
  country: 60,           // BLOCKED_COUNTRIES below
  dataCenter: 50,        // connection comes from one of DATA_CENTER_CITIES below
  noScreen: 40,          // screen reported as 0 wide or 0 tall
  timezone: 25,          // no browser timezone, or 3+ hours from the connection's
  bounce: 30,            // gone in under a second without touching the page
  idleSession: 30,       // 5+ pages this visit without a single scroll, click or key
};

// Plain-English names for each rule, as the dashboard shows them.
export const REASONS = {
  crawlerAgent: "Known crawler",
  automationAgent: "Automation tool",
  webdriver: "Scripted browser",
  country: "Country outside the market",
  dataCenter: "Data-center city",
  noScreen: "No screen",
  timezone: "Timezone mismatch",
  bounce: "Left in under a second",
  idleSession: "Many pages, no interaction",
};

// Two-letter country codes. The business buys land in the US only.
export const BLOCKED_COUNTRIES = ["RU", "CN", "KP", "IR"];

// Cities that are mostly hyperscale data centers (AWS, Google, Microsoft,
// Meta), as "City, ST" -- the state matters: Quincy WA is a server farm,
// Quincy MA and Sterling MA are towns in the market. Matched against the city
// and region Vercel reports, ignoring case. On its own this reaches the
// threshold, so a visit from Ashburn is filed as a bot even when it scrolls:
// headless browsers there are built to look human. The cost is that a real
// person living in one of these towns is hidden too -- still visible under
// "Show bots". Remove a line to stop that.
export const DATA_CENTER_CITIES = [
  "Ashburn, VA", "Sterling, VA", "Reston, VA", "Manassas, VA",
  "Council Bluffs, IA",
  "The Dalles, OR", "Boardman, OR", "Prineville, OR", "Umatilla, OR", "Hillsboro, OR",
  "Quincy, WA", "Moses Lake, WA",
];

// User-agent words that mean an automated browser, even one isbot lets by.
export const AUTOMATION_WORDS = ["headless", "phantom", "selenium", "puppeteer", "playwright"];
