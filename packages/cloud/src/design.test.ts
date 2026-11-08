import { describe, expect, it } from "vitest";
import { designFindings, judgeDesign, toHsl, type DesignSample } from "./design";

const clean: DesignSample = {
  ctaColors: ["rgb(37, 99, 235)", "rgb(37, 99, 235)", "rgb(220, 38, 38)"], // brand blue + destructive red
  radii: [8, 8, 16, -1, -1],
  emojiChrome: [],
  gradientCtas: [],
  labels: ["Get started", "Sign in", "Delete"],
  fonts: { inter: 40, "jetbrains mono": 6, "material icons": 9 },
  motion: [],
};
const rules = (s: Partial<DesignSample>) => judgeDesign({ ...clean, ...s }).map((h) => h.rule);

describe("judgeDesign", () => {
  it("a disciplined screen has nothing to say", () => {
    expect(judgeDesign(clean)).toEqual([]);
  });

  it("three accent hues is sprawl; neutrals and near-white never count", () => {
    expect(rules({ ctaColors: [...clean.ctaColors, "rgb(16, 185, 129)"] })).toContain("design/accent-sprawl");
    expect(rules({ ctaColors: [...clean.ctaColors, "rgb(17, 24, 39)", "rgb(249, 250, 251)", "rgb(107, 114, 128)"] })).toEqual([]);
  });

  it("more than four radius steps is sprawl; pills don't count as steps", () => {
    expect(rules({ radii: [4, 6, 8, 12, 16] })).toContain("design/radius-sprawl");
    expect(rules({ radii: [8, 16, -1, -1, -1, -1] })).toEqual([]);
  });

  it("flags emoji in chrome", () => {
    const hit = judgeDesign({ ...clean, emojiChrome: ['button "🚀 Launch"'] })[0]!;
    expect(hit).toMatchObject({ rule: "design/emoji-in-chrome", count: 1 });
  });

  it("flags only the purple/indigo gradient, not every gradient", () => {
    const purple = { label: 'button "Start"', image: "linear-gradient(90deg, rgb(99, 102, 241), rgb(168, 85, 247))" };
    const sunset = { label: 'button "Book"', image: "linear-gradient(90deg, rgb(249, 115, 22), rgb(234, 179, 8))" };
    expect(rules({ gradientCtas: [purple] })).toContain("design/ai-default-gradient");
    expect(rules({ gradientCtas: [sunset] })).toEqual([]);
  });

  it("one intent under two labels is flagged; different intents are not", () => {
    const hit = judgeDesign({ ...clean, labels: ["Get started", "Start now →", "Sign in"] })[0]!;
    expect(hit.rule).toBe("design/duplicate-intent-labels");
    expect(hit.samples[0]).toBe('"get started" vs "start now"');
    expect(rules({ labels: ["Sign in", "Sign up", "Learn more"] })).toEqual([]);
  });

  it("font sprawl ignores icon/code fonts and one-off families", () => {
    expect(rules({ fonts: { inter: 40, "playfair display": 5, lobster: 4 } })).toContain("design/font-sprawl");
    expect(rules({ fonts: { inter: 40, "playfair display": 5, lobster: 1, "font awesome 6 free": 20 } })).toEqual([]);
  });

  it("flags looping motion under reduced motion", () => {
    expect(rules({ motion: ['div[data-testid="hero-blob"]'] })).toEqual(["design/ignores-reduced-motion"]);
  });
});

describe("designFindings", () => {
  it("is advisory by construction — never critical or major", () => {
    const everything: DesignSample = {
      ctaColors: ["rgb(37, 99, 235)", "rgb(220, 38, 38)", "rgb(16, 185, 129)"],
      radii: [2, 4, 6, 8, 12],
      emojiChrome: ["h1"],
      gradientCtas: [{ label: "b", image: "linear-gradient(rgb(99, 102, 241), rgb(139, 92, 246))" }],
      labels: ["Log in", "Sign in"],
      fonts: { a: 5, b: 5, c: 5 },
      motion: ["div"],
    };
    let n = 0;
    const findings = designFindings(judgeDesign(everything), "mobile", () => `f${n++}`);
    expect(findings).toHaveLength(7);
    for (const f of findings) {
      expect(f.category).toBe("design");
      expect(["minor", "info"]).toContain(f.severity);
      expect(f.decision?.nextAction).toBeTruthy();
    }
  });
});

describe("toHsl", () => {
  it("reads computed rgb/rgba", () => {
    expect(toHsl("rgb(255, 0, 0)")).toMatchObject({ h: 0, s: 1 });
    expect(toHsl("rgba(0, 0, 255, 0.8)")?.h).toBe(240);
    expect(toHsl("transparent")).toBeUndefined();
  });
});
