// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { parseStatsRows, statsLayout } from "../../../src/commands/create/statsTable";

describe("parseStatsRows", () => {
    test("splits content and quantity on the last separator", () => {
        expect(parseStatsRows("Lam sóng 400x2000 | 76 tấm (mua 79)")).toEqual([
            { content: "Lam sóng 400x2000", quantity: "76 tấm (mua 79)" },
        ]);
    });

    test("keeps a line without a separator as content only", () => {
        expect(parseStatsRows("Tổng tấm")).toEqual([{ content: "Tổng tấm", quantity: "" }]);
    });

    test("drops blank lines and trims cells", () => {
        expect(parseStatsRows("  A | 1  \n\n  B | 2 \n")).toEqual([
            { content: "A", quantity: "1" },
            { content: "B", quantity: "2" },
        ]);
    });
});

describe("statsLayout", () => {
    test("stacks title, header and one row per entry", () => {
        const layout = statsLayout(100, [{ content: "A", quantity: "1" }], false);
        expect(layout.rowHeight).toBe(160);
        expect(layout.titleHeight).toBe(190);
        expect(layout.height).toBe(190 + 160 * 2);
    });

    test("adds a footer row only when a note is present", () => {
        const rows = [{ content: "A", quantity: "1" }];
        expect(statsLayout(100, rows, true).height).toBe(statsLayout(100, rows, false).height + 160);
    });

    test("columns are contiguous and cover the full width", () => {
        const layout = statsLayout(100, [{ content: "Lam sóng 400x2000", quantity: "76 tấm" }], false);
        expect(layout.colX[0]).toBe(0);
        expect(layout.colX[1]).toBe(layout.colW[0]);
        expect(layout.colX[2]).toBe(layout.colW[0] + layout.colW[1]);
        expect(layout.width).toBe(layout.colW[0] + layout.colW[1] + layout.colW[2]);
    });

    test("a very long cell is clamped instead of stretching the table", () => {
        const layout = statsLayout(100, [{ content: "x".repeat(200), quantity: "1" }], false);
        expect(layout.colW[1]).toBe(32 * 62 + 2 * 60);
    });
});
