// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IApplication,
    type ICommand,
    type IDocument,
    type Material,
    PubSub,
    type Ribbon,
} from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "./editor.module.css";
import { ProjectView } from "./project";
import { PropertyView } from "./property";
import { MaterialDataContent, MaterialEditor } from "./property/material";
import { showVariablesPanel } from "./property/variables";
import { RibbonUI } from "./ribbon";
import { CommandContext } from "./ribbon/commandContext";
import { Statusbar } from "./statusbar";
import { LayoutViewport } from "./viewport";

export class Editor extends HTMLElement {
    private readonly _viewportContainer: HTMLDivElement;
    private readonly _commandContextContainer = div({});
    private _contentEl: HTMLDivElement | null = null;
    private commandContext?: CommandContext;
    private _sidebarWidth: number = 360;
    private _isResizingSidebar: boolean = false;
    private _sidebarEl: HTMLDivElement | null = null;
    private _projectView?: ProjectView;
    private _propertyView?: PropertyView;
    private _sidebarSplit: number = 0.5;

    constructor(
        readonly app: IApplication,
        readonly ribbonContent: Ribbon,
    ) {
        super();
        const viewport = new LayoutViewport(app);
        viewport.classList.add(style.viewport);
        this._viewportContainer = div({ className: style.viewportContainer }, viewport);
        this.render();
    }

    private render() {
        this._projectView = new ProjectView({ className: style.sidebarItem });
        this._propertyView = new PropertyView({ className: style.sidebarItem });
        this._sidebarEl = div(
            {
                className: style.sidebar,
                style: `width: ${this._sidebarWidth}px;`,
            },
            this._projectView,
            div({
                className: style.sidebarItemResizer,
                onpointerdown: (e: PointerEvent) => this._startSidebarItemResize(e),
            }),
            this._propertyView,
            div({
                className: style.sidebarResizer,
                onpointerdown: (e: PointerEvent) => this._startSidebarResize(e),
            }),
        );
        this.applySidebarSplit();
        this._contentEl = div({ className: style.content }, this._sidebarEl, this._viewportContainer);
        this.append(
            div(
                { className: style.root },
                new RibbonUI(this.app, this.ribbonContent),
                this._contentEl,
                new Statusbar(style.statusbar),
            ),
        );
        this.app.mainWindow?.appendChild(this);
    }

    private trackPointerDrag(onMove: (ev: PointerEvent, stop: () => void) => void, onEnd?: () => void) {
        const onUp = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            onEnd?.();
        };
        const move = (ev: PointerEvent) => onMove(ev, onUp);
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    }

    private applySidebarSplit() {
        if (!this._projectView || !this._propertyView) return;
        this._projectView.style.flexGrow = `${this._sidebarSplit}`;
        this._propertyView.style.flexGrow = `${1 - this._sidebarSplit}`;
    }

    /**
     * Both panes keep their share of the sidebar's height as a ratio rather than a pixel
     * height, so the split survives a window resize instead of leaving one pane clamped.
     */
    private _startSidebarItemResize(e: PointerEvent) {
        e.preventDefault();
        const project = this._projectView;
        const property = this._propertyView;
        if (!project || !property) return;

        const top = project.getBoundingClientRect().top;
        const total = project.getBoundingClientRect().height + property.getBoundingClientRect().height;
        if (total <= 0) return;

        const minRatio = Math.min(0.5, 60 / total);
        if (this.app.mainWindow) this.app.mainWindow.style.cursor = "ns-resize";
        this.trackPointerDrag(
            (ev) => {
                const ratio = (ev.clientY - top) / total;
                this._sidebarSplit = Math.min(1 - minRatio, Math.max(minRatio, ratio));
                this.applySidebarSplit();
            },
            () => {
                if (this.app.mainWindow) this.app.mainWindow.style.cursor = "";
            },
        );
    }

    private _startSidebarResize(e: PointerEvent) {
        e.preventDefault();
        this._isResizingSidebar = true;
        if (this.app.mainWindow) this.app.mainWindow.style.cursor = "ew-resize";
        this.trackPointerDrag(
            (ev) => {
                if (!this._isResizingSidebar) return;
                if (!this._sidebarEl) return;
                const sidebarRect = this._sidebarEl.getBoundingClientRect();
                let newWidth = ev.clientX - sidebarRect.left;
                const minWidth = 75;
                const maxWidth = Math.floor(window.innerWidth * 0.85);
                newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
                this._sidebarWidth = newWidth;
                this._sidebarEl.style.width = `${newWidth}px`;
            },
            () => {
                this._isResizingSidebar = false;
                if (this.app.mainWindow) this.app.mainWindow.style.cursor = "";
            },
        );
    }

    connectedCallback(): void {
        PubSub.default.sub("editMaterial", this._handleMaterialEdit);
        PubSub.default.sub("editVariables", this._handleVariablesEdit);
        PubSub.default.sub("openCommandContext", this.openContext);
        PubSub.default.sub("closeCommandContext", this.closeContext);
    }

    disconnectedCallback(): void {
        PubSub.default.remove("editMaterial", this._handleMaterialEdit);
        PubSub.default.remove("editVariables", this._handleVariablesEdit);
        PubSub.default.remove("openCommandContext", this.openContext);
        PubSub.default.remove("closeCommandContext", this.closeContext);
    }

    private readonly openContext = (command: ICommand) => {
        if (this.commandContext) {
            this.closeContext();
        }
        this.commandContext = new CommandContext(command);
        this._commandContextContainer.append(this.commandContext);
        this._viewportContainer.append(this._commandContextContainer);
    };

    private readonly closeContext = () => {
        this.commandContext?.remove();
        this.commandContext?.dispose();
        this.commandContext = undefined;
        this._commandContextContainer.innerHTML = "";
    };

    private readonly _handleMaterialEdit = (
        document: IDocument,
        editingMaterial: Material,
        callback: (material: Material) => void,
    ) => {
        const context = new MaterialDataContent(document, callback, editingMaterial);
        this._viewportContainer.append(new MaterialEditor(context));
    };

    private readonly _handleVariablesEdit = (document: IDocument, onApplied: () => void) => {
        showVariablesPanel(document, onApplied);
    };
}

customElements.define("chili-editor", Editor);
