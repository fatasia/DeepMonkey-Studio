import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_POST_ACCEPTANCE_CARD_IDS, validateProjectPostAcceptanceCards } from "./projectPostAcceptanceEvidence.mjs";

const cards = () => PROJECT_POST_ACCEPTANCE_CARD_IDS.map((id) => ({ id, status: "partial", reason: "independent project gate remains open" }));
test("requires the complete V01–V05 card set", () => {
  assert.equal(validateProjectPostAcceptanceCards(cards()).valid, true);
  assert.equal(validateProjectPostAcceptanceCards(cards().slice(0, 4)).valid, false);
  const duplicate = cards(); duplicate[1].id = "V01"; assert.equal(validateProjectPostAcceptanceCards(duplicate).valid, false);
});
test("a passed card requires independent evidence", () => {
  const value = cards(); value[0] = { id: "V01", status: "passed", reason: "paired evidence" };
  assert.equal(validateProjectPostAcceptanceCards(value).valid, false);
  value[0].independentEvidence = true;
  assert.equal(validateProjectPostAcceptanceCards(value).valid, true);
});
