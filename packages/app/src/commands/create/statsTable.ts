// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    cacheOfOutline,
    codePointsOf,
    command,
    FolderNode,
    FontCatalog,
    type FontOutline,
    GeometryUtils,
    I18n,
    type IFace,
    type IStep,
    LENGTH_UNITS,
    Logger,
    Material,
    MultistepCommand,
    outlineOfPicked,
    type ParameterValue,
    type PickedFont,
    Plane,
    type PointSnapData,
    PointStep,
    Precision,
    PubSub,
    pickTextFont,
    property,
    Result,
    type ShapeNode,
    ShapeTypes,
    type SnapResult,
    Transaction,
    type XYZ,
} from "@chili3d/core";
import { BoxNode, TextNode } from "../../bodys";

export interface StatsRow {
    content: string;
    quantity: string;
}

/**
 * One row per line, "Nội dung | Số lượng". A line without the separator is a
 * content with no quantity, so a half-typed table still draws.
 */
export function parseStatsRows(text: string): StatsRow[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            const at = line.lastIndexOf("|");
            if (at < 0) return { content: line, quantity: "" };
            return { content: line.slice(0, at).trim(), quantity: line.slice(at + 1).trim() };
        });
}

export interface StatsLayout {
    width: number;
    height: number;
    titleHeight: number;
    rowHeight: number;
    padding: number;
    /** Left edge of each column: STT, Nội dung, Số lượng. */
    colX: [number, number, number];
    colW: [number, number, number];
}

/** Column widths follow the longest cell, clamped so one long line cannot stretch the table. */
export function statsLayout(size: number, rows: StatsRow[], hasNote: boolean): StatsLayout {
    const charW = size * 0.62;
    const padding = size * 0.6;
    const clampChars = (chars: number, min: number, max: number) => Math.min(max, Math.max(min, chars));
    const contentChars = clampChars(Math.max(8, ...rows.map((r) => r.content.length)), 8, 32);
    const quantityChars = clampChars(Math.max(6, ...rows.map((r) => r.quantity.length)), 6, 26);
    const colW: [number, number, number] = [
        3 * charW + 2 * padding,
        contentChars * charW + 2 * padding,
        quantityChars * charW + 2 * padding,
    ];
    const colX: [number, number, number] = [0, colW[0], colW[0] + colW[1]];
    const rowHeight = size * 1.6;
    const titleHeight = size * 1.9;
    const noteHeight = hasNote ? rowHeight : 0;
    return {
        width: colW[0] + colW[1] + colW[2],
        height: titleHeight + rowHeight * (rows.length + 1) + noteHeight,
        titleHeight,
        rowHeight,
        padding,
        colX,
        colW,
    };
}

const DEFAULT_ROWS = [
    "Lam sóng 400x2000 | 76 tấm (mua 79)",
    "Nano 400x2700 | 76 tấm (mua 79)",
    "Tổng tấm | 152 (mua 158)",
    "Nẹp nối ngang | 30m (10 thanh)",
    "Nẹp góc | 18,8m (7 thanh)",
    "Nẹp chân | 30m (10 thanh)",
    "Nẹp trần | 30m (10 thanh)",
].join("\n");

/** Roboto covers Vietnamese; the app default (Noto Sans SC) is a 17 MB download. */
const STATS_FONT: PickedFont = { name: FontCatalog[0].family, url: FontCatalog[0].url };

/**
 * A statistics table as one folder of solids: a white board, a title bar, a
 * header row, grid lines and one text solid per cell, in three columns
 * (STT | Nội dung | Số lượng). Two points place it, as they place text: the
 * first is the board's bottom-left corner, the second says which way the
 * table runs. Every piece stays a normal node, so a cell can be retyped and
 * the whole table moved by its folder.
 */
@command({
    key: "create.statsTable",
    icon: "icon-text",
})
export class StatsTableCommand extends MultistepCommand {
    private font?: FontOutline;
    private fontUrl = STATS_FONT.url ?? "";

    @property("font.select", { type: "font" })
    get fontName(): string {
        return this.getPrivateValue("fontName", STATS_FONT.name);
    }
    set fontName(value: string) {
        this.setProperty("fontName", value);
    }

