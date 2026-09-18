import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasswordInput } from "../client/src/components/ui/password-input";

describe("PasswordInput test IDs and native input props", () => {
  it("preserves the input test ID and derives the toggle test ID", () => {
    const html = renderToStaticMarkup(createElement(PasswordInput, {
      "data-testid": "agent-password",
      name: "password",
      autoComplete: "current-password",
      required: true,
    }));

    expect(html).toContain('data-testid="agent-password"');
    expect(html).toContain('data-testid="agent-password-toggle"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('required=""');
    expect(html).toContain('type="button"');
  });

  it("keeps the default toggle ID when no input test ID is supplied", () => {
    const html = renderToStaticMarkup(createElement(PasswordInput));
    expect(html).toContain('data-testid="button-toggle-password"');
    expect(html).not.toContain("undefined-toggle");
  });
});