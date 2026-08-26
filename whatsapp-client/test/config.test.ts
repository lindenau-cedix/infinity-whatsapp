// Regression tests for group-JID config validation — `node --test` (Node 18+).
//
// These lock down the INFA-20 failure mode: `.env` shipped with placeholder
// JIDs (`120363_a@g.us`), `required()` accepted them because they are
// non-empty, the daemon booted "fine", and then every inbound message from
// three of the four groups was dropped at `findGroupByJid()`. The groups went
// completely silent — not even the missing-credential stub fired, because
// nothing ever reached an adapter.
//
// The contract now: a malformed or duplicated JID fails the boot loudly.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { loadConfig, findGroupByJid, ConfigError } from "../src/config";

/** A complete, valid env so each test can perturb exactly one field. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    WA_GROUP_JID_QWEN: "120363429250797806@g.us",
    WA_GROUP_JID_PERP_RP: "120363414333631034@g.us",
    WA_GROUP_JID_PERP_DR: "120363411597601634@g.us",
    WA_GROUP_JID_FIRECRAWL: "120363412135327491@g.us",
  };
}

const JID_VARS = [
  "WA_GROUP_JID_QWEN",
  "WA_GROUP_JID_PERP_RP",
  "WA_GROUP_JID_PERP_DR",
  "WA_GROUP_JID_FIRECRAWL",
] as const;

test("valid JIDs load and map to the four distinct endpoints", () => {
  const { groups } = loadConfig(validEnv());
  assert.equal(groups.qwenCode.jid, "120363429250797806@g.us");
  assert.equal(groups.perplexityReasoning.jid, "120363414333631034@g.us");
  assert.equal(groups.perplexityDeepResearch.jid, "120363411597601634@g.us");
  assert.equal(groups.firecrawl.jid, "120363412135327491@g.us");

  const jids = Object.values(groups).map((g) => g.jid);
  assert.equal(new Set(jids).size, 4, "all four JIDs must be distinct");
});

test("each configured JID routes back to its own endpoint", () => {
  const { groups } = loadConfig(validEnv());
  assert.equal(findGroupByJid("120363429250797806@g.us", groups)?.endpoint, "qwenCode");
  assert.equal(
    findGroupByJid("120363414333631034@g.us", groups)?.endpoint,
    "perplexityReasoning",
  );
  assert.equal(
    findGroupByJid("120363411597601634@g.us", groups)?.endpoint,
    "perplexityDeepResearch",
  );
  assert.equal(findGroupByJid("120363412135327491@g.us", groups)?.endpoint, "firecrawl");
});

test("an unknown JID is not routed (dispatcher must ignore it)", () => {
  const { groups } = loadConfig(validEnv());
  assert.equal(findGroupByJid("120363999999999999@g.us", groups), undefined);
});

// --- the actual INFA-20 bug -------------------------------------------------

test("the exact placeholder .env from INFA-20 is rejected, not silently accepted", () => {
  const env: NodeJS.ProcessEnv = {
    WA_GROUP_JID_QWEN: "120363_a@g.us",
    WA_GROUP_JID_PERP_RP: "120363_b@g.us",
    WA_GROUP_JID_PERP_DR: "120363_c@g.us",
    WA_GROUP_JID_FIRECRAWL: "120363_d@g.us",
  };
  assert.throws(() => loadConfig(env), ConfigError);
});

test("a placeholder in any single slot fails that specific var by name", () => {
  for (const v of JID_VARS) {
    const env = validEnv();
    env[v] = "120363_a@g.us";
    assert.throws(
      () => loadConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `${v}: expected ConfigError`);
        assert.match(err.message, new RegExp(v), `${v}: error must name the bad var`);
        return true;
      },
      `${v} with a placeholder value must fail the boot`,
    );
  }
});

test("malformed JID shapes are rejected", () => {
  const bad = [
    "120363_a@g.us", // placeholder underscore — the INFA-20 value
    "120363429250797806", // missing @g.us
    "120363429250797806@c.us", // DM, not a group
    "120363429250797806@g.us.evil", // trailing junk
    "abc@g.us", // non-numeric
    "@g.us", // no digits
    "120363 429250797806@g.us", // embedded space
    "https://chat.whatsapp.com/AbCdEf", // invite link pasted verbatim
  ];
  for (const jid of bad) {
    const env = validEnv();
    env.WA_GROUP_JID_PERP_RP = jid;
    assert.throws(() => loadConfig(env), ConfigError, `must reject ${JSON.stringify(jid)}`);
  }
});

test("blank JIDs fail", () => {
  for (const v of JID_VARS) {
    const blank = validEnv();
    blank[v] = "   ";
    assert.throws(() => loadConfig(blank), ConfigError, `${v} blank must throw`);
  }
});

// Note on a var being absent entirely: `loadConfig` calls `ensureDotEnvLoaded`,
// which gap-fills any unset key from the nearest `.env` on disk (process env
// always wins; the file never clobbers). So when this repo's own
// `whatsapp-client/.env` is present and populated, deleting a key from the env
// object passed here does NOT surface as "missing" — it resolves to the real
// on-disk value. That precedence is intentional and documented on
// `ensureDotEnvLoaded`, so we assert it rather than fighting it. A blank
// (whitespace) value, by contrast, is a present-but-empty key that the file
// will not overwrite, which is why the case above is the meaningful guard.
test("an unset key is filled from .env rather than throwing (documented precedence)", () => {
  const env = validEnv();
  delete env.WA_GROUP_JID_QWEN;
  const { groups } = loadConfig(env);
  assert.match(groups.qwenCode.jid, /^\d+@g\.us$/);
});

test("duplicate JIDs are rejected so one group cannot shadow another", () => {
  const env = validEnv();
  env.WA_GROUP_JID_FIRECRAWL = env.WA_GROUP_JID_QWEN;
  assert.throws(
    () => loadConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /WA_GROUP_JID_QWEN/);
      assert.match(err.message, /WA_GROUP_JID_FIRECRAWL/);
      return true;
    },
  );
});

test("surrounding whitespace is tolerated", () => {
  const env = validEnv();
  env.WA_GROUP_JID_QWEN = "  120363429250797806@g.us  ";
  const { groups } = loadConfig(env);
  assert.equal(groups.qwenCode.jid, "120363429250797806@g.us");
});
