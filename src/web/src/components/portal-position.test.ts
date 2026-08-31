import { describe, expect, test } from "bun:test";
import { rectInPortalSpace } from "./portal-position.ts";

describe("rectInPortalSpace", () => {
  test("keeps coordinates unchanged without zoom or a shifted fixed origin", () => {
    const result = rectInPortalSpace(
      { top: 300, bottom: 340, left: 200, right: 500, width: 300, height: 40 },
      { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 },
    );

    expect(result).toEqual({
      top: 300,
      bottom: 340,
      left: 200,
      right: 500,
      width: 300,
      height: 40,
    });
  });

  test("converts viewport pixels into a zoomed portal coordinate space", () => {
    const result = rectInPortalSpace(
      { top: 600, bottom: 648, left: 240, right: 600, width: 360, height: 48 },
      { top: 0, bottom: 120, left: 0, right: 120, width: 120, height: 120 },
    );

    expect(result).toEqual({
      top: 500,
      bottom: 540,
      left: 200,
      right: 500,
      width: 300,
      height: 40,
    });
  });

  test("compensates when scrolling shifts WebKit's fixed portal origin", () => {
    const result = rectInPortalSpace(
      { top: 600, bottom: 648, left: 240, right: 600, width: 360, height: 48 },
      { top: -360, bottom: -240, left: 0, right: 120, width: 120, height: 120 },
    );

    expect(result.top).toBe(800);
    expect(result.bottom).toBe(840);
    // Rendering the converted top through the measured coordinate space lands
    // back at the trigger: (800 * 1.2) - 360 = 600.
    expect((result.top * 1.2) - 360).toBe(600);
  });
});
