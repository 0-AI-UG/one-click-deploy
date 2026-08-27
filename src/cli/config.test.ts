import { afterEach, describe, expect, test } from "bun:test";
import { requireConfig } from "./config.ts";

const priorUrl = process.env.OCD_PANEL_URL;
const priorToken = process.env.OCD_TOKEN;

afterEach(() => {
  if (priorUrl === undefined) delete process.env.OCD_PANEL_URL;
  else process.env.OCD_PANEL_URL = priorUrl;
  if (priorToken === undefined) delete process.env.OCD_TOKEN;
  else process.env.OCD_TOKEN = priorToken;
});

describe("non-interactive CI configuration", () => {
  test("uses OCD_PANEL_URL and OCD_TOKEN without writing a config file", () => {
    process.env.OCD_PANEL_URL = "https://panel.example.com/";
    process.env.OCD_TOKEN = "ci-secret-token";
    expect(requireConfig()).toEqual({
      panel_url: "https://panel.example.com",
      token: "ci-secret-token",
    });
  });
});