    @property("stats.title")
    get title(): string {
        return this.getPrivateValue("title", "THỐNG KÊ VẬT TƯ");
    }
    set title(value: string) {
        this.setProperty("title", value);
    }

    @property("stats.rows")
    get rows(): string {
        return this.getPrivateValue("rows", DEFAULT_ROWS);
    }
    set rows(value: string) {
        this.setProperty("rows", value);
    }

    @property("stats.note")
    get note(): string {
        return this.getPrivateValue("note", "");
    }
    set note(value: string) {
        this.setProperty("note", value);
    }

    @property("text.size", { unit: LENGTH_UNITS })
    get size(): ParameterValue {
        return this.getPrivateValue("size", 300);
    }
    set size(value: ParameterValue) {
        this.setProperty("size", value);
    }

    async chooseFont(): Promise<Result<void>> {
        const picked = await pickTextFont();
        if (!picked.isOk) return Result.err(picked.error);
        return this.loadFont(picked.value);
    }

    protected override async canExcute(): Promise<boolean> {
        if (this.font !== undefined) return true;
        return (await this.loadFont(STATS_FONT)).isOk;
    }

    private async loadFont(picked: PickedFont): Promise<Result<void>> {
        const outline = await outlineOfPicked(picked);
        if (!outline.isOk) {
            Logger.warn(outline.error);
            PubSub.default.pub("showToast", "toast.text.fontFailed");
            return Result.err(outline.error);
        }
        this.font = outline.value;
        this.fontUrl = picked.url ?? "";
        this.fontName = picked.name;
        return Result.ok(undefined);
    }

    protected override getSteps(): IStep[] {
        return [
            new PointStep("prompt.pickFistPoint"),
            new PointStep("prompt.text.direction", this.directionData),
        ];
    }

    private readonly directionData = (): PointSnapData => ({
        refPoint: () => this.stepDatas[0].point!,
        plane: () => this.basePlane(),
        validator: (point: XYZ) => this.stepDatas[0].point!.distanceTo(point) > Precision.Distance,
        preview: (point: XYZ | undefined) =>
            point === undefined
                ? [this.meshPoint(this.stepDatas[0].point!)]
                : [this.meshPoint(this.stepDatas[0].point!), this.meshLine(this.stepDatas[0].point!, point)],
    });

    protected override executeMainTask(): void {
        const font = this.font;
        if (font === undefined) return;
        const size = this.resolveParameter(this.size, LENGTH_UNITS);
        if (!size.isOk) {
            Logger.warn(size.error);
            return;
        }

        Transaction.execute(this.document, "Stats table", () => {
            const folder = new FolderNode({ document: this.document, name: this.title || "Stats table" });
            this.document.modelManager.addNode(folder);
            folder.add(...this.buildTable(font, size.value));
            this.document.visual.update();
        });
    }

