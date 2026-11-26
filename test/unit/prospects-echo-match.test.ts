import { describe, expect, it } from "vitest";
import {
  looseProspectText,
  prospectNameWords,
  prospectTextSimilarity,
} from "../../src/prospects";

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

describe("the words of a lead's name that can identify them", () => {
  it("keeps the name and drops titles and words too short to be one", () => {
    expect(prospectNameWords("Dra. Marta Ruiz")).toEqual(["marta", "ruiz"]);
    expect(prospectNameWords("Dr. de la Fuente")).toEqual(["fuente"]);
    expect(prospectNameWords("Doctora Ana")).toEqual(["ana"]);
  });

  it("has nothing usable for a missing or title-only name", () => {
    expect(prospectNameWords(null)).toEqual([]);
    expect(prospectNameWords("")).toEqual([]);
    expect(prospectNameWords("Dr. Dra. de la")).toEqual([]);
  });
});
