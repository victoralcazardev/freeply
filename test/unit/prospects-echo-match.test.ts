import { describe, expect, it } from "vitest";
import { looseProspectText, prospectTextSimilarity } from "../../src/prospects";

describe("the loose form an M1 echo is compared in", () => {
  it("lowercases, drops punctuation and emoji, and collapses whitespace", () => {
    expect(looseProspectText("  ¡HOLA,\n  Víctor! ¿Qué tal? 🙂🙂  ")).toBe(
      "hola víctor qué tal",
    );
  });

  it("keeps letters and digits", () => {
    expect(looseProspectText("M1: 3 ideas — ¿te encajan?")).toBe("m1 3 ideas te encajan");
  });
});

describe("the similarity between an echo and a copied M1", () => {
  it("divides the word-level distance by the longer word count", () => {
    expect(
      prospectTextSimilarity("Hola soy Víctor de Madrid", "Hola soy Víctor de Barcelona"),
    ).toBe(0.8);
    expect(
      prospectTextSimilarity("Hola soy Víctor Madrid", "Hola soy Víctor Barcelona"),
    ).toBe(0.75);
  });

  it("compares in the loose form", () => {
    expect(prospectTextSimilarity("¡HOLA! Soy Víctor.", "hola soy víctor 🙂")).toBe(1);
  });
});