    private buildTable(font: FontOutline, size: number): ShapeNode[] {
        const rows = parseStatsRows(this.rows);
        const note = this.note.trim();
        const layout = statsLayout(size, rows, note.length > 0);
        const plane = this.tablePlane();
        const { xvec, yvec, normal } = plane;
        const at = (x: number, y: number, z: number) =>
            plane.origin.add(xvec.multiply(x)).add(yvec.multiply(y)).add(normal.multiply(z));
        const planeAt = (x: number, y: number, z: number) => new Plane({ origin: at(x, y, z), normal, xvec });

        const thickness = Math.max(20, size * 0.08);
        const textDepth = Math.max(10, size * 0.06);
        const gridDepth = textDepth * 0.5;
        const line = Math.max(4, size * 0.02);
        const nodes: ShapeNode[] = [];
        const box = (
            x: number,
            y: number,
            dx: number,
            dy: number,
            dz: number,
            material: Material,
        ): BoxNode => {
            const node = new BoxNode({
                document: this.document,
                plane: planeAt(x, y, -thickness),
                dx,
                dy,
                dz,
            });
            node.materialId = material.id;
            nodes.push(node);
            return node;
        };
        const text = (value: string, x: number, y: number, material: Material): void => {
            if (value.length === 0) return;
            const node = new TextNode({
                document: this.document,
                plane: planeAt(x, y, 0),
                text: value,
                size,
                depth: textDepth,
                fontName: this.fontName,
                fontUrl: this.fontUrl,
                outlines: JSON.stringify(cacheOfOutline(font, codePointsOf(value))),
            });
            node.materialId = material.id;
            nodes.push(node);
        };

        const boardMat = this.material("Stats Board", 0xffffff);
        const titleMat = this.material("Stats Title", 0xc80000);
        const headerMat = this.material("Stats Header", 0xd9e2f3);
        const bandMat = this.material("Stats Band", 0xf2f2f2);
        const gridMat = this.material("Stats Grid", 0x969696);
        const textMat = this.material("Stats Text", 0x111111);
        const titleTextMat = this.material("Stats Title Text", 0xffffff);

        const { width, height, titleHeight, rowHeight, padding, colX } = layout;
        box(0, 0, width, height, thickness, boardMat);

        const headerY = height - titleHeight - rowHeight;
        box(0, height - titleHeight, width, titleHeight, thickness + gridDepth, titleMat);
        box(0, headerY, width, rowHeight, thickness + gridDepth * 0.5, headerMat);
        rows.forEach((_, i) => {
            if (i % 2 === 1) {
                box(0, headerY - rowHeight * (i + 1), width, rowHeight, thickness + gridDepth * 0.4, bandMat);
            }
        });

        for (let i = 0; i <= rows.length + 1; i++) {
            box(0, headerY - rowHeight * i - line / 2, width, line, thickness + gridDepth, gridMat);
        }
        box(0, height - titleHeight - line / 2, width, line, thickness + gridDepth, gridMat);
        for (const x of [colX[1], colX[2]]) {
            box(x - line / 2, 0, line, height - titleHeight, thickness + gridDepth, gridMat);
        }

        const cellY = (cellBottom: number) => cellBottom + (rowHeight - size) / 2;
        text(this.title, padding, height - titleHeight + (titleHeight - size) / 2, titleTextMat);
        text(I18n.translate("stats.header.stt"), colX[0] + padding, cellY(headerY), textMat);
        text(I18n.translate("stats.header.content"), colX[1] + padding, cellY(headerY), textMat);
        text(I18n.translate("stats.header.quantity"), colX[2] + padding, cellY(headerY), textMat);
        rows.forEach((row, i) => {
            const y = cellY(headerY - rowHeight * (i + 1));
            text(String(i + 1), colX[0] + padding, y, textMat);
            text(row.content, colX[1] + padding, y, textMat);
            text(row.quantity, colX[2] + padding, y, textMat);
        });
        if (note.length > 0) {
            text(note, padding, cellY(0), textMat);
        }
        return nodes;
    }

    private material(name: string, color: number): Material {
        const found = this.document.modelManager.materials.find((m) => m.name === name);
        if (found !== undefined) return found;
        const material = new Material({ document: this.document, name, color });
        this.document.modelManager.materials.push(material);
        return material;
    }

    /** The board's plane: the flat face the first point snapped to, turned toward the second. */
    private tablePlane(): Plane {
        const base = this.basePlane();
        const towards = this.stepDatas[1]?.point;
        if (towards === undefined) return base;
        const along = towards.sub(base.origin);
        const inPlane = along.sub(base.normal.multiply(along.dot(base.normal)));
        return inPlane.length() < Precision.Distance
            ? base
            : new Plane({ origin: base.origin, normal: base.normal, xvec: inPlane });
    }

    private basePlane(): Plane {
        const { point, shapes, view } = this.stepDatas[0];
        const flat = this.snappedFace(shapes);
        return (flat ?? view.workplane).translateTo(point!);
    }

    private snappedFace(shapes: SnapResult["shapes"]): Plane | undefined {
        const shape = shapes.find((x) => x.shape.shapeType === ShapeTypes.face);
        if (shape === undefined) return undefined;
        const face = shape.shape.transformedMul(shape.transform) as IFace;
        return face.surface().isPlanar() ? GeometryUtils.planeFromFace(face) : undefined;
    }
}
