import { PluginSettingTab, Setting, type App } from "obsidian";
import type { DashboardController } from "../controller";
import { translator } from "../i18n";

interface SettingDefinitionItem {
  type: "group";
  heading: string;
  items: Array<{
    name: string;
    desc?: string;
    searchable?: boolean;
    render?: (setting: Setting) => void;
    control?:
      | { type: "toggle"; key: string; defaultValue: boolean }
      | { type: "text"; key: string; defaultValue: string };
  }>;
}

export class ConstellationSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly controller: DashboardController
  ) {
    super(app, controller as never);
  }

  // Obsidian 1.13+ discovers this method; older supported versions use display().
  getSettingDefinitions(): SettingDefinitionItem[] {
    const snapshot = this.controller.snapshot();
    const t = translator(snapshot.settings.locale);
    return [
      {
        type: "group",
        heading: t("settings"),
        items: [
          {
            name: t("overview"),
            desc: t("subtitle"),
            render: (setting) => {
              setting.addButton((button) => button.setButtonText(t("overview")).setCta().onClick(() => void this.controller.activateView()));
            }
          },
          {
            name: t("automaticSync"),
            control: { type: "toggle", key: "autoSync", defaultValue: true }
          },
          {
            name: t("paused"),
            control: { type: "toggle", key: "paused", defaultValue: false }
          },
          {
            name: t("deviceName"),
            control: { type: "text", key: "deviceName", defaultValue: "device" }
          },
          {
            name: t("privateNotEncrypted"),
            searchable: false
          }
        ]
      }
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.controller.snapshot().settings;
    if (key === "autoSync") return settings.autoSync;
    if (key === "paused") return settings.paused;
    if (key === "deviceName") return settings.deviceName;
    return undefined;
  }

  setControlValue(key: string, value: unknown): Promise<void> | void {
    if (key === "autoSync" && typeof value === "boolean") return this.controller.updatePreference("autoSync", value);
    if (key === "paused" && typeof value === "boolean") return this.controller.updatePreference("paused", value);
    // Typing through an empty field must not reject: the setter rejects a blank
    // name, and these callbacks fire on every keystroke.
    if (key === "deviceName" && typeof value === "string" && value.trim().length > 0) {
      return this.controller.updatePreference("deviceName", value);
    }
  }

  override display(): void {
    const { containerEl } = this;
    const snapshot = this.controller.snapshot();
    const t = translator(snapshot.settings.locale);
    containerEl.empty();
    new Setting(containerEl).setName(t("settings")).setHeading();

    new Setting(containerEl)
      .setName(t("overview"))
      .setDesc(t("subtitle"))
      .addButton((button) => button.setButtonText(t("overview")).setCta().onClick(() => void this.controller.activateView()));

    new Setting(containerEl)
      .setName(t("automaticSync"))
      .addToggle((toggle) => toggle.setValue(snapshot.settings.autoSync).onChange((value) => this.controller.updatePreference("autoSync", value)));

    new Setting(containerEl)
      .setName(t("paused"))
      .addToggle((toggle) => toggle.setValue(snapshot.settings.paused).onChange((value) => this.controller.updatePreference("paused", value)));

    new Setting(containerEl)
      .setName(t("deviceName"))
      .addText((text) =>
        text.setValue(snapshot.settings.deviceName).onChange((value) => {
          if (value.trim().length > 0) void this.controller.updatePreference("deviceName", value);
        })
      );

    containerEl.createDiv({ cls: "setting-item-description", text: t("privateNotEncrypted") });
  }
}
